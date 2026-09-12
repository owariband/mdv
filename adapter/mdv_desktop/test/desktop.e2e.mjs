import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMdv, openMdv } from '@owariband/mdv'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const adapter = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mdv-desktop-e2e-'))
const screenshotDirectory = join(adapter, 'out/screenshots')
const workspaceDirectory = join(temporaryDirectory, 'Hypnos Notes')
const designDirectory = join(workspaceDirectory, 'Design')
const file = join(designDirectory, 'milkdown-demo.mdv')
let application
let page
const diagnostics = []

function recordDiagnostic(source, value) {
  diagnostics.push(`[${source}] ${String(value).trim()}`)
}

async function launchElectron(options) {
  try {
    return await electron.launch(options)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Process failed to launch')) throw error
    await new Promise((resolve) => setTimeout(resolve, 750))
    return electron.launch(options)
  }
}

async function traceWorkspaceDocumentSwitch(page, targetName, expectedHeading) {
  return page.getByRole('treeitem', { name: targetName, exact: true }).evaluate(
    async (target, heading) => {
      const shell = document.querySelector('.app-shell')
      const initialEditor = document.querySelector('.editor-pane.document .ProseMirror')
      const openButton = document.querySelector('.window-actions button[aria-label="Open a document"]')
      if (!(shell instanceof HTMLElement)
        || !(initialEditor instanceof HTMLElement)
        || !(openButton instanceof HTMLButtonElement)) {
        throw new Error('Expected an open Document editor before switching workspace files')
      }

      const requiredSurfaces = [
        ['writing-room', '.writing-room'],
        ['editor-stage', '.editor-stage'],
        ['editor-stack', '.editor-stack'],
        ['editor-pane', '.editor-pane.document'],
        ['editor-layer', '.editor-pane.document > .editor-layer'],
        ['milkdown-root', '.editor-pane.document .milkdown-root'],
        ['ProseMirror', '.editor-pane.document .ProseMirror'],
      ]
      const surfacePalette = new Map(requiredSurfaces.map(([label, selector]) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) {
          throw new Error(`Expected ${label} before switching workspace files`)
        }
        const style = getComputedStyle(element)
        return [label, { color: style.color, backgroundColor: style.backgroundColor }]
      }))
      const loadingSelector = [
        '.editor-stage .loading',
        '.editor-stage .is-loading',
        '.editor-stage .loading-overlay',
        '.editor-stage .skeleton',
        '.editor-stage [class*="loading"]',
        '.editor-stage [class*="skeleton"]',
        '.editor-stage [class*="overlay"]',
        '.editor-stage [role="progressbar"]',
        '.editor-stage [aria-busy="true"]',
      ].join(', ')
      const openButtonBefore = {
        disabled: openButton.disabled,
        opacity: getComputedStyle(openButton).opacity,
      }
      const violations = new Set()
      let frameSamples = 0
      let mutationSamples = 0

      const sample = (source) => {
        if (source === 'frame') frameSamples += 1
        if (source === 'mutation') mutationSamples += 1

        for (const [label, selector] of requiredSurfaces) {
          const element = document.querySelector(selector)
          if (!(element instanceof HTMLElement)) {
            violations.add(`${source}: missing ${label}`)
            continue
          }
          const style = getComputedStyle(element)
          if (style.opacity !== '1') violations.add(`${source}: ${label} opacity=${style.opacity}`)
          if (style.filter !== 'none') violations.add(`${source}: ${label} filter=${style.filter}`)
          if (style.visibility !== 'visible') {
            violations.add(`${source}: ${label} visibility=${style.visibility}`)
          }
          if (style.animationName !== 'none') {
            violations.add(`${source}: ${label} animation=${style.animationName}`)
          }
          const palette = surfacePalette.get(label)
          if (palette && style.color !== palette.color) {
            violations.add(`${source}: ${label} color=${style.color}`)
          }
          if (palette && style.backgroundColor !== palette.backgroundColor) {
            violations.add(`${source}: ${label} background=${style.backgroundColor}`)
          }
        }

        const workspaceTree = document.querySelector('.workspace-tree')
        if (!(workspaceTree instanceof HTMLElement)) {
          violations.add(`${source}: missing workspace-tree`)
        } else {
          if (workspaceTree.classList.contains('is-busy')) {
            violations.add(`${source}: workspace-tree gained is-busy`)
          }
          if (workspaceTree.getAttribute('aria-busy') === 'true') {
            violations.add(`${source}: workspace-tree aria-busy=true`)
          }
        }

        const currentOpenButton = document.querySelector(
          '.window-actions button[aria-label="Open a document"]',
        )
        if (!(currentOpenButton instanceof HTMLButtonElement)) {
          violations.add(`${source}: missing Open button`)
        } else {
          if (currentOpenButton.disabled !== openButtonBefore.disabled) {
            violations.add(`${source}: Open button disabled changed`)
          }
          const openOpacity = getComputedStyle(currentOpenButton).opacity
          if (openOpacity !== openButtonBefore.opacity) {
            violations.add(`${source}: Open button opacity=${openOpacity}`)
          }
        }
        if (document.querySelector(loadingSelector)) {
          violations.add(`${source}: loading, skeleton, or overlay appeared`)
        }

        const visibleNonemptyEditors = [...document.querySelectorAll('.editor-stage .ProseMirror')]
          .filter((editor) => {
            if (!(editor instanceof HTMLElement) || !editor.textContent?.trim()) return false
            const style = getComputedStyle(editor)
            const rect = editor.getBoundingClientRect()
            return style.display !== 'none'
              && style.visibility === 'visible'
              && style.opacity === '1'
              && rect.width > 0
              && rect.height > 0
          })
        if (visibleNonemptyEditors.length === 0) {
          violations.add(`${source}: no visible nonempty editor`)
        }
      }

      sample('before')
      const observer = new MutationObserver(() => sample('mutation'))
      observer.observe(shell, {
        attributes: true,
        attributeFilter: ['aria-busy', 'class', 'disabled', 'hidden', 'style'],
        childList: true,
        subtree: true,
      })
      target.click()

      const deadline = performance.now() + 10_000
      let settledFrames = 0
      while (performance.now() < deadline && settledFrames < 2) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        sample('frame')
        const currentHeading = document.querySelector(
          '.editor-pane.document .ProseMirror h1',
        )?.textContent
        settledFrames = currentHeading === heading ? settledFrames + 1 : 0
      }
      observer.disconnect()
      sample('after')
      const finalOpenButton = document.querySelector(
        '.window-actions button[aria-label="Open a document"]',
      )
      const openButtonAfter = finalOpenButton instanceof HTMLButtonElement
        ? {
            disabled: finalOpenButton.disabled,
            opacity: getComputedStyle(finalOpenButton).opacity,
          }
        : null

      return {
        editorReused: initialEditor === document.querySelector('.editor-pane.document .ProseMirror'),
        expectedHeadingReached: settledFrames === 2,
        frameSamples,
        mutationSamples,
        openButtonBefore,
        openButtonAfter,
        violations: [...violations],
      }
    },
    expectedHeading,
  )
}

