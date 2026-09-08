import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { createMdv, MdvError, openMdv, parseMdv, verifyMdv } from '../dist/index.js'
import { GIF, JPEG_HEADER, PNG, WEBP } from './helpers/resources.mjs'

test('managed image operations expose paths and verified bytes without changing the archive', async (t) => {
  const { document, base, path } = await setup(t)
  const before = await readFile(path)
  const hash = createHash('sha256').update(PNG).digest('hex')
  const relativePath = await document.importManagedResource({ bytes: PNG, mediaType: 'image/png' })
  assert.equal(relativePath, `./.mdv-assets/${document.manifest.documentId}/${hash}.png`)
  assert.equal(await document.resolveManagedResource(relativePath), join(base, relativePath))
  assert.equal(await document.verifyManagedResource(relativePath), undefined)
  const content = await document.readManagedResource(relativePath.slice(2))
  assert.equal(Object.isFrozen(content), true)
  assert.equal(content.relativePath, relativePath)
  assert.equal(content.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(content.bytes), PNG)
  content.bytes.fill(0)
  assert.deepEqual(Buffer.from((await document.readManagedResource(relativePath)).bytes), PNG)
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual(await document.getStatus(), {
    reference: { head: null, dirty: false }, document: { head: null, dirty: false },
    referenceRelation: { kind: 'no-document-head' },
  })
  assert.equal(document.manifest.generation, 0)
  assert.equal(document.listVersions().length, 0)
})

test('all supported image types import and deduplicate through the package root', async (t) => {
  const { document } = await setup(t)
  for (const [bytes, mediaType] of [[PNG, 'image/png'], [JPEG_HEADER, 'image/jpeg'],
    [GIF, 'image/gif'], [WEBP, 'image/webp']]) {
    const first = await document.importManagedResource({ bytes })
    const second = await document.importManagedResource({ bytes, mediaType })
    assert.equal(first, second)
    const content = await document.readManagedResource(first)
    assert.equal(content.mediaType, mediaType)
    assert.deepEqual(Buffer.from(content.bytes), bytes)
  }
})

test('located memory snapshots support resource reads but never offer writes', async (t) => {
  const { document, base, path } = await setup(t)
  const relativePath = await document.importManagedResource({ bytes: PNG })
  const bytes = await readFile(path)
  const plain = await parseMdv(bytes)
  assert.equal('resolveManagedResource' in plain, false)
  assert.equal('readManagedResource' in plain, false)
  assert.equal('verifyManagedResource' in plain, false)
  assert.equal('importManagedResource' in plain, false)
  const located = await parseMdv(bytes, { baseDirectory: base })
  assert.equal(located.packagePath, null)
  assert.equal(located.baseDirectory, base)
  assert.equal('importManagedResource' in located, false)
  assert.equal('saveDocument' in located, false)
  assert.equal(Object.isFrozen(located), true)
  assert.equal(await located.resolveManagedResource(relativePath), join(base, relativePath))
  assert.deepEqual(Buffer.from((await located.readManagedResource(relativePath)).bytes), PNG)
  const missing = await parseMdv(bytes, { baseDirectory: join(base, 'missing') })
  await assert.rejects(missing.readManagedResource(relativePath), isError('NOT_FOUND'))
})

test('custom and external Markdown paths remain untouched and share the MDV directory as base', async (t) => {
  const initial = await setup(t)
  const customDirectory = join(initial.base, 'my own images')
  await mkdir(customDirectory)
  await writeFile(join(customDirectory, 'anything.svg'), '<svg/>')
  const markdown = [
    '![local](<./my own images/anything.svg>)', '![shared](../shared/cat.png)',
    `![absolute](${join(initial.base, 'outside.png')})`,
    '![remote](https://example.com/image.avif)', '',
  ].join('\n')
  let document = await initial.document.saveDocument({ markdown, expectedGeneration: 0 })
  document = await document.saveReference({ markdown, expectedGeneration: 1 })
  for (const source of [await document.readDocument(), await document.readReference()]) {
    assert.equal(Buffer.from(source.bytes).toString(), markdown)
    assert.equal(resolve(source.baseDirectory, './my own images/anything.svg'),
      join(customDirectory, 'anything.svg'))
  }
  await assert.rejects(document.resolveManagedResource('./my own images/anything.svg'), isError('INVALID_RESOURCE'))
  assert.equal(await document.readDocumentText(), markdown)
})

