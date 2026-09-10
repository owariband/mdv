import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { chromium, type Frame } from 'playwright-core'
import { createMdv, openMdv, verifyMdv, type ContentSpec } from '@owariband/mdv'
import { imageResourceUri, parseImageResource, parseSource, sourceUri } from '../src/uri.js'
import { layoutVersions } from '../src/version-graph.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vZkAAAAASUVORK5CYII=', 'base64')

export async function run(): Promise<void> {
  const workspace = process.env.MDV_TEST_WORKSPACE!
  assert.ok(workspace)
  const extension = vscode.extensions.getExtension('mdv-local.mdv-vscode')
  assert.ok(extension)
  await extension.activate()
  console.log(`VS Code ${vscode.version}, Node ${process.version}, platform ${process.platform}`)
  if (process.env.MDV_TEST_RECOVERY !== '0' && process.env.MDV_TEST_RECOVERY) return recovery(workspace)
  const failures: string[] = []
  const results: { name: string; passed: boolean; error?: string }[] = []
  async function check(name: string, action: () => Promise<void>): Promise<void> {
    try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`) }
    catch (error) {
      failures.push(name)
      results.push({ name, passed: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
      console.error(`FAIL ${name}`, error)
    }
  }
  const file = vscode.Uri.file(join(workspace, '中文 space # 100%.mdv'))
  let core = await createMdv(file.fsPath)
  const working = (tree: 'reference' | 'document') => sourceUri(file, core.manifest.documentId, { tree, kind: 'working-copy' })
  const docUri = working('document')
  const refUri = working('reference')

  if (process.env.MDV_TEST_RESTRICTED === '1') {
    assert.equal(vscode.workspace.isTrusted, false)
    const document = await vscode.workspace.openTextDocument(docUri)
    assert.equal(document.languageId, 'markdown')
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(docUri, Buffer.from('blocked'))))
    assert.equal((await vscode.workspace.fs.stat(docUri)).permissions, vscode.FilePermission.Readonly)
    assert.equal(await (await openMdv(file.fsPath)).readDocumentText(), '')
    const blankFile = vscode.Uri.file(join(workspace, 'restricted-empty.mdv'))
    await writeFile(blankFile.fsPath, '')
    await vscode.commands.executeCommand('vscode.open', blankFile)
    await until(() => parseSource(vscode.window.activeTextEditor?.document.uri ?? file)?.packageUri.toString() === blankFile.toString(), 'empty document opens in Restricted Mode')
    const blank = vscode.window.activeTextEditor!.document
    assert.equal(blank.getText(), '')
    assert.equal((await vscode.workspace.fs.stat(blank.uri)).permissions, vscode.FilePermission.Readonly)
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(blank.uri, Buffer.from('blocked'))))
    assert.equal((await readFile(blankFile.fsPath)).length, 0)
    console.log('PASS Restricted Mode read-only enforcement')
    return
  }
  assert.equal(vscode.workspace.isTrusted, true)

  await check('an ordinary new empty .mdv opens directly as Markdown and its first save writes the archive', async () => {
    const blankFile = vscode.Uri.file(join(workspace, 'new empty 中文.mdv'))
    await vscode.workspace.fs.writeFile(blankFile, new Uint8Array())
    await vscode.commands.executeCommand('vscode.open', blankFile)
    await until(() => parseSource(vscode.window.activeTextEditor?.document.uri ?? file)?.packageUri.toString() === blankFile.toString(), 'ordinary open routes to the empty Doc editor')
    const blank = vscode.window.activeTextEditor!.document
    assert.equal(blank.languageId, 'markdown')
    assert.equal(blank.isDirty, false)
    assert.equal(blank.getText(), '')
    assert.equal((await readFile(blankFile.fsPath)).length, 0, 'Opening must not write the file')
    const original = await openMdv(blankFile.fsPath)
    const resource = await original.importManagedResource({ bytes: PNG })
    assert.equal((await readFile(blankFile.fsPath)).length, 0)
    await replace(blank, `# First document\n\n![image](${resource})\n`)
    assert.equal(await blank.save(), true)
    const saved = await openMdv(blankFile.fsPath)
    assert.equal(saved.manifest.documentId, original.manifest.documentId)
    assert.equal(saved.manifest.generation, 1)
    assert.equal(saved.listVersions().length, 0)
    assert.equal(await saved.readDocumentText(), blank.getText())
    assert.deepEqual(Buffer.from((await saved.readManagedResource(resource)).bytes), PNG)
    assert.equal((await verifyMdv(blankFile.fsPath, { mode: 'full' })).valid, true)
  })

  await check('reopening MDV from another group reuses its dirty Doc and safely removes the entry', async () => {
    const target = vscode.Uri.file(join(workspace, 'reopen-entry.mdv'))
    const initial = await createMdv(target.fsPath)
    const uri = sourceUri(target, initial.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false })
    await replace(doc, '# Keep this draft\n')
    const selection = new vscode.Selection(0, 2, 0, 6)
    vscode.window.activeTextEditor!.selection = selection
    const other = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Other draft\n' })
    await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Two, preview: false })
    for (const repetitions of [1, 1, 3]) {
      await Promise.all(Array.from({ length: repetitions }, () => vscode.commands.executeCommand('vscode.openWith', target, 'mdv.overview',
        { viewColumn: vscode.ViewColumn.Two, preview: false })))
      await until(() => vscode.window.activeTextEditor?.document === doc, 'reopening reuses the existing Doc')
      await until(() => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
        tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'mdv.overview')), 'entry tab is removed after opening')
      assert.equal(doc.isDirty, true)
      assert.equal(doc.getText(), '# Keep this draft\n')
      assert.equal(vscode.window.activeTextEditor!.selection.isEqual(selection), true)
    }
    assert.equal(other.getText(), '# Other draft\n')
    assert.equal(other.isClosed, false)
    assert.equal(await (await openMdv(target.fsPath)).readDocumentText(), '')
    await vscode.commands.executeCommand('undo')
    assert.equal(doc.getText(), '')
    await vscode.commands.executeCommand('redo')
    assert.equal(doc.getText(), '# Keep this draft\n')
  })

  await check('background entries can be closed without redirecting and activate only when selected', async () => {
    const target = vscode.Uri.file(join(workspace, 'background-entry.mdv'))
    await writeFile(target.fsPath, '')
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
    const active = vscode.window.activeTextEditor!.document
    const entry = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
      tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'mdv.overview' && tab.input.uri.toString() === target.toString())
    // The command's background option creates an inactive tab; preserveFocus alone does not.
    await vscode.commands.executeCommand('vscode.openWith', target, 'mdv.overview',
      { viewColumn: vscode.ViewColumn.Two, preview: false, preserveFocus: true, background: true })
    await until(() => !!entry(), 'background entry tab exists')
    assert.equal(vscode.window.activeTextEditor?.document, active)
    await vscode.window.tabGroups.close(entry()!, true)
    await delay(250)
    assert.equal(vscode.window.activeTextEditor?.document, active)
    assert.equal(vscode.workspace.textDocuments.some((doc) => parseSource(doc.uri)?.packageUri.toString() === target.toString()), false)
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
    assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One)
    await vscode.commands.executeCommand('vscode.openWith', target, 'mdv.overview',
      { viewColumn: vscode.ViewColumn.Two, preview: false, preserveFocus: true, background: true })
    await delay(250)
    assert.equal(vscode.window.activeTextEditor?.document, active)
    await vscode.commands.executeCommand('vscode.openWith', target, 'mdv.overview', { viewColumn: vscode.ViewColumn.Two, preview: false })
    await until(() => parseSource(vscode.window.activeTextEditor?.document.uri ?? file)?.packageUri.toString() === target.toString(), 'selecting the background entry opens Doc')
    await until(() => !entry(), 'activated entry leaves no custom tab')
    assert.equal((await readFile(target.fsPath)).length, 0)
  })

  await check('opening a nonempty invalid .mdv never overwrites it', async () => {
    const invalid = vscode.Uri.file(join(workspace, 'not-an-archive.mdv'))
    const bytes = Buffer.from('# Existing content must survive\n')
    await writeFile(invalid.fsPath, bytes)
    await assert.rejects(Promise.resolve(vscode.commands.executeCommand('mdv.editDocument', invalid)))
    assert.deepEqual(await readFile(invalid.fsPath), bytes)
  })

  await check('URI identity, special characters, relative base and historical addressing', async () => {
    assert.equal(parseSource(docUri)?.packageUri.toString(), file.toString())
    assert.equal(vscode.Uri.joinPath(docUri, '..').path, vscode.Uri.joinPath(file, '..').path)
    assert.equal(parseSource(docUri.with({ fragment: 'heading' }))?.content.kind, 'working-copy')
    assert.equal(parseSource(docUri.with({ authority: 'untrusted' })), undefined)
    const proxy = imageResourceUri(docUri, './assets/a%20b%23c.png')!
    assert.equal(parseImageResource(proxy)?.target.fsPath, join(workspace, 'assets/a b#c.png'))
    assert.equal(imageResourceUri(docUri, 'https://example.com/a.png'), undefined)
  })

  let document: vscode.TextDocument
  let reference: vscode.TextDocument
  await check('native Markdown editing and save do not create versions', async () => {
    document = await vscode.workspace.openTextDocument(docUri)
    reference = await vscode.workspace.openTextDocument(refUri)
    assert.equal(document.languageId, 'markdown')
    const uri = await vscode.commands.executeCommand<vscode.Uri>('mdv.editDocument', file)
    assert.equal(uri?.toString(), docUri.toString())
    await replace(document, '# Document\n\n**bold** and `code`.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
    assert.equal(document.isDirty, true)
    assert.equal(await (await openMdv(file.fsPath)).readDocumentText(), '')
    assert.equal(await document.save(), true)
    core = await openMdv(file.fsPath)
    assert.equal(core.listVersions().length, 0)
    assert.equal(await core.readDocumentText(), document.getText())
    assert.equal((await core.getStatus()).document.dirty, true)
  })

  await check('both dirty editors save in sequence without false file-modified conflicts', async () => {
    await replace(reference!, '# Ref one\n')
    await replace(document!, '# Doc one\n')
    const before = await vscode.workspace.fs.stat(docUri)
    assert.equal(await reference!.save(), true)
    const after = await vscode.workspace.fs.stat(docUri)
    assert.equal(after.mtime, before.mtime, 'Saving Ref must not change the virtual Doc mtime')
    assert.equal(document!.isDirty, true)
    assert.equal(await document!.save(), true)
    core = await openMdv(file.fsPath)
    assert.equal(await core.readReferenceText(), '# Ref one\n')
    assert.equal(await core.readDocumentText(), '# Doc one\n')
  })

  await check('native undo and redo preserve the unsaved editor model', async () => {
    await vscode.window.showTextDocument(document!)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    await until(() => vscode.window.activeTextEditor?.document === document, 'Doc is the active undo target')
    const original = document!.getText()
    const editor = vscode.window.activeTextEditor!
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'prefix '))
    await vscode.commands.executeCommand('undo')
    await until(() => document!.getText() === original, 'undo reaches the Extension Host text model')
    assert.equal(document!.getText(), original)
    await vscode.commands.executeCommand('redo')
    await until(() => document!.getText() === 'prefix ' + original, 'redo reaches the Extension Host text model')
    assert.equal(document!.getText(), 'prefix ' + original)
    assert.equal(await document!.save(), true)
  })

  await check('native delayed auto-save persists a working copy without committing', async () => {
    const autoFile = vscode.Uri.file(join(workspace, 'auto-save.mdv'))
    const initial = await createMdv(autoFile.fsPath)
    const uri = sourceUri(autoFile, initial.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const editorDocument = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(editorDocument)
    const configuration = vscode.workspace.getConfiguration('files')
    await configuration.update('autoSaveDelay', 150, vscode.ConfigurationTarget.Workspace)
    await configuration.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace)
    try {
      await replace(editorDocument, '# Auto-saved, not committed\n')
      await until(() => !editorDocument.isDirty, 'native delayed auto-save')
      const saved = await openMdv(autoFile.fsPath)
      assert.equal(await saved.readDocumentText(), '# Auto-saved, not committed\n')
      assert.equal(saved.listVersions().length, 0)
    } finally {
      await configuration.update('autoSave', undefined, vscode.ConfigurationTarget.Workspace)
      await configuration.update('autoSaveDelay', undefined, vscode.ConfigurationTarget.Workspace)
    }
  })

  let historicDoc: vscode.Uri
  await check('immutable history, exact bind, and native side-by-side bound sources', async () => {
    core = await openMdv(file.fsPath)
    const referenceCommit = await core.commitReference({ expectedGeneration: core.manifest.generation, actor: { type: 'human' }, summary: 'Ref baseline' })
    assert.equal(referenceCommit.created, true)
    core = referenceCommit.document
    const referenceId = core.referenceTree.head!
    const documentCommit = await core.commitDocument({ expectedGeneration: core.manifest.generation, actor: { type: 'agent' }, summary: 'Doc baseline', referenceVersion: referenceId })
    core = documentCommit.document
    const id = core.documentTree.head!
    historicDoc = sourceUri(file, core.manifest.documentId, { tree: 'document', kind: 'version', version: id })
    const historical = await vscode.workspace.openTextDocument(historicDoc)
    assert.equal(historical.languageId, 'markdown')
    assert.equal((await vscode.workspace.fs.stat(historicDoc)).permissions, vscode.FilePermission.Readonly)
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(historicDoc, Buffer.from('illegal'))))
    const pair = await vscode.commands.executeCommand<readonly vscode.Uri[]>('mdv.showBindingSources', historicDoc)
    assert.equal(pair?.length, 2)
    const selectedRef = parseSource(pair![0]!)!.content
    assert.equal(selectedRef.kind, 'version')
    assert.equal((selectedRef as Extract<ContentSpec, { kind: 'version' }>).version, referenceId)
    assert.equal(pair![1]!.toString(), historicDoc.toString())
  })

  await check('external clean changes refresh; external dirty changes cannot overwrite disk', async () => {
    await vscode.window.showTextDocument(document!)
    core = await openMdv(file.fsPath)
    core = await core.saveDocument({ markdown: '# External clean\n', expectedGeneration: core.manifest.generation })
    await until(() => document!.getText() === '# External clean\n', 'clean editor refresh')
    await replace(document!, '# My unsaved work\n')
    core = await core.saveDocument({ markdown: '# Agent winner\n', expectedGeneration: core.manifest.generation })
    await delay(300)
    assert.equal(document!.getText(), '# My unsaved work\n')
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(docUri, Buffer.from(document!.getText()))))
    assert.equal(await (await openMdv(file.fsPath)).readDocumentText(), '# Agent winner\n')
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  await check('external Ref and Doc changes keep the untouched dirty working copy saveable', async () => {
    const target = vscode.Uri.file(join(workspace, 'independent-working-copies.mdv'))
    const initial = await createMdv(target.fsPath)
    const referenceUri = sourceUri(target, initial.manifest.documentId, { tree: 'reference', kind: 'working-copy' })
    const documentUri = sourceUri(target, initial.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const reference = await vscode.workspace.openTextDocument(referenceUri)
    const document = await vscode.workspace.openTextDocument(documentUri)
    await vscode.window.showTextDocument(reference, { viewColumn: vscode.ViewColumn.One, preview: false })
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false })

    await replace(reference, '# Unsaved Ref draft\n')
    let writer = await openMdv(target.fsPath)
    await writer.saveDocument({ markdown: '# External Doc\n', expectedGeneration: writer.manifest.generation })
    await until(() => document.getText() === '# External Doc\n', 'external Doc refresh while Ref is dirty')
    assert.equal(reference.isDirty, true)
    assert.equal(reference.getText(), '# Unsaved Ref draft\n')
    assert.equal(await reference.save(), true)

    await replace(document, '# Unsaved Doc draft\n')
    writer = await openMdv(target.fsPath)
    await writer.saveReference({ markdown: '# External Ref\n', expectedGeneration: writer.manifest.generation })
    await until(() => reference.getText() === '# External Ref\n', 'external Ref refresh while Doc is dirty')
    assert.equal(document.isDirty, true)
    assert.equal(document.getText(), '# Unsaved Doc draft\n')
    assert.equal(await document.save(), true)

    const saved = await openMdv(target.fsPath)
    assert.equal(await saved.readReferenceText(), '# External Ref\n')
    assert.equal(await saved.readDocumentText(), '# Unsaved Doc draft\n')
    assert.deepEqual(saved.referenceTree, initial.referenceTree)
    assert.deepEqual(saved.documentTree, initial.documentTree)
    assert.deepEqual(saved.listVersions(), initial.listVersions())
  })

  await check('managed and ordinary images resolve through the actual filesystem provider', async () => {
    core = await openMdv(file.fsPath)
    const imported = await core.importManagedResource({ bytes: PNG })
    const proxy = imageResourceUri(docUri, imported)!
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(proxy)), PNG)
    await mkdir(join(workspace, 'assets'), { recursive: true })
    await writeFile(join(workspace, 'assets/a b#c.png'), PNG)
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(imageResourceUri(docUri, './assets/a%20b%23c.png')!)), PNG)
    const outside = join(dirname(workspace), 'private.png')
    await writeFile(outside, PNG)
    await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(imageResourceUri(docUri, '../private.png')!)))
    if (process.platform !== 'win32') {
      await symlink(outside, join(workspace, 'escape.png'))
      await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(imageResourceUri(docUri, './escape.png')!)))
    }
    await writeFile(join(workspace, imported), Buffer.from('modified'))
    await assert.rejects(Promise.resolve(vscode.workspace.fs.readFile(proxy)))
  })

  await check('reuse VS Code Markdown rendering and another extension’s markdown-it contribution', async () => {
    await vscode.extensions.getExtension('vscode.markdown-language-features')!.activate()
    await vscode.extensions.getExtension('mdv-test.mdv-markdown-contribution-test')!.activate()
    await vscode.commands.executeCommand('markdown.api.reloadPlugins')
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', '# Hello\n\n**contribution**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
    assert.match(html!, /<h1/)
    assert.match(html!, /<table\b/)
    assert.match(html!, /data-mdv-contribution-test="passed"/)
    await vscode.commands.executeCommand('mdv.preview', historicDoc!)
    await until(() => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)), 'built-in Markdown preview tab')
    await vscode.commands.executeCommand('mdv.showBinding', historicDoc!)
    await until(() => vscode.window.tabGroups.all.filter((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'vscode.markdown.preview.editor')).length >= 2, 'two exact historical built-in previews')
  })

  if (process.env.MDV_TEST_MARKDOWN_EXTENSION === '1') await check('Markdown All in One formats an mdv: native Markdown buffer', async () => {
    const markdown = vscode.extensions.getExtension('yzhang.markdown-all-in-one')
    assert.ok(markdown)
    await markdown.activate()
    const extraFile = vscode.Uri.file(join(workspace, 'markdown-plugin.mdv'))
    const extra = await createMdv(extraFile.fsPath)
    const uri = sourceUri(extraFile, extra.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const doc = await vscode.workspace.openTextDocument(uri)
    await replace(doc, 'compatible')
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(0, 0, 0, 10)
    await vscode.commands.executeCommand('markdown.extension.editing.toggleBold')
    assert.equal(doc.getText(), '**compatible**')
    assert.equal(await doc.save(), true)
    assert.equal(await (await openMdv(extraFile.fsPath)).readDocumentText(), '**compatible**')
  })

  await check('real preview DOM loads hash images, tables and contributed CSS; existing packages open directly as Doc', async () => {
    const visualFile = vscode.Uri.file(join(workspace, 'preview-check.mdv'))
    let visual = await createMdv(visualFile.fsPath)
    const resource = await visual.importManagedResource({ bytes: PNG })
    visual = await visual.saveDocument({ markdown: `# MDV render check\n\n**Existing Markdown renderer**\n\n| Ref | Doc |\n| --- | --- |\n| Bound | Versioned |\n\n![hash image](${resource})\n`, expectedGeneration: 0 })
    const uri = sourceUri(visualFile, visual.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.MDV_TEST_CDP_PORT}`)
    try {
      await vscode.commands.executeCommand('mdv.preview', uri)
      const deadline = Date.now() + 15_000
      let preview: Frame | undefined
      while (!preview && Date.now() < deadline) {
        for (const page of browser.contexts().flatMap((context) => context.pages())) {
          for (const frame of page.frames()) {
            if (await frame.locator('#mdv-render-check').count().catch(() => 0)) preview = frame
          }
        }
        if (!preview) await delay(100)
      }
      if (!preview) console.error('CDP targets', (await (await browser.newBrowserCDPSession()).send('Target.getTargets')).targetInfos)
      if (!preview) for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries()) {
        console.error('Preview diagnostic', page.url(), page.frames().map((frame) => frame.url()))
        await page.screenshot({ path: join(workspace, `preview-failure-${index}.png`) })
        for (const frame of page.frames()) console.error('Frame text', (await frame.locator('body').innerText().catch(() => '')).slice(0, 1000))
      }
      assert.ok(preview, 'The built-in preview must render our actual mdv: document')
      await preview.waitForFunction('document.querySelector("img")?.complete && document.querySelector("img").naturalWidth > 0', undefined, { timeout: 10_000 })
      assert.equal(await preview.locator('table').count(), 1)
      assert.equal(await preview.locator('[data-mdv-contribution-test="passed"]').count(), 1)
      const style = await preview.evaluate('getComputedStyle(document.querySelector(".markdown-body")).getPropertyValue("--mdv-test-preview-contribution").trim()')
      assert.equal(style, 'active')
      assert.match((await preview.locator('img').getAttribute('src'))!, /mdv-preview/)
      await preview.page().screenshot({ path: join(workspace, 'markdown-preview.png') })
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle')
      await vscode.commands.executeCommand('vscode.open', visualFile)
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'existing package routes to native Doc')
      await until(() => !vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'mdv.overview')), 'router leaves no overview tab')
      assert.equal(vscode.window.visibleTextEditors.some((editor) => parseSource(editor.document.uri)?.content.tree === 'reference'), false)
      assert.equal(await (await openMdv(visualFile.fsPath)).readDocumentText(), (await vscode.workspace.openTextDocument(uri)).getText())
      console.log(`Preview screenshots: ${workspace}`)
    } finally { await browser.close() }
  })

  await check('commit dialogs select an exact Ref and restore confirms both dirty states', async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.MDV_TEST_CDP_PORT}`)
    try {
      const page = browser.contexts()[0]!.pages()[0]!
      const input = page.locator('.quick-input-widget input')
      async function summary(tree: string, text: string): Promise<void> {
        await page.getByText(`Commit ${tree}`, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        await input.waitFor({ state: 'visible', timeout: 10_000 })
        await input.fill(text)
        await input.press('Enter')
      }
      const file = vscode.Uri.file(join(workspace, 'commands.mdv'))
      const initial = await createMdv(file.fsPath)
      const refUri = sourceUri(file, initial.manifest.documentId, { tree: 'reference', kind: 'working-copy' })
      const docUri = sourceUri(file, initial.manifest.documentId, { tree: 'document', kind: 'working-copy' })
      const ref = await vscode.workspace.openTextDocument(refUri)
      await replace(ref, '# Requirements\n')
      const refCommand = vscode.commands.executeCommand('mdv.commitReference', file)
      await page.getByRole('button', { name: 'Save and continue', exact: true }).click({ timeout: 10_000 })
      await summary('reference', 'Reference baseline')
      await refCommand
      const refVersion = (await openMdv(file.fsPath)).referenceTree.head
      assert.ok(refVersion)
      const doc = await vscode.workspace.openTextDocument(docUri)
      await replace(doc, '# Committed document\n')
      const docCommand = vscode.commands.executeCommand('mdv.commitDocument', file)
      await page.getByRole('button', { name: 'Save and continue', exact: true }).click({ timeout: 10_000 })
      await summary('document', 'Document baseline')
      await page.getByText('Bind this Document to an exact Reference Version', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
      await input.waitFor({ state: 'visible', timeout: 10_000 })
      await input.fill(refVersion)
      await input.press('Enter')
      await docCommand
      let saved = await openMdv(file.fsPath)
      const docVersion = saved.documentTree.head!
      assert.equal(saved.getDocumentReference(docVersion), refVersion)
      await replace(doc, '# Saved but uncommitted\n')
      assert.equal(await doc.save(), true)
      await replace(doc, '# Unsaved editor changes\n')
      const restore = vscode.commands.executeCommand('mdv.checkout', file)
      await page.getByText('MDV history', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
      await input.waitFor({ state: 'visible', timeout: 10_000 })
      await input.fill('Document baseline')
      await input.press('Enter')
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Restore version', exact: true }) })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await dialog.innerText(), /unsaved editor text/)
      assert.match(await dialog.innerText(), /saved but uncommitted/)
      await page.getByRole('button', { name: 'Restore version', exact: true }).click()
      await restore
      assert.equal(doc.getText(), '# Committed document\n')
      assert.equal(doc.isDirty, false)
      saved = await openMdv(file.fsPath)
      assert.equal(saved.documentTree.head, docVersion)
      assert.equal(saved.referenceTree.head, refVersion)
    } finally { await browser.close() }
  })

  await check('same path replaced with another document is never overwritten', async () => {
    const target = vscode.Uri.file(join(workspace, 'replacement.mdv'))
    const original = await createMdv(target.fsPath)
    const uri = sourceUri(target, original.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const editor = await vscode.workspace.openTextDocument(uri)
    await replace(editor, 'stale buffer')
    const replacement = join(workspace, 'incoming.mdv')
    const other = await createMdv(replacement)
    await rename(replacement, target.fsPath)
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(uri, Buffer.from('stale buffer'))))
    assert.equal((await openMdv(target.fsPath)).manifest.documentId, other.manifest.documentId)
    await vscode.window.showTextDocument(editor)
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  await check('native working-copy pairing hides either side without saving, closing or losing undo', async () => {
    const pairFile = vscode.Uri.file(join(workspace, 'paired-writing.mdv'))
    const initial = await createMdv(pairFile.fsPath)
    await vscode.commands.executeCommand('mdv.open', pairFile)
    const doc = vscode.window.activeTextEditor!.document
    await replace(doc, '# Unsaved Doc\n')
    const docEditor = vscode.window.activeTextEditor!
    docEditor.selection = new vscode.Selection(0, 3, 0, 7)
    const unrelated = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# Unrelated draft\n' })
    await vscode.window.showTextDocument(unrelated, { preview: false })
    await vscode.commands.executeCommand('mdv.editReference', pairFile)
    const refEditor = vscode.window.activeTextEditor!
    const ref = refEditor.document
    assert.equal(parseSource(ref.uri)?.content.tree, 'reference')
    await replace(ref, '# Unsaved Ref\n')
    refEditor.selection = new vscode.Selection(0, 2, 0, 6)
    const visible = () => vscode.window.visibleTextEditors.filter((editor) => parseSource(editor.document.uri)?.packageUri.toString() === pairFile.toString())
    assert.equal(visible().length, 2)
    assert.ok(visible().find((editor) => editor.document === ref)!.viewColumn! < visible().find((editor) => editor.document === doc)!.viewColumn!)
    assert.ok(vscode.window.tabGroups.all.every((group) => group.tabs.every((tab) => !(tab.input instanceof vscode.TabInputTextDiff))))
    const before = await readFile(pairFile.fsPath)
    const closed: vscode.TextDocument[] = []
    const listener = vscode.workspace.onDidCloseTextDocument((document) => closed.push(document))
    try {
      await vscode.commands.executeCommand('mdv.toggleReference', pairFile)
      assert.equal(visible().length, 1)
      assert.equal(visible()[0]!.document, doc)
      assert.equal(doc.isDirty, true)
      assert.equal(ref.isDirty, true)
      assert.equal(doc.getText(), '# Unsaved Doc\n')
      assert.equal(ref.getText(), '# Unsaved Ref\n')
      await vscode.commands.executeCommand('mdv.toggleReference', pairFile)
      assert.equal(visible().length, 2)
      assert.deepEqual(vscode.window.activeTextEditor!.selection, new vscode.Selection(0, 2, 0, 6))
      await vscode.commands.executeCommand('undo')
      assert.equal(ref.getText(), '')
      await vscode.commands.executeCommand('redo')
      assert.equal(ref.getText(), '# Unsaved Ref\n')
      await vscode.commands.executeCommand('mdv.toggleDocument', pairFile)
      assert.equal(visible().length, 1)
      assert.equal(visible()[0]!.document, ref)
      await vscode.commands.executeCommand('mdv.toggleDocument', pairFile)
      assert.equal(visible().length, 2)
      assert.deepEqual(vscode.window.activeTextEditor!.selection, new vscode.Selection(0, 3, 0, 7))
      assert.ok(!closed.includes(doc) && !closed.includes(ref))
      assert.equal(unrelated.isClosed, false)
      assert.equal(unrelated.getText(), '# Unrelated draft\n')
      assert.deepEqual(await readFile(pairFile.fsPath), before)
      assert.equal((await openMdv(pairFile.fsPath)).manifest.generation, initial.manifest.generation)
      assert.equal(await ref.save(), true)
      assert.equal(await doc.save(), true)
      const saved = await openMdv(pairFile.fsPath)
      assert.equal(saved.listVersions().length, 0)
      assert.equal(await saved.readReferenceText(), ref.getText())
      assert.equal(await saved.readDocumentText(), doc.getText())
    } finally { listener.dispose() }
  })

  await check('hidden dirty sources still reject an external writer instead of renewing the save baseline', async () => {
    const hiddenFile = vscode.Uri.file(join(workspace, 'hidden-conflict.mdv'))
    const initial = await createMdv(hiddenFile.fsPath)
    await vscode.commands.executeCommand('mdv.open', hiddenFile)
    const doc = vscode.window.activeTextEditor!.document
    await replace(doc, '# Hidden unsaved draft\n')
    await vscode.commands.executeCommand('mdv.editReference', hiddenFile)
    await vscode.commands.executeCommand('mdv.toggleDocument', hiddenFile)
    assert.equal(vscode.window.visibleTextEditors.some((editor) => editor.document === doc), false)
    await initial.saveDocument({ markdown: '# External winner\n', expectedGeneration: initial.manifest.generation })
    await delay(250)
    await vscode.commands.executeCommand('mdv.toggleDocument', hiddenFile)
    assert.equal(doc.isDirty, true)
    assert.equal(doc.getText(), '# Hidden unsaved draft\n')
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(doc.uri, Buffer.from(doc.getText()))))
    assert.equal(await (await openMdv(hiddenFile.fsPath)).readDocumentText(), '# External winner\n')
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  await check('sidebar stays user-controlled and the responsive graph preserves forks, HEADs and reverse binds', async () => {
    const graphFile = vscode.Uri.file(join(workspace, 'version-graph.mdv'))
    let graph = await createMdv(graphFile.fsPath)
    const commitRef = async (summary: string) => {
      graph = await graph.saveReference({ markdown: summary, expectedGeneration: graph.manifest.generation })
      graph = (await graph.commitReference({ summary, actor: { type: 'human' }, expectedGeneration: graph.manifest.generation })).document
      return graph.referenceTree.head!
    }
    const commitDoc = async (summary: string, referenceVersion: `v_${string}` | null) => {
      graph = await graph.saveDocument({ markdown: summary, expectedGeneration: graph.manifest.generation })
      graph = (await graph.commitDocument({ summary, referenceVersion, actor: { type: 'agent' }, expectedGeneration: graph.manifest.generation })).document
      return graph.documentTree.head!
    }
    const r1 = await commitRef('Ref baseline')
    const r2 = await commitRef('Ref shared by two Docs')
    graph = await graph.checkoutReference({ version: r1, expectedGeneration: graph.manifest.generation })
    const r3 = await commitRef('<img src=x onerror="alert(1)"> branch Ref')
    const d1 = await commitDoc('First Doc', r1)
    const d2 = await commitDoc('Doc on another branch', r2)
    const d3 = await commitDoc('Another Doc using Ref', r2)
    graph = await graph.checkoutDocument({ version: d1, expectedGeneration: graph.manifest.generation })
    const d4 = await commitDoc('Unbound branch', null)
    const original = await readFile(graphFile.fsPath)
    const layout = layoutVersions(graph.listVersions({ tree: 'reference' }).map((version, index) => ({ ...version, createdAt: `2020-01-0${3 - index}T00:00:00Z` })))
    for (const node of layout) if (node.version.parent) assert.ok(node.row < layout.find((parent) => parent.version.id === node.version.parent)!.row)
    assert.ok(layout.some((node) => node.lane > 0))
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.MDV_TEST_CDP_PORT}`)
    try {
      const page = browser.contexts()[0]!.pages()[0]!
      const sidebar = page.locator('.part.sidebar')
      await vscode.commands.executeCommand('workbench.action.editorLayoutSingle')
      await vscode.commands.executeCommand('workbench.view.explorer')
      await sidebar.waitFor({ state: 'visible' })
      const title = await sidebar.locator('.title-label h2').innerText()
      const emptyFile = vscode.Uri.file(join(workspace, 'sidebar-empty.mdv'))
      await writeFile(emptyFile.fsPath, '')
      for (const target of [emptyFile, graphFile]) {
        await vscode.commands.executeCommand('vscode.open', target)
        await until(() => parseSource(vscode.window.activeTextEditor?.document.uri ?? file)?.packageUri.toString() === target.toString(), 'ordinary MDV open focuses its Doc')
        await delay(100)
        assert.equal(await sidebar.locator('.title-label h2').innerText(), title, 'Opening empty or saved MDV preserves Explorer')
      }
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('mdv.open', graphFile)
      await delay(100)
      assert.equal(await sidebar.isVisible(), false, 'MDV open must not reveal a hidden sidebar')
      // Recreate the non-retained sidebar after CDP attaches, so Playwright sees its OOPIF.
      await vscode.commands.executeCommand('mdv.showVersions', graphFile)
      let view: Frame | undefined
      const deadline = Date.now() + 10_000
      while (!view && Date.now() < deadline) {
        for (const page of browser.contexts().flatMap((context) => context.pages())) for (const frame of page.frames()) {
          if (await frame.locator('#versions').count().catch(() => 0)
            && await frame.locator('#versions').getAttribute('data-package') === graphFile.toString()) view = frame
        }
        if (!view) await delay(100)
      }
      if (!view) {
        const diagnostics = []
        for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries()) {
          await page.screenshot({ path: join(workspace, `graph-failure-${index}.png`) })
          for (const frame of page.frames()) diagnostics.push({ url: frame.url(),
            text: await frame.evaluate('document.body?.innerText ?? ""').catch(() => ''),
            versions: await frame.locator('#versions').count().catch(() => 0) })
        }
        await writeFile(join(workspace, 'graph-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
      }
      assert.ok(view, 'Actual sidebar WebviewView is present')
      assert.equal(await view.locator('.node.reference').count(), 3)
      assert.equal(await view.locator('.node.document').count(), 4)
      assert.equal(await view.locator('.parent.reference').count(), 2)
      assert.equal(await view.locator('.parent.document').count(), 3)
      assert.equal(await view.locator('path.binding[data-doc]').count(), 3)
      assert.equal(await view.locator(`[data-id="${r3}"] .head-badge`).innerText(), 'HEAD')
      assert.equal(await view.locator(`[data-id="${d4}"] .head-badge`).innerText(), 'HEAD')
      assert.equal(await view.locator('img').count(), 0, 'Untrusted summaries are text, never HTML')
      await view.locator(`[data-id="${r2}"]`).click()
      await view.locator('#relation').filter({ hasText: 'used by 2 Doc versions' }).waitFor()
      assert.equal(await view.locator(`.node.related[data-id="${d2}"]`).count(), 1)
      assert.equal(await view.locator(`.node.related[data-id="${d3}"]`).count(), 1)
      assert.equal(await view.locator('path.binding.highlighted[data-doc]').count(), 2)
      const viewHeights = new Set<number>()
      for (const [targetWidth, windowHeight] of [[200, 320], [460, 820], [280, 540]] as const) {
        await page.setViewportSize({ width: 1280, height: windowHeight })
        await delay(100)
        const box = (await sidebar.boundingBox())!
        await page.mouse.move(box.x + box.width, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + targetWidth, box.y + box.height / 2, { steps: 8 })
        await page.mouse.up()
        await delay(100)
        const dimensions: { width: number; height: number; graphWidth: number; viewportWidth: number; viewportOuterWidth: number;
          overflow: number; graphOverflow: number; footerBottom: number; dotsInside: boolean } = await view.evaluate(`(() => {
          const viewport = document.getElementById('viewport')
          const graph = document.getElementById('graph')
          const footer = document.querySelector('footer').getBoundingClientRect()
          return { width: innerWidth, height: innerHeight, graphWidth: graph.clientWidth,
            viewportWidth: viewport.clientWidth, viewportOuterWidth: viewport.offsetWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            graphOverflow: viewport.scrollWidth - viewport.clientWidth, footerBottom: footer.bottom,
            dotsInside: [...document.querySelectorAll('.dot')].every(dot => +dot.getAttribute('cx') > 0 && +dot.getAttribute('cx') < graph.clientWidth) }
        })()`)
        const resized = (await sidebar.boundingBox())!
        await page.screenshot({ path: join(workspace, `version-graph-${targetWidth}.png`) })
        assert.ok(Math.abs(resized.width - targetWidth) <= 2, `The real sidebar was resized to ${targetWidth}px, got ${resized.width}px; webview ${dimensions.width}px`)
        // Native vertical scrollbars consume layout width on some host configurations.
        assert.ok(Math.abs(dimensions.graphWidth - dimensions.viewportWidth) <= 2, JSON.stringify(dimensions))
        assert.ok(Math.abs(dimensions.viewportOuterWidth - dimensions.width) <= 2, JSON.stringify(dimensions))
        assert.ok(dimensions.overflow <= 1 && dimensions.graphOverflow <= 1, 'Graph fits without horizontal scrolling')
        assert.ok(Math.abs(dimensions.footerBottom - dimensions.height) <= 1, 'View fills the sidebar height')
        assert.equal(dimensions.dotsInside, true)
        viewHeights.add(dimensions.height)
      }
      assert.equal(viewHeights.size, 3, 'The actual WebviewView follows all three window heights')
      await view.page().screenshot({ path: join(workspace, 'version-graph.png') })
      await view.locator(`[data-id="${d4}"]`).click()
      await view.locator('#relation').filter({ hasText: 'unbound' }).waitFor()
      assert.equal(await view.locator('.node.related').count(), 0)
      assert.equal(await view.locator('#open-binding').isVisible(), false)
      await view.locator(`[data-id="${d2}"]`).click()
      await view.locator('#open-binding').waitFor({ state: 'visible' })
      assert.equal(await view.locator(`.node.related[data-id="${r2}"]`).count(), 1)
      await view.locator('#open-version').click()
      await until(() => parseSource(vscode.window.activeTextEditor?.document.uri ?? file)?.content.kind === 'version', 'graph opens immutable history')
      const historical = vscode.window.activeTextEditor!.document.uri
      assert.equal((parseSource(historical)!.content as Extract<ContentSpec, { kind: 'version' }>).version, d2)
      assert.equal((await vscode.workspace.fs.stat(historical)).permissions, vscode.FilePermission.Readonly)
      await view.locator('#open-binding').click()
      await until(() => vscode.window.visibleTextEditors.some((editor) => {
        const source = parseSource(editor.document.uri)
        return source?.content.kind === 'version' && source.content.version === r2
      }), 'bound source uses old Ref, not current Ref HEAD')
      assert.deepEqual(await readFile(graphFile.fsPath), original, 'Graph browsing never saves, commits or checks out')
      await view.evaluate(`vscode.postMessage({ action: 'command', package: ${JSON.stringify(file.toString())}, documentId: ${JSON.stringify(graph.manifest.documentId)}, command: 'mdv.commitDocument' })`)
      await view.evaluate(`vscode.postMessage({ action: 'command', package: ${JSON.stringify(graphFile.toString())}, documentId: ${JSON.stringify(graph.manifest.documentId)}, command: 'workbench.action.closeAllEditors' })`)
      await delay(100)
      assert.equal(vscode.window.tabGroups.all.some((group) => group.tabs.length > 0), true)
      await vscode.commands.executeCommand('mdv.editReference', graphFile)
      const draft = vscode.window.activeTextEditor!.document
      await replace(draft, '# Uncommitted Ref draft\n')
      await view.locator('#working-reference').filter({ hasText: 'Unsaved edits' }).waitFor()
      await view.locator('#toggle-reference').click()
      await until(() => !vscode.window.visibleTextEditors.some((editor) => editor.document === draft), 'sidebar hides dirty Ref')
      assert.equal(draft.isDirty, true)
      assert.equal(draft.getText(), '# Uncommitted Ref draft\n')
      await view.locator('#toggle-reference').click()
      await until(() => vscode.window.visibleTextEditors.some((editor) => editor.document === draft), 'sidebar restores dirty Ref')
      assert.equal(await draft.save(), true)
      await view.locator('#working-reference').filter({ hasText: 'Uncommitted' }).waitFor()
      assert.equal((await openMdv(graphFile.fsPath)).referenceTree.head, r3)
      await vscode.commands.executeCommand('mdv.open', file)
      await view.locator(`#versions[data-package="${file.toString()}"]`).waitFor()
      assert.equal(await view.locator(`[data-id="${r2}"]`).count(), 0, 'Switching packages cannot reuse the previous graph')
    } finally { await browser.close() }
  })

  await check('opening the native Doc leaves the Core package valid', async () => {
    await vscode.commands.executeCommand('mdv.open', file)
    assert.equal((await verifyMdv(file.fsPath, { mode: 'full' })).valid, true)
    const bytes = await readFile(file.fsPath)
    assert.equal(bytes.subarray(0, 2).toString(), 'PK')
  })

  if (process.env.MDV_TEST_AGENT_CLI) await check('real Agent CLI reads the pair, saves only Doc, refreshes clean editors and protects dirty ones', async () => {
    const target = vscode.Uri.file(join(workspace, 'agent tool.mdv'))
    let initial = await createMdv(target.fsPath)
    initial = await initial.saveReference({ markdown: '# Human Ref\n', expectedGeneration: 0 })
    const committed = await initial.commitReference({ expectedGeneration: initial.manifest.generation,
      actor: { type: 'human' }, summary: 'Agent reference' })
    initial = committed.document
    const uri = sourceUri(target, initial.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const editor = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(editor)
    const runCli = async (...args: string[]) => {
      const output = await promisify(execFile)(process.env.MDV_TEST_AGENT_NODE!, [process.env.MDV_TEST_AGENT_CLI!, ...args],
        { timeout: 15_000, maxBuffer: 1024 * 1024 })
      assert.equal(output.stderr, '')
      const response = JSON.parse(output.stdout)
      assert.equal(response.ok, true)
      return response.data
    }
    const input = join(workspace, 'agent-input.json')
    const pair = await runCli('read', '--file', target.fsPath, '--json')
    assert.equal(pair.reference.text, '# Human Ref\n')
    assert.equal(pair.document.text, '')
    await writeFile(input, JSON.stringify({ expectedDocumentId: pair.documentId,
      expectedGeneration: pair.generation, markdown: '# Agent first save\n' }))
    await runCli('save-document', '--file', target.fsPath, '--input', input)
    await until(() => editor.getText() === '# Agent first save\n', 'real CLI save refreshes clean editor')
    await replace(editor, '# Human unsaved edits\n')
    const nextPair = await runCli('read', '--file', target.fsPath, '--json')
    assert.equal(nextPair.document.text, '# Agent first save\n', 'Agent sees disk, not the unsaved editor buffer')
    await writeFile(input, JSON.stringify({ expectedDocumentId: nextPair.documentId,
      expectedGeneration: nextPair.generation, markdown: '# Agent second save\n' }))
    await runCli('save-document', '--file', target.fsPath, '--input', input)
    await delay(300)
    assert.equal(editor.isDirty, true)
    assert.equal(editor.getText(), '# Human unsaved edits\n')
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(uri, Buffer.from(editor.getText()))))
    const saved = await openMdv(target.fsPath)
    assert.equal(await saved.readDocumentText(), '# Agent second save\n')
    assert.equal(await saved.readReferenceText(), '# Human Ref\n')
    assert.deepEqual(saved.referenceTree, initial.referenceTree)
    assert.deepEqual(saved.documentTree, initial.documentTree)
    assert.deepEqual(saved.listVersions(), initial.listVersions())
  })

  await writeFile(join(workspace, 'test-results.json'), JSON.stringify({
    vscode: vscode.version, node: process.version, platform: process.platform, results,
  }, null, 2))
  if (failures.length) throw new Error(`${failures.length} extension tests failed: ${failures.join('; ')}`)
  console.log('All MDV Extension Host checks passed.')
}