try {
  await mkdir(designDirectory, { recursive: true })
  await mkdir(join(workspaceDirectory, 'assets'))
  await writeFile(join(workspaceDirectory, 'README.md'), '# Workspace context\n\nPlain Markdown starts here.\n')
  await writeFile(join(workspaceDirectory, 'SECOND.md'), '# Second document   \n\n\n\nSwitch without rebuilding Milkdown.\n')
  await Promise.all(Array.from({ length: 26 }, (_, index) => (
    writeFile(
      join(workspaceDirectory, `${String(index + 1).padStart(2, '0')}-mdv-note.mdv`),
      new Uint8Array(),
    )
  )))
  const referenceMarkdown = '# Product reference\n\nStable source context for the working document.\n\n## Release constraints\n\n- Preserve both worktrees.\n- Confirm every Reference save.\n- Keep immutable history intact.\n'
  const documentMarkdown = '# milkdownv editor\n\nWrite against trusted context without hiding either side.\n\n## Split worktree\n\nReference stays visible on the left while the Document remains editable on the right.\n'
  let document = await createMdv(file)
  const referenceVersions = []
  const documentVersions = []

  const commitReference = async (summary, revision) => {
    document = await document.saveReference({
      markdown: `${referenceMarkdown}\nReference revision ${revision}.\n`,
      expectedGeneration: document.manifest.generation,
    })
    const committed = await document.commitReference({
      actor: { type: 'human', name: 'Editor' },
      summary,
      expectedGeneration: document.manifest.generation,
    })
    assert.equal(committed.created, true)
    document = committed.document
    referenceVersions.push(committed.version)
  }
  const commitDocument = async (summary, revision, referenceVersion) => {
    document = await document.saveDocument({
      markdown: `${documentMarkdown}\nDocument revision ${revision}.\n`,
      expectedGeneration: document.manifest.generation,
    })
    const committed = await document.commitDocument({
      actor: { type: 'agent', name: 'MDV Agent' },
      summary,
      referenceVersion,
      expectedGeneration: document.manifest.generation,
    })
    assert.equal(committed.created, true)
    document = committed.document
    documentVersions.push(committed.version)
  }

  await commitReference('Initial constraints', 1)
  await commitReference('Clarify save boundary', 2)
  await commitReference('Add release checks', 3)
  document = await document.checkoutReference({
    version: referenceVersions[0],
    expectedGeneration: document.manifest.generation,
  })
  await commitReference('Explore compact branch', 4)
  await commitReference('Refine editor contract', 5)
  await commitReference('Approve desktop direction', 6)

  await commitDocument('First editor draft', 1, referenceVersions[0])
  await commitDocument('Split Ref and Doc', 2, referenceVersions[1])
  await commitDocument('Add Worktree shell', 3, referenceVersions[2])
  document = await document.checkoutDocument({
    version: documentVersions[0],
    expectedGeneration: document.manifest.generation,
  })
  await commitDocument('Try focused layout', 4, referenceVersions[3])
  await commitDocument('Reduce interface chrome', 5, null)
  await commitDocument('Tune editor density', 6, referenceVersions[4])
  await commitDocument('Expose versions and Bind', 7, referenceVersions[4])
  await mkdir(screenshotDirectory, { recursive: true })

  application = await launchElectron({
    executablePath: electronExecutable,
    args: [adapter],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MDV_DESKTOP_E2E_DIALOG_PLAN: JSON.stringify({
        openFile: file,
        openDirectory: workspaceDirectory,
        referenceResponses: [0, 1],
        workspaceOpenDelayMs: 120,
        contextActions: [
          'copy-path',
          'new-folder',
          'new-file',
          'rename',
          'duplicate',
          'open',
        ],
      }),
    },
    timeout: 30_000,
  })
  application.process().stdout?.on('data', (chunk) => recordDiagnostic('main stdout', chunk))
  application.process().stderr?.on('data', (chunk) => recordDiagnostic('main stderr', chunk))
  page = await application.firstWindow()
  page.on('console', (message) => recordDiagnostic(`renderer ${message.type()}`, message.text()))
  page.on('pageerror', (error) => recordDiagnostic('renderer error', error.stack ?? error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.localStorage.removeItem('mdv.desktop.sidebar-width')
    window.localStorage.removeItem('mdv.desktop.worktree-height')
  })
  await page.reload()
  await page.waitForSelector('.empty-document')
  assert.deepEqual(await application.evaluate(({ app, BrowserWindow }) => ({
    appName: app.getName(),
    windowTitle: BrowserWindow.getAllWindows()[0]?.getTitle(),
  })), {
    appName: 'milkdownv',
    windowTitle: 'milkdownv',
  })
  assert.equal(await page.locator('.sidebar-mark').count(), 0)
  assert.equal(await page.locator('.sidebar-empty').count(), 0)
  assert.equal(await page.locator('.sidebar-header-action').count(), 0)
  assert.equal(await page.locator('.statusbar').count(), 0)
  assert.equal((await page.locator('.sidebar-explorer').innerText()).trim(), '')
  await page.screenshot({ path: join(screenshotDirectory, 'huashu-compact-empty.png') })

  const sandbox = await page.evaluate(() => ({
    process: typeof window.process,
    require: typeof window.require,
  }))
  assert.deepEqual(sandbox, { process: 'undefined', require: 'undefined' })

  const sidebar = page.locator('.tree-rail')
  const resizer = page.getByRole('separator', { name: 'Resize file sidebar' })
  const initialSidebarWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  const resizerBox = await resizer.boundingBox()
  assert.ok(resizerBox, 'The sidebar resize handle must be visible')
  assert.ok(resizerBox.width >= 10, `Expected a >=10px resize target, got ${resizerBox.width}px`)
  const pointerY = resizerBox.y + resizerBox.height / 2
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, pointerY)
  await page.mouse.down()
  await page.mouse.move(initialSidebarWidth + 60, pointerY, { steps: 6 })
  await page.mouse.up()

  const resizedSidebarWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  assert.ok(
    Math.abs(resizedSidebarWidth - initialSidebarWidth - 60) <= 2,
    `Expected the sidebar to grow by about 60px, grew by ${resizedSidebarWidth - initialSidebarWidth}px`,
  )
  const persistedSidebarWidth = await page.evaluate(() => window.localStorage.getItem('mdv.desktop.sidebar-width'))
  assert.ok(persistedSidebarWidth !== null)
  assert.ok(Math.abs(Number(persistedSidebarWidth) - resizedSidebarWidth) <= 1)

  await resizer.dblclick()
  await page.waitForFunction(() => (
    Math.abs((document.querySelector('.tree-rail')?.getBoundingClientRect().width ?? 0) - 286) <= 1
  ))
  assert.equal(await page.evaluate(() => window.localStorage.getItem('mdv.desktop.sidebar-width')), '286')

  const workspaceShape = await page.evaluate(async () => window.mdvDesktop.selectWorkspace())
  assert.equal(workspaceShape.ok, true)
  assert.equal(JSON.stringify(workspaceShape).includes(temporaryDirectory), false)
  assert.deepEqual(Object.keys(workspaceShape.value).sort(), [
    'incomplete',
    'revision',
    'root',
    'workspaceId',
  ])
  assert.match(workspaceShape.value.root.id, /^n_[0-9a-f]{32}$/)
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
    'Hypnos Notes — milkdownv',
  )

  const markdownNode = workspaceShape.value.root.children.find((node) => node.name === 'README.md')
  assert.ok(markdownNode)
  const markdownShape = await page.evaluate(async ({ workspaceId, nodeId }) => (
    window.mdvDesktop.openWorkspaceDocument({ workspaceId, nodeId })
  ), {
    workspaceId: workspaceShape.value.workspaceId,
    nodeId: markdownNode.id,
  })
  assert.equal(markdownShape.ok, true)
  assert.equal(markdownShape.value.kind, 'markdown')
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
    'README.md — milkdownv',
  )
  assert.equal(JSON.stringify(markdownShape).includes(temporaryDirectory), false)
  assert.deepEqual(Object.keys(markdownShape.value).sort(), [
    'displayName',
    'kind',
    'markdown',
    'sessionId',
  ])

  const openedShape = await page.evaluate(async () => window.mdvDesktop.openDocument())
  assert.equal(openedShape.ok, true)
  assert.equal(JSON.stringify(openedShape).includes(temporaryDirectory), false)
  assert.deepEqual(Object.keys(openedShape.value).sort(), [
    'displayName',
    'document',
    'documentId',
    'generation',
    'kind',
    'markdownProfile',
    'reference',
    'referenceRelation',
    'sessionId',
    'versions',
  ])
  assert.deepEqual(Object.keys(openedShape.value.document).sort(), [
    'head',
    'markdown',
    'workingCopyDirty',
  ])
  assert.equal(openedShape.value.versions.reference.length, 6)
  assert.equal(openedShape.value.versions.document.length, 7)
  assert.equal(openedShape.value.referenceRelation.kind, 'drifted')
  assert.equal(openedShape.value.referenceRelation.boundReference, referenceVersions[4])
  assert.equal(openedShape.value.referenceRelation.currentReference, referenceVersions[5])
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
    'milkdown-demo.mdv — milkdownv',
  )

  await page.getByRole('button', { name: 'Open a folder' }).click()
  await page.waitForSelector('.workspace-tree')
  assert.equal(await page.getByRole('treeitem', { name: 'Hypnos Notes' }).count(), 0)
  assert.equal(await page.getByRole('treeitem', { name: 'assets' }).count(), 1)
  assert.ok(await page.locator('.workspace-row.file.mdv').count() > await page.locator('.workspace-row.file.markdown').count())
  assert.equal(await page.locator('.sidebar-explorer').evaluate((element) => (
    element.scrollHeight > element.clientHeight
  )), true)

  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.document .ProseMirror h1')?.textContent === 'Workspace context'
  ))
  assert.equal(await page.getByRole('button', { name: 'Worktree' }).count(), 0)
  assert.equal(await page.locator('.active-document-panel').count(), 0)
  assert.equal(await page.locator('.editor-pane').count(), 1)
  assert.equal(await page.locator('.editor-layer').count(), 1)
  assert.equal(await page.locator('.editor-layer.reference').count(), 0)
  assert.equal(await page.locator('.statusbar').count(), 0)

  const plainEditor = page.locator('.editor-pane.document .ProseMirror')
  assert.equal(await plainEditor.getAttribute('contenteditable'), 'true')
  await plainEditor.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' Edited as a plain file.')
  await page.getByRole('button', { name: 'Save Markdown file' }).click()
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Markdown file saved'))
  assert.match(await readFile(join(workspaceDirectory, 'README.md'), 'utf8'), /Edited as a plain file\./)
  await page.screenshot({ path: join(screenshotDirectory, 'plain-markdown.png') })

  const markdownSwitchTrace = await traceWorkspaceDocumentSwitch(
    page,
    'SECOND.md',
    'Second document',
  )
  assert.equal(markdownSwitchTrace.expectedHeadingReached, true)
  assert.ok(markdownSwitchTrace.frameSamples >= 2)
  assert.ok(markdownSwitchTrace.mutationSamples >= 1)
  assert.deepEqual(markdownSwitchTrace.openButtonAfter, markdownSwitchTrace.openButtonBefore)
  assert.deepEqual(markdownSwitchTrace.violations, [])
  assert.equal(markdownSwitchTrace.editorReused, true)
  assert.equal(await page.locator('.workspace-tree').getAttribute('aria-busy'), 'false')
  await page.waitForSelector('.normalization-action')
  assert.equal(await page.getByRole('button', { name: 'Save Markdown file' }).isDisabled(), true)
  await plainEditor.focus()
  await page.keyboard.press('Meta+z')
  assert.equal(await plainEditor.locator('h1').innerText(), 'Second document')
  assert.equal(await page.getByRole('button', { name: 'Save Markdown file' }).isDisabled(), true)

  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.document .ProseMirror h1')?.textContent === 'Workspace context'
  ))
  assert.match(await plainEditor.innerText(), /Edited as a plain file\./)

  await page.getByRole('treeitem', { name: 'Design' }).click()
  assert.equal(await page.getByRole('treeitem', { name: 'Design' }).getAttribute('aria-expanded'), 'true')
  const workspaceMenuToggle = page.getByRole('button', { name: 'Workspace menu', exact: true })
  await workspaceMenuToggle.click()
  await page.getByRole('button', { name: 'Refresh folder' }).click()
  assert.equal(await page.getByRole('treeitem', { name: 'Design' }).getAttribute('aria-expanded'), 'true')
  const mdvSwitchTrace = await traceWorkspaceDocumentSwitch(
    page,
    'milkdown-demo.mdv',
    'milkdownv editor',
  )
  assert.equal(mdvSwitchTrace.expectedHeadingReached, true)
  assert.ok(mdvSwitchTrace.frameSamples >= 2)
  assert.ok(mdvSwitchTrace.mutationSamples >= 1)
  assert.deepEqual(mdvSwitchTrace.openButtonAfter, mdvSwitchTrace.openButtonBefore)
  assert.deepEqual(mdvSwitchTrace.violations, [])
  assert.equal(mdvSwitchTrace.editorReused, true)
  await Promise.race([
    page.waitForSelector('.mdv-dual-stack'),
    page.waitForSelector('.statusbar.danger').then(async () => {
      throw new Error(`Open failed: ${await page.locator('.statusbar').innerText()}`)
    }),
  ])
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.reference .ProseMirror h1')?.textContent === 'Product reference'
    && document.querySelector('.editor-pane.document .ProseMirror h1')?.textContent === 'milkdownv editor'
  ))
  assert.equal(await page.getByRole('button', { name: 'Worktree' }).count(), 1)
  assert.equal(await page.locator('.editor-layer.reference').count(), 1)
  assert.equal(await page.locator('.editor-layer.document').count(), 1)
  assert.equal(await page.locator('.editor-pane-header').count(), 0)
  assert.equal(await page.locator('.editor-pane-label').count(), 2)
  assert.equal(await page.locator('.current-file').count(), 0)
  assert.equal((await page.locator('.editor-pane.reference .editor-pane-label').innerText()).trim(), 'REF')
  assert.equal((await page.locator('.editor-pane.document .editor-pane-label').innerText()).trim(), 'DOC')
  assert.doesNotMatch(await page.locator('.editor-stage').innerText(), /READ ONLY|UNCOMMITTED/)
  assert.equal((await page.locator('.tree-column.reference .tree-label small').innerText()).trim(), '6')
  assert.equal((await page.locator('.tree-column.document .tree-label small').innerText()).trim(), '7')
  assert.equal(await page.locator('.version-node.reference').count(), 6)
  assert.equal(await page.locator('.version-node.document').count(), 7)
  assert.equal(await page.locator('.version-edge.bind').count(), 6)
  assert.match(await page.locator('.bind-summary').innerText(), /^BIND\s+DOC .+ → REF .+ · REF HEAD .+$/)

  const editorLayout = await page.evaluate(() => {
    const stage = document.querySelector('.editor-stage')
    const titlebar = document.querySelector('.titlebar')
    const writingRoom = document.querySelector('.writing-room')
    const referencePane = document.querySelector('.editor-pane.reference')
    const documentPane = document.querySelector('.editor-pane.document')
    if (!(stage instanceof HTMLElement)
      || !(titlebar instanceof HTMLElement)
      || !(writingRoom instanceof HTMLElement)
      || !(referencePane instanceof HTMLElement)
      || !(documentPane instanceof HTMLElement)) {
      throw new Error('Expected Reference and Document panes inside the editor stage')
    }
    const stageRect = stage.getBoundingClientRect()
    const referenceRect = referencePane.getBoundingClientRect()
    const documentRect = documentPane.getBoundingClientRect()
    return {
      stage: {
        top: stageRect.top,
        right: stageRect.right,
        bottom: stageRect.bottom,
        left: stageRect.left,
      },
      writingRoom: {
        bottom: writingRoom.getBoundingClientRect().bottom,
      },
      titlebar: {
        height: titlebar.getBoundingClientRect().height,
      },
      reference: {
        top: referenceRect.top,
        right: referenceRect.right,
        bottom: referenceRect.bottom,
        left: referenceRect.left,
        width: referenceRect.width,
      },
      document: {
        top: documentRect.top,
        right: documentRect.right,
        bottom: documentRect.bottom,
        left: documentRect.left,
        width: documentRect.width,
      },
    }
  })
  assert.ok(editorLayout.reference.width >= 260)
  assert.ok(editorLayout.document.width >= 260)
  assert.ok(Math.abs(editorLayout.reference.left - editorLayout.stage.left) <= 1)
  assert.ok(Math.abs(editorLayout.reference.right - editorLayout.document.left) <= 1)
  assert.ok(Math.abs(editorLayout.document.right - editorLayout.stage.right) <= 1)
  assert.ok(Math.abs(editorLayout.reference.top - editorLayout.stage.top) <= 1)
  assert.ok(Math.abs(editorLayout.document.top - editorLayout.stage.top) <= 1)
  assert.ok(Math.abs(editorLayout.reference.bottom - editorLayout.stage.bottom) <= 1)
  assert.ok(Math.abs(editorLayout.document.bottom - editorLayout.stage.bottom) <= 1)
  assert.ok(Math.abs(editorLayout.stage.bottom - editorLayout.writingRoom.bottom) <= 1)
  assert.equal(editorLayout.titlebar.height, 44)

  const referenceEditor = page.locator('.editor-pane.reference .ProseMirror')
  const documentEditor = page.locator('.editor-pane.document .ProseMirror')
  assert.equal(await referenceEditor.isVisible(), true)
  assert.equal(await documentEditor.isVisible(), true)
  assert.equal(await referenceEditor.getAttribute('contenteditable'), 'true')
  assert.equal(await documentEditor.getAttribute('contenteditable'), 'true')
  assert.equal(await page.getByRole('tab', { name: /Reference/ }).getAttribute('aria-selected'), 'false')
  assert.equal(await page.getByRole('tab', { name: /Document/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Save Document working copy' }).count(), 1)

  const theme = await page.evaluate(() => {
    const heading = document.querySelector('.editor-pane.document .ProseMirror h1')
    const editor = document.querySelector('.editor-pane.document .ProseMirror')
    const milkdown = document.querySelector('.editor-pane.document .milkdown')
    assertElement(heading)
    assertElement(editor)
    assertElement(milkdown)
    return {
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim(),
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      family: getComputedStyle(heading).fontFamily,
      marker: getComputedStyle(heading, '::before').content,
      editorFontSize: getComputedStyle(editor).fontSize,
      crepeBaseFontSize: getComputedStyle(milkdown).getPropertyValue('--crepe-base-font-size').trim(),
    }

    function assertElement(value) {
      if (!(value instanceof HTMLElement)) throw new Error('Expected an active Hypnos heading')
    }
  })
  assert.equal(theme.canvas, '#1a1b1c')
  assert.equal(theme.rootFontSize, '13px')
  assert.match(theme.family, /SFMono-Regular|Menlo|Monaco/)
  assert.equal(theme.marker, '"# "')
  assert.equal(theme.editorFontSize, '11px')
  assert.equal(theme.crepeBaseFontSize, '11px')

  const sourceModeButton = page.locator(
    '.editor-pane.document .view-switch button[aria-label="Markdown source"]',
  )
  await sourceModeButton.click()
  const sourceEditor = page.locator('.editor-pane.document textarea.source-editor')
  await sourceEditor.waitFor()
  assert.equal(await sourceEditor.evaluate((element) => getComputedStyle(element).fontSize), '11px')
  await page.locator(
    '.editor-pane.document .view-switch button[aria-label="Visual editor"]',
  ).click()
  await sourceEditor.waitFor({ state: 'detached' })

  assert.equal(
    await page.getByRole('treeitem', { name: 'milkdown-demo.mdv' })
      .evaluate((element) => getComputedStyle(element).boxShadow),
    'none',
  )

  const normalization = page.locator('.normalization-button')
  if (await normalization.count() > 0) {
    assert.equal(await normalization.locator('svg, small').count(), 0)
    assert.equal(
      (await normalization.innerText()).split('\n').filter(Boolean).length,
      1,
    )
  }

  await documentEditor.focus()
  await page.mouse.move(1200, 40)
  await page.screenshot({ path: join(screenshotDirectory, 'huashu-compact-ref-doc.png') })

  const worktreePanel = page.locator('.active-document-panel')
  const worktreeResizer = page.getByRole('separator', { name: 'Resize Worktree' })
  const initialWorktreeHeight = await worktreePanel.evaluate((element) => element.getBoundingClientRect().height)
  const initialExplorerHeight = await page.locator('.sidebar-explorer').evaluate((element) => (
    element.getBoundingClientRect().height
  ))
  const worktreeResizerBox = await worktreeResizer.boundingBox()
  assert.ok(worktreeResizerBox, 'The Worktree resize handle must be visible')
  assert.ok(worktreeResizerBox.height >= 10, `Expected a >=10px Worktree resize target, got ${worktreeResizerBox.height}px`)
  const worktreePointerX = worktreeResizerBox.x + worktreeResizerBox.width / 2
  const worktreePointerY = worktreeResizerBox.y + worktreeResizerBox.height / 2
  await page.mouse.move(worktreePointerX, worktreePointerY)
  await page.mouse.down()
  await page.mouse.move(worktreePointerX, worktreePointerY - 280, { steps: 8 })
  await page.mouse.up()

  const expandedWorktreeHeight = await worktreePanel.evaluate((element) => element.getBoundingClientRect().height)
  const resizedExplorerHeight = await page.locator('.sidebar-explorer').evaluate((element) => (
    element.getBoundingClientRect().height
  ))
  assert.ok(
    expandedWorktreeHeight >= initialWorktreeHeight + 270,
    `Expected Worktree to grow by at least 270px, grew by ${expandedWorktreeHeight - initialWorktreeHeight}px`,
  )
  assert.ok(Math.abs(
    initialExplorerHeight - resizedExplorerHeight - (expandedWorktreeHeight - initialWorktreeHeight),
  ) <= 2)
  const persistedWorktreeHeight = await page.evaluate(() => (
    window.localStorage.getItem('mdv.desktop.worktree-height')
  ))
  assert.ok(persistedWorktreeHeight !== null)
  assert.ok(Math.abs(Number(persistedWorktreeHeight) - expandedWorktreeHeight) <= 1)

  await page.locator('.sidebar-explorer').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.screenshot({ path: join(screenshotDirectory, 'huashu-worktree-versions-bind-expanded.png') })
  await worktreePanel.screenshot({ path: join(screenshotDirectory, 'huashu-worktree-versions-bind-detail.png') })

  const staleWorkspace = await page.evaluate(async (workspaceId) => (
    window.mdvDesktop.refreshWorkspace({ workspaceId })
  ), workspaceShape.value.workspaceId)
  assert.equal(staleWorkspace.ok, false)
  assert.equal(staleWorkspace.error.code, 'STALE_WORKSPACE')
  assert.equal(JSON.stringify(staleWorkspace).includes(temporaryDirectory), false)

  const worktreeToggle = page.getByRole('button', { name: 'Worktree' })
  assert.equal(await worktreeToggle.getAttribute('aria-expanded'), 'true')
  await worktreeToggle.click()
  assert.equal(await worktreeToggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('.worktree-grid').isVisible(), false)
  assert.equal(await worktreePanel.evaluate((element) => element.getBoundingClientRect().height), 42)
  await worktreeToggle.click()
  assert.equal(await worktreeToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(await page.locator('.worktree-grid').isVisible(), true)
  assert.ok(Math.abs(
    await worktreePanel.evaluate((element) => element.getBoundingClientRect().height) - expandedWorktreeHeight,
  ) <= 1)

  const workspaceName = page.locator('.sidebar-workspace-button span')
  assert.equal(await workspaceName.innerText(), 'Hypnos Notes')
  const workspaceNameBeforeHover = await workspaceName.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    width: element.getBoundingClientRect().width,
  }))
  await page.locator('.tree-rail').hover({ position: { x: 120, y: 180 } })
  const workspaceNameAfterHover = await workspaceName.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    width: element.getBoundingClientRect().width,
  }))
  assert.equal(workspaceNameBeforeHover.opacity, '1')
  assert.equal(workspaceNameAfterHover.opacity, '1')
  assert.ok(Math.abs(workspaceNameAfterHover.width - workspaceNameBeforeHover.width) <= 0.5)

  const drawerLayoutBefore = await page.evaluate(() => {
    const sidebar = document.querySelector('.tree-rail').getBoundingClientRect()
    const writingRoom = document.querySelector('.writing-room').getBoundingClientRect()
    return { sidebarWidth: sidebar.width, writingRoomLeft: writingRoom.left }
  })
  await workspaceMenuToggle.click()
  await page.waitForSelector('.workspace-drawer')
  await page.waitForFunction(() => (
    getComputedStyle(document.querySelector('.workspace-drawer')).opacity === '1'
  ))
  assert.equal(await workspaceMenuToggle.getAttribute('aria-expanded'), 'true')
  const workspaceDrawer = page.locator('.workspace-drawer')
  assert.equal(await workspaceDrawer.getByRole('button', { name: 'Open a folder' }).count(), 1)
  assert.equal(await workspaceDrawer.getByRole('button', { name: 'Refresh folder' }).count(), 1)
  const workspaceDrawerText = await workspaceDrawer.innerText()
  assert.match(workspaceDrawerText, /Current folder\s+Hypnos Notes/)
  assert.doesNotMatch(workspaceDrawerText, /New File|Finder|Recent|Sort/)
  const drawerLayoutOpen = await page.evaluate(() => {
    const sidebar = document.querySelector('.tree-rail').getBoundingClientRect()
    const writingRoom = document.querySelector('.writing-room').getBoundingClientRect()
    return { sidebarWidth: sidebar.width, writingRoomLeft: writingRoom.left }
  })
  assert.deepEqual(drawerLayoutOpen, drawerLayoutBefore)
  await page.screenshot({ path: join(screenshotDirectory, 'workspace-drawer.png') })

  await page.keyboard.press('Escape')
  await page.waitForSelector('.workspace-drawer', { state: 'detached' })
  assert.equal(await workspaceMenuToggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.evaluate(() => (
    document.activeElement === document.querySelector('.sidebar-workspace-button')
  )), true)

  await page.getByRole('button', { name: 'Workspace: Hypnos Notes' }).click()
  await page.waitForSelector('.workspace-drawer')
  await page.mouse.click(900, 260)
  await page.waitForSelector('.workspace-drawer', { state: 'detached' })

  await workspaceMenuToggle.click()
  await page.waitForSelector('.workspace-drawer')
  await workspaceMenuToggle.click()
  await page.waitForSelector('.workspace-drawer', { state: 'detached' })
  assert.equal(await workspaceMenuToggle.getAttribute('aria-expanded'), 'false')

  await referenceEditor.locator('h1').click()
  assert.equal(await page.getByRole('tab', { name: /Reference/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Save Reference working copy' }).count(), 1)
  await referenceEditor.locator('li').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' Reviewed.')
  await page.waitForSelector('.tree-column.reference .tree-state i.dirty')

  const referenceBeforeConfirmation = await (await openMdv(file)).readReferenceText()
  await documentEditor.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' Edited in Milkdown.')
  await page.waitForSelector('.tree-column.document .tree-state i.dirty')
  assert.equal(await page.getByRole('tab', { name: /Document/ }).getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: 'Save Document working copy' }).click()
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Document working copy saved'))
  const statusOverlayLayout = await page.evaluate(() => {
    const stage = document.querySelector('.editor-stage')
    const status = document.querySelector('.statusbar')
    const writingRoom = document.querySelector('.writing-room')
    if (!(stage instanceof HTMLElement)
      || !(status instanceof HTMLElement)
      || !(writingRoom instanceof HTMLElement)) {
      throw new Error('Expected a transient status overlay inside the writing room')
    }
    return {
      stageBottom: stage.getBoundingClientRect().bottom,
      statusBottom: status.getBoundingClientRect().bottom,
      writingRoomBottom: writingRoom.getBoundingClientRect().bottom,
    }
  })
  assert.ok(Math.abs(statusOverlayLayout.stageBottom - statusOverlayLayout.writingRoomBottom) <= 1)
  assert.ok(Math.abs(statusOverlayLayout.statusBottom - statusOverlayLayout.writingRoomBottom) <= 1)
  assert.equal(await page.locator('.tree-column.reference .tree-state i.dirty').count(), 1)
  assert.equal(await (await openMdv(file)).readReferenceText(), referenceBeforeConfirmation)
  assert.match(await (await openMdv(file)).readDocumentText(), /Edited in Milkdown\./)

  await referenceEditor.locator('h1').click()
  await page.getByRole('button', { name: 'Save Reference working copy' }).click()
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Reference was not saved'))
  assert.equal(await (await openMdv(file)).readReferenceText(), referenceBeforeConfirmation)
  assert.equal(await page.locator('.tree-column.reference .tree-state i.dirty').count(), 1)
  assert.equal(await referenceEditor.getAttribute('contenteditable'), 'true')

  await page.getByRole('button', { name: 'Save Reference working copy' }).click()
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Reference working copy saved'))
  assert.equal(await referenceEditor.getAttribute('contenteditable'), 'true')
  assert.equal(await page.locator('.tree-column.reference .tree-state i.dirty').count(), 0)
  assert.equal(await page.getByRole('button', { name: /Lock Reference|Unlock Reference/ }).count(), 0)
  await page.screenshot({ path: join(screenshotDirectory, 'huashu-compact-reference-saved.png') })

  const current = await openMdv(file)
  assert.match(await current.readDocumentText(), /Edited in Milkdown\./)
  assert.match(await current.readReferenceText(), /Reviewed\./)
  assert.deepEqual(
    new Set(current.listVersions({ tree: 'reference' }).map((version) => version.id)),
    new Set(referenceVersions),
  )
  assert.deepEqual(
    new Set(current.listVersions({ tree: 'document' }).map((version) => version.id)),
    new Set(documentVersions),
  )

  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click({ button: 'right' })
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Path copied'))
  assert.equal(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    await realpath(join(workspaceDirectory, 'README.md')),
  )

  const designTreeItem = page.getByRole('treeitem', { name: 'Design', exact: true })
  await designTreeItem.click({ button: 'right' })
  await page.getByRole('dialog', { name: 'New folder' }).waitFor()
  const workspaceNameLayerStyle = await page.locator('.workspace-name-layer').evaluate((element) => ({
    backdropFilter: getComputedStyle(element).backdropFilter,
    backgroundColor: getComputedStyle(element).backgroundColor,
  }))
  assert.equal(workspaceNameLayerStyle.backdropFilter, 'none')
  assert.equal(workspaceNameLayerStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(screenshotDirectory, 'workspace-context-name.png') })
  await page.locator('#workspace-item-name').fill('Context Folder')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('treeitem', { name: 'Context Folder', exact: true }).waitFor()
  assert.equal((await stat(join(designDirectory, 'Context Folder'))).isDirectory(), true)

  await designTreeItem.click({ button: 'right' })
  await page.getByRole('dialog', { name: 'New Markdown file' }).waitFor()
  await page.locator('#workspace-item-name').fill('Context Action')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForFunction(() => (
    document.querySelector('.document-title span')?.textContent === 'Context Action.md'
  ))
  const contextActionEditor = page.locator('.editor-pane.document .ProseMirror')
  await contextActionEditor.waitFor()
  await page.locator(
    '.editor-pane.document .view-switch button[aria-label="Markdown source"]',
  ).click()
  await page.locator('.editor-pane.document textarea.source-editor').fill(
    '# Context action\n\nCreated from the workspace context menu.\n',
  )
  await page.locator(
    '.editor-pane.document .view-switch button[aria-label="Visual editor"]',
  ).click()
  await page.getByRole('button', { name: 'Save Markdown file' }).click()
  await page.waitForFunction(() => (
    document.querySelector('.statusbar')?.textContent?.includes('Markdown file saved')
  ))

  await page.getByRole('treeitem', { name: 'Context Action.md', exact: true })
    .click({ button: 'right' })
  await page.getByRole('dialog', { name: 'Rename item' }).waitFor()
  assert.equal(await page.locator('#workspace-item-name').inputValue(), 'Context Action.md')
  await page.locator('#workspace-item-name').fill('Renamed Context')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.waitForFunction(() => (
    document.querySelector('.document-title span')?.textContent === 'Renamed Context.md'
    && document.querySelector('.editor-pane.document .ProseMirror h1')?.textContent === 'Context action'
  ))
  assert.match(
    await readFile(join(designDirectory, 'Renamed Context.md'), 'utf8'),
    /Created from the workspace context menu/,
  )

  await page.getByRole('treeitem', { name: 'Renamed Context.md', exact: true })
    .click({ button: 'right' })
  await page.getByRole('treeitem', { name: 'Renamed Context copy.md', exact: true }).waitFor()
  assert.equal(
    await readFile(join(designDirectory, 'Renamed Context copy.md'), 'utf8'),
    await readFile(join(designDirectory, 'Renamed Context.md'), 'utf8'),
  )

  await page.locator(
    '.editor-pane.document .view-switch button[aria-label="Markdown source"]',
  ).click()
  const sourceSwitchEditor = page.locator('.editor-pane.document textarea.source-editor')
  await sourceSwitchEditor.evaluate((element) => {
    window.__milkdownvSourceEditor = element
  })
  const sourceStyleBeforeSwitch = await sourceSwitchEditor.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
      filter: style.filter,
    }
  })
  await page.getByRole('treeitem', { name: 'SECOND.md', exact: true }).click({ button: 'right' })
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.document textarea.source-editor')?.readOnly === true
  ))
  assert.deepEqual(
    await sourceSwitchEditor.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        opacity: style.opacity,
        filter: style.filter,
      }
    }),
    sourceStyleBeforeSwitch,
  )
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.document textarea.source-editor')?.value
      .includes('# Second document')
    && document.querySelector('.editor-pane.document textarea.source-editor')?.readOnly === false
  ))
  assert.equal(await page.evaluate(() => (
    window.__milkdownvSourceEditor
      === document.querySelector('.editor-pane.document textarea.source-editor')
  )), true)
  await page.locator(
    '.editor-pane.document .view-switch button[aria-label="Visual editor"]',
  ).click()
  await page.waitForFunction(() => (
    document.querySelector('.editor-pane.document .ProseMirror h1')?.textContent === 'Second document'
  ))
} catch (error) {
  if (diagnostics.length > 0) console.error(diagnostics.join('\n'))
  if (page) {
    await page.screenshot({ path: join(screenshotDirectory, 'failure.png') }).catch(() => undefined)
  }
  throw error
} finally {
  if (application) await application.close()
  await rm(temporaryDirectory, { recursive: true, force: true })
}
