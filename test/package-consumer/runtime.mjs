import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as api from '@mdv/core'

assert.deepEqual(Object.keys(api).sort(), [
  'MDV_FORMAT', 'MDV_FORMAT_VERSION', 'MdvError', 'createMdv', 'openMdv', 'parseMdv', 'verifyMdv',
])
assert.equal(api.MDV_FORMAT_VERSION, '0.1')
await assert.rejects(import('@mdv/core/dist/archive/reader.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
const directory = await realpath(await mkdtemp(join(tmpdir(), 'mdv consumer 中文 ')))
try {
  const emptyPath = join(directory, 'ordinary-new-file.mdv')
  await writeFile(emptyPath, '')
  const empty = await api.openMdv(emptyPath)
  assert.equal((await readFile(emptyPath)).length, 0)
  const firstSave = await empty.saveDocument({ markdown: '# First edit', expectedGeneration: 0 })
  assert.equal(firstSave.listVersions().length, 0)
  assert.equal(firstSave.manifest.documentId, empty.manifest.documentId)
  assert.equal((await api.verifyMdv(emptyPath, { mode: 'full' })).valid, true)
  const path = join(directory, 'notes with spaces.mdv')
  let document = await api.createMdv(path)
  document = await document.saveReference({ markdown: '# 要求\r\n', expectedGeneration: 0 })
  const reference = await document.commitReference({
    expectedGeneration: 1, actor: { type: 'human' }, summary: 'Reference',
  })
  assert.equal(reference.created, true)
  document = reference.document
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=', 'base64')
  const image = await document.importManagedResource({ bytes: png })
  assert.equal(document.manifest.generation, 2)
  const markdown = `# 成品 🐱\r\n\r\n![image](${image})\r\n`
  document = await document.saveDocument({ markdown, expectedGeneration: 2 })
  const committed = await document.commitDocument({
    expectedGeneration: 3, referenceVersion: reference.version,
    actor: { type: 'agent' }, summary: 'Document',
  })
  assert.equal(committed.created, true)
  document = await api.openMdv(path)
  assert.equal(await document.readDocumentText(), markdown)
  assert.equal(document.traceDocument(committed.version).reference.id, reference.version)
  assert.equal((await document.getStatus()).referenceRelation.kind, 'aligned')
  assert.equal((await document.getStatus()).document.dirty, false)
  const spec = { tree: 'document', kind: 'version', version: committed.version }
  assert.equal((await document.diff(spec, { tree: 'document', kind: 'working-copy' })).hunks.length, 0)
  document = await document.saveDocument({ markdown: '# draft', expectedGeneration: 4 })
  await assert.rejects(committed.document.saveDocument({ markdown: 'stale', expectedGeneration: 4 }),
    (error) => error instanceof api.MdvError && error.code === 'CONFLICT')
  document = await document.checkoutDocument({
    version: committed.version, expectedGeneration: 5, discardChanges: true,
  })
  assert.equal(await document.readDocumentText(), markdown)
  assert.deepEqual(Buffer.from((await document.readManagedResource(image)).bytes), png)
  assert.equal(await document.resolveManagedResource(image), join(directory, image))
  await document.verifyManagedResource(image)
  const bytes = await readFile(path)
  const memory = await api.parseMdv(bytes)
  assert.equal('saveDocument' in memory, false)
  assert.equal('resolveManagedResource' in memory, false)
  assert.equal(await memory.readVersionText(committed.version), markdown)
  const located = await api.parseMdv(bytes, { baseDirectory: directory })
  assert.equal('importManagedResource' in located, false)
  await located.verifyManagedResource(image)
  const report = await api.verifyMdv(path, { mode: 'full' })
  assert.equal(report.valid, true)
  assert.equal(report.complete, true)
  console.log('Isolated tarball runtime: read/write/trace/diff/verify/resources passed.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
