import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
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