test('committed Document and Reference history keep their original image paths after later edits', async (t) => {
  let { document, path } = await setup(t)
  const imageA = await document.importManagedResource({ bytes: PNG })
  document = await document.saveReference({ markdown: `![ref](${imageA})`, expectedGeneration: 0 })
  const reference = await document.commitReference({
    expectedGeneration: 1, actor: { type: 'human' }, summary: 'Reference image',
  })
  document = reference.document
  document = await document.saveDocument({
    markdown: `![A](${imageA})`, expectedGeneration: document.manifest.generation,
  })
  const first = await document.commitDocument({
    expectedGeneration: document.manifest.generation, referenceVersion: reference.version,
    actor: { type: 'human' }, summary: 'Image A',
  })
  document = first.document
  const imageB = await document.importManagedResource({ bytes: GIF })
  document = await document.saveDocument({
    markdown: `![B](${imageB})`, expectedGeneration: document.manifest.generation,
  })
  const second = await document.commitDocument({
    expectedGeneration: document.manifest.generation, referenceVersion: reference.version,
    actor: { type: 'human' }, summary: 'Image B',
  })
  document = await second.document.checkoutDocument({
    version: first.version, expectedGeneration: second.document.manifest.generation,
  })
  assert.equal(await document.readDocumentText(), `![A](${imageA})`)
  assert.equal(await document.readVersionText(second.version), `![B](${imageB})`)
  assert.equal(document.traceDocument(first.version).reference.id, reference.version)
  assert.deepEqual(Buffer.from((await document.readManagedResource(imageA)).bytes), PNG)
  assert.deepEqual(Buffer.from((await document.readManagedResource(imageB)).bytes), GIF)
  assert.equal((await verifyMdv(path, { mode: 'full' })).valid, true)
})

test('resource inputs and options are snapshotted before asynchronous work', async (t) => {
  const { document } = await setup(t)
  const input = { bytes: Buffer.from(PNG), mediaType: 'image/png' }
  const options = { maxBytes: PNG.length }
  const importing = document.importManagedResource(input, options)
  input.bytes.fill(0)
  input.bytes = GIF
  input.mediaType = 'image/gif'
  options.maxBytes = 1
  const path = await importing
  const readOptions = { maxBytes: PNG.length }
  const reading = document.readManagedResource(path, readOptions)
  readOptions.maxBytes = 1
  assert.deepEqual(Buffer.from((await reading).bytes), PNG)
})

test('invalid media, paths, options and foreign resources produce actionable errors without writing', async (t) => {
  const { document, base } = await setup(t)
  for (const input of [null, {}, { bytes: 'png' }, { bytes: PNG, mediaType: 1 }]) {
    await assert.rejects(document.importManagedResource(input), TypeError)
  }
  for (const input of [{ bytes: Buffer.from('<svg/>') }, { bytes: PNG, mediaType: 'image/jpeg' }]) {
    await assert.rejects(document.importManagedResource(input), isError('INVALID_RESOURCE'))
  }
  await assert.rejects(document.importManagedResource({ bytes: PNG }, { maxBytes: PNG.length - 1 }),
    isError('LIMIT_EXCEEDED'))
  await assert.rejects(document.importManagedResource({ bytes: PNG }, { maxBytes: -1 }), RangeError)
  assert.deepEqual(await readdir(base), ['example.mdv'])
  const path = await document.importManagedResource({ bytes: PNG })
  await assert.rejects(document.readManagedResource(path, { maxBytes: PNG.length - 1 }), isError('LIMIT_EXCEEDED'))
  await assert.rejects(document.verifyManagedResource(path, { maxBytes: 0 }), RangeError)
  await assert.rejects(document.resolveManagedResource(null), TypeError)
  const foreign = path.replace(document.manifest.documentId, `d_${'f'.repeat(32)}`)
  for (const candidate of ['../outside.png', `${path}\n`, foreign]) {
    await assert.rejects(document.resolveManagedResource(candidate), isError('INVALID_RESOURCE'))
    await assert.rejects(document.readManagedResource(candidate), isError('INVALID_RESOURCE'))
    await assert.rejects(document.verifyManagedResource(candidate), isError('INVALID_RESOURCE'))
  }
})

