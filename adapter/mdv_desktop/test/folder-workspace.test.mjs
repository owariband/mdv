import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FolderWorkspace,
  FolderWorkspaceError,
  toWorkspaceFailure,
} from '../out/main/folder-workspace.js'

async function fixture(t) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mdv-folder-workspace-'))
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))
  const root = join(temporaryDirectory, 'notes')
  await mkdir(root)
  return { temporaryDirectory, root }
}

function flatten(node, result = []) {
  result.push(node)
  if (node.kind === 'directory') {
    for (const child of node.children) flatten(child, result)
  }
  return result
}

test('reports committed mutations that invalidated the active document', () => {
  assert.deepEqual(
    toWorkspaceFailure(new FolderWorkspaceError('IO_ERROR', 'Refresh failed.', true, true)),
    {
      code: 'IO_ERROR',
      message: 'Refresh failed.',
      committed: true,
      activeDocumentInvalidated: true,
    },
  )
})

test('returns an opaque, filtered Markdown workspace without paths', async (t) => {
  const { temporaryDirectory, root } = await fixture(t)
  const nested = join(root, 'Design')
  const assets = join(root, 'assets')
  const hidden = join(root, '.private')
  const dependencies = join(root, 'node_modules', 'package')
  const external = join(temporaryDirectory, 'external')
  await Promise.all([
    mkdir(nested),
    mkdir(assets),
    mkdir(hidden),
    mkdir(dependencies, { recursive: true }),
    mkdir(external),
  ])
  await Promise.all([
    writeFile(join(root, 'README.md'), '# Notes\n'),
    writeFile(join(nested, 'plan.MDV'), new Uint8Array()),
    writeFile(join(root, 'ignored.txt'), 'not visible\n'),
    writeFile(join(hidden, 'secret.mdv'), new Uint8Array()),
    writeFile(join(dependencies, 'dependency.mdv'), new Uint8Array()),
    writeFile(join(external, 'outside.mdv'), new Uint8Array()),
  ])
  await symlink(external, join(root, 'linked-folder'))
  await symlink(join(external, 'outside.mdv'), join(root, 'linked-file.mdv'))

  const opened = await FolderWorkspace.open(root)
  const nodes = flatten(opened.view.root)
  const names = nodes.map((node) => node.name)
  const serialized = JSON.stringify(opened.view)

  assert.deepEqual(names, ['notes', 'assets', 'Design', 'plan.MDV', 'README.md'])
  assert.equal(serialized.includes(temporaryDirectory), false)
  assert.equal(serialized.includes('relativePath'), false)
  assert.equal(serialized.includes('absolutePath'), false)
  assert.match(opened.view.workspaceId, /^[0-9a-f-]{36}$/)
  assert.ok(nodes.every((node) => /^n_[0-9a-f]{32}$/.test(node.id)))
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length)
})

test('keeps node capabilities stable across an atomic refresh', async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'first.mdv'), new Uint8Array())
  const { workspace, view } = await FolderWorkspace.open(root)
  const first = flatten(view.root).find((node) => node.name === 'first.mdv')
  assert.ok(first)

  await writeFile(join(root, 'second.md'), '# Context\n')
  const refreshed = await workspace.refresh()
  const refreshedNodes = flatten(refreshed.root)
  const sameFirst = refreshedNodes.find((node) => node.name === 'first.mdv')

  assert.equal(refreshed.revision, view.revision + 1)
  assert.equal(sameFirst?.id, first.id)
  assert.ok(refreshedNodes.some((node) => node.name === 'second.md'))
})