async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
  assert.equal(await vscode.workspace.applyEdit(edit), true)
}

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`)
    await delay(50)
  }
}

async function delay(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)) }

async function recovery(workspace: string): Promise<void> {
  const marker = join(workspace, 'recovery.json')
  const emptyRecovery = process.env.MDV_TEST_RECOVERY === 'empty'
  let stored: { uri: string; reference: string; file: string } | undefined
  try { stored = JSON.parse(await readFile(marker, 'utf8')) as typeof stored }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  if (!stored) {
    const file = vscode.Uri.file(join(workspace, 'recovery.mdv'))
    await writeFile(file.fsPath, '')
    const core = await openMdv(file.fsPath)
    const uri = sourceUri(file, core.manifest.documentId, { tree: 'document', kind: 'working-copy' })
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
    await replace(document, '# Recovered unsaved text\n')
    await vscode.commands.executeCommand('mdv.editReference', file)
    const reference = vscode.window.activeTextEditor!.document
    await replace(reference, '# Recovered hidden Ref\n')
    await vscode.commands.executeCommand('mdv.toggleReference', file)
    assert.equal(vscode.window.visibleTextEditors.some((editor) => editor.document === reference), false)
    await writeFile(marker, JSON.stringify({ uri: uri.toString(), reference: reference.uri.toString(), file: file.fsPath }))
    if (!emptyRecovery) await core.saveDocument({ markdown: '# External winner while editing\n', expectedGeneration: core.manifest.generation })
    await delay(500)
    console.log('Recovery test: reloading the actual VS Code window with unsaved text and an old generation.')
    await vscode.commands.executeCommand('workbench.action.reloadWindow')
    await new Promise(() => undefined)
  } else {
    const uri = vscode.Uri.parse(stored.uri)
    const document = await vscode.workspace.openTextDocument(uri)
    await until(() => document.isDirty, 'restored dirty buffer')
    assert.equal(document.getText(), '# Recovered unsaved text\n')
    const reference = await vscode.workspace.openTextDocument(vscode.Uri.parse(stored.reference))
    await until(() => reference.isDirty, 'restored hidden dirty Ref')
    assert.equal(reference.getText(), '# Recovered hidden Ref\n')
    if (emptyRecovery) {
      assert.equal((await readFile(stored.file)).length, 0)
      await vscode.commands.executeCommand('mdv.toggleReference', vscode.Uri.file(stored.file))
      assert.equal(await reference.save(), true)
      assert.equal(await document.save(), true)
      const saved = await openMdv(stored.file)
      assert.equal(await saved.readDocumentText(), document.getText())
      assert.equal(await saved.readReferenceText(), reference.getText())
      assert.equal(saved.listVersions().length, 0)
      console.log('PASS first-ever save after actual window reload preserves the empty document identity and unsaved text')
      return
    }
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(uri, Buffer.from(document.getText()))))
    assert.equal(await reference.save(), true)
    const saved = await openMdv(stored.file)
    assert.equal(await saved.readDocumentText(), '# External winner while editing\n')
    assert.equal(await saved.readReferenceText(), '# Recovered hidden Ref\n')
    assert.equal(saved.listVersions().length, 0)
    console.log('PASS actual window reload blocks the changed Doc and saves the unchanged recovered Ref')
  }
}