test('missing or modified images do not invalidate the MDV archive', async (t) => {
  const { document, base, path } = await setup(t)
  const image = await document.importManagedResource({ bytes: PNG })
  await writeFile(join(base, image), GIF)
  await assert.rejects(document.verifyManagedResource(image), isError('INTEGRITY_MISMATCH'))
  await unlink(join(base, image))
  await assert.rejects(document.readManagedResource(image), isError('NOT_FOUND'))
  await assert.rejects(document.verifyManagedResource(image), isError('NOT_FOUND'))
  assert.equal((await verifyMdv(path, { mode: 'full' })).valid, true)
  assert.equal((await openMdv(path)).manifest.documentId, document.manifest.documentId)
})

test('imports tolerate a stale generation while later Markdown saves still use CAS', async (t) => {
  const { document, base, path } = await setup(t)
  await document.saveDocument({ markdown: '# A newer edit', expectedGeneration: 0 })
  const before = await readFile(path)
  const image = await document.importManagedResource({ bytes: PNG })
  await assert.rejects(document.saveDocument({ markdown: `![stale](${image})`, expectedGeneration: 0 }),
    isError('CONFLICT'))
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual(await readFile(join(base, image)), PNG)
})

test('resource import rejects replacement documents and missing document paths', async (t) => {
  const { document, base, path } = await setup(t)
  const replacement = join(base, 'replacement.mdv')
  await createMdv(replacement)
  await rename(replacement, path)
  await assert.rejects(document.importManagedResource({ bytes: PNG }), isError('CONFLICT'))
  assert.deepEqual(await readdir(base), ['example.mdv'])
  await unlink(path)
  await assert.rejects(document.importManagedResource({ bytes: PNG }), isError('NOT_FOUND'))
})

test('moving the MDV and its sidecar preserves relative references', async (t) => {
  const { document, base, path } = await setup(t)
  const image = await document.importManagedResource({ bytes: PNG })
  const destination = join(base, 'moved')
  await mkdir(destination)
  const movedPath = join(destination, 'renamed.mdv')
  await rename(path, movedPath)
  const moved = await openMdv(movedPath)
  await assert.rejects(moved.readManagedResource(image), isError('NOT_FOUND'))
  await rename(join(base, '.mdv-assets'), join(destination, '.mdv-assets'))
  assert.equal(await moved.resolveManagedResource(image), join(destination, image))
  assert.deepEqual(Buffer.from((await moved.readManagedResource(image)).bytes), PNG)
})

test('retargeting a parent alias rejects resource operations on the old file handle', async (t) => {
  const { base } = await setup(t)
  const first = join(base, 'first')
  const second = join(base, 'second')
  const alias = join(base, 'alias')
  await mkdir(first)
  await mkdir(second)
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const document = await createMdv(join(alias, 'alias.mdv'))
  const image = await document.importManagedResource({ bytes: PNG })
  assert.equal(await document.resolveManagedResource(image), join(first, image))
  await unlink(alias)
  await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(document.importManagedResource({ bytes: GIF }), isError('CONFLICT'))
  await assert.rejects(document.readManagedResource(image), isError('CONFLICT'))
  assert.deepEqual(await readdir(second), [])
})

function isError(code) {
  return (error) => {
    assert.ok(error instanceof MdvError)
    assert.equal(error.code, code)
    assert.equal(Object.isFrozen(error.details), true)
    return true
  }
}

async function setup(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mdv-resource-api-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const path = join(base, 'example.mdv')
  return { base, path, document: await createMdv(path) }
}