test('revalidates every path segment before resolving MDV and Markdown capabilities', async (t) => {
  const { temporaryDirectory, root } = await fixture(t)
  const file = join(root, 'document.mdv')
  const externalFile = join(temporaryDirectory, 'outside.mdv')
  await Promise.all([
    writeFile(file, new Uint8Array()),
    writeFile(join(root, 'context.md'), '# Context\n'),
    writeFile(externalFile, new Uint8Array()),
  ])
  const { workspace, view } = await FolderWorkspace.open(root)
  const nodes = flatten(view.root)
  const mdv = nodes.find((node) => node.name === 'document.mdv')
  const markdown = nodes.find((node) => node.name === 'context.md')
  assert.ok(mdv)
  assert.ok(markdown)
  assert.deepEqual(await workspace.resolveDocument(mdv.id), {
    kind: 'mdv',
    path: await realpath(file),
  })
  assert.deepEqual(await workspace.resolveDocument(markdown.id), {
    kind: 'markdown',
    path: await realpath(join(root, 'context.md')),
  })

  await assert.rejects(workspace.resolveDocument(view.root.id), (error) => error?.code === 'STALE_ENTRY')
  await assert.rejects(workspace.resolveDocument('n_00000000000000000000000000000000'), (error) => (
    error?.code === 'STALE_ENTRY'
  ))

  await rm(file)
  await symlink(externalFile, file)
  await assert.rejects(workspace.resolveDocument(mdv.id), (error) => error?.code === 'STALE_ENTRY')
})

test('marks a depth-limited tree as incomplete', async (t) => {
  const { root } = await fixture(t)
  let directory = root
  for (let index = 0; index < 17; index += 1) {
    directory = join(directory, `level-${String(index).padStart(2, '0')}`)
    await mkdir(directory)
  }
  await writeFile(join(directory, 'too-deep.mdv'), new Uint8Array())

  const { view } = await FolderWorkspace.open(root)
  const nodes = flatten(view.root)

  assert.equal(view.incomplete, true)
  assert.ok(nodes.some((node) => node.kind === 'directory' && node.truncated === true))
  assert.equal(nodes.some((node) => node.name === 'too-deep.mdv'), false)
})

test('keeps the last complete snapshot when refresh fails', async (t) => {
  const { temporaryDirectory, root } = await fixture(t)
  await writeFile(join(root, 'stable.mdv'), new Uint8Array())
  const { workspace, view } = await FolderWorkspace.open(root)
  const moved = join(temporaryDirectory, 'moved')
  const outside = join(temporaryDirectory, 'outside')
  await rename(root, moved)
  await mkdir(outside)
  await writeFile(join(outside, 'must-not-leak.mdv'), new Uint8Array())
  await symlink(outside, root)

  await assert.rejects(workspace.refresh(), (error) => error?.code === 'ACCESS_DENIED')
  assert.equal(workspace.view, view)
  assert.equal(JSON.stringify(workspace.view).includes('must-not-leak'), false)
})

test('creates Markdown files and folders relative to the clicked workspace item', async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'existing.md'), '# Existing\n')
  const { workspace, view } = await FolderWorkspace.open(root)
  const existing = flatten(view.root).find((node) => node.name === 'existing.md')
  assert.ok(existing)

  const siblingFolder = await workspace.createDirectory(existing.id, 'Sibling')
  assert.equal(siblingFolder.view.revision, view.revision + 1)
  assert.equal(flatten(siblingFolder.view.root).some((node) => node.name === 'Sibling'), true)

  const nestedFile = await workspace.createMarkdownFile(siblingFolder.nodeId, 'draft')
  const draft = flatten(nestedFile.view.root).find((node) => node.id === nestedFile.nodeId)
  assert.deepEqual(draft && { kind: draft.kind, name: draft.name }, {
    kind: 'markdown',
    name: 'draft.md',
  })
  assert.equal(await readFile(join(root, 'Sibling', 'draft.md'), 'utf8'), '')

  const renamed = await workspace.renameEntry(nestedFile.nodeId, 'finished')
  const finished = flatten(renamed.view.root).find((node) => node.id === renamed.nodeId)
  assert.deepEqual(finished && { kind: finished.kind, name: finished.name }, {
    kind: 'markdown',
    name: 'finished.md',
  })
  assert.equal(await readFile(join(root, 'Sibling', 'finished.md'), 'utf8'), '')
  await assert.rejects(workspace.resolveDocument(nestedFile.nodeId), (error) => error?.code === 'STALE_ENTRY')
})

test('duplicates Markdown with a collision-safe sibling name but rejects MDV identity copies', async (t) => {
  const { root } = await fixture(t)
  await Promise.all([
    writeFile(join(root, 'note.md'), '# Original\n'),
    writeFile(join(root, 'package.mdv'), new Uint8Array()),
  ])
  const { workspace, view } = await FolderWorkspace.open(root)
  const markdown = flatten(view.root).find((node) => node.name === 'note.md')
  const mdv = flatten(view.root).find((node) => node.name === 'package.mdv')
  assert.ok(markdown)
  assert.ok(mdv)

  const first = await workspace.duplicateMarkdown(markdown.id)
  const second = await workspace.duplicateMarkdown(markdown.id)
  assert.equal(flatten(first.view.root).some((node) => node.name === 'note copy.md'), true)
  assert.equal(flatten(second.view.root).some((node) => node.name === 'note copy 2.md'), true)
  assert.equal(await readFile(join(root, 'note copy.md'), 'utf8'), '# Original\n')
  assert.equal(await readFile(join(root, 'note copy 2.md'), 'utf8'), '# Original\n')
  await assert.rejects(
    workspace.duplicateMarkdown(mdv.id),
    (error) => error?.code === 'INVALID_ARGUMENT',
  )
})

test('rejects unsafe names, collisions, root renames, and stale symlink parents', async (t) => {
  const { temporaryDirectory, root } = await fixture(t)
  const nested = join(root, 'Nested')
  const moved = join(temporaryDirectory, 'moved-nested')
  const external = join(temporaryDirectory, 'external')
  await Promise.all([
    mkdir(nested),
    mkdir(external),
    writeFile(join(root, 'taken.md'), '# Taken\n'),
  ])
  const { workspace, view } = await FolderWorkspace.open(root)
  const nestedNode = flatten(view.root).find((node) => node.name === 'Nested')
  const taken = flatten(view.root).find((node) => node.name === 'taken.md')
  assert.ok(nestedNode)
  assert.ok(taken)

  for (const name of ['../escape', '.hidden', 'wrong.txt', 'bad/name']) {
    await assert.rejects(
      async () => workspace.createMarkdownFile(view.root.id, name),
      (error) => error?.code === 'INVALID_ARGUMENT',
    )
  }
  await assert.rejects(
    workspace.createMarkdownFile(view.root.id, 'taken.md'),
    (error) => error?.code === 'ALREADY_EXISTS',
  )
  await assert.rejects(
    workspace.renameEntry(view.root.id, 'renamed-root'),
    (error) => error?.code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    workspace.renameEntry(taken.id, 'wrong.mdv'),
    (error) => error?.code === 'INVALID_ARGUMENT',
  )

  await rename(nested, moved)
  await symlink(external, nested)
  await assert.rejects(
    workspace.createMarkdownFile(nestedNode.id, 'outside'),
    (error) => error?.code === 'STALE_ENTRY',
  )
  await assert.rejects(realpath(join(external, 'outside.md')), (error) => error?.code === 'ENOENT')
})

test('serializes mutation snapshots ahead of later refreshes', async (t) => {
  const { root } = await fixture(t)
  const { workspace, view } = await FolderWorkspace.open(root)

  const mutationPromise = workspace.createMarkdownFile(view.root.id, 'queued')
  const refreshPromise = workspace.refresh()
  const [mutation, refreshed] = await Promise.all([mutationPromise, refreshPromise])

  assert.equal(mutation.view.revision, view.revision + 1)
  assert.equal(refreshed.revision, mutation.view.revision + 1)
  assert.equal(flatten(refreshed.root).some((node) => node.name === 'queued.md'), true)
})
