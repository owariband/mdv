import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import { MdvError, openMdv, parseMdv } from '../dist/index.js'

const FIXTURE_PATH = resolve('fixtures/valid/bound-history.mdv')
const FIXTURE_DIRECTORY = dirname(FIXTURE_PATH)
const R1 = `v_${'1'.repeat(32)}`
const R2 = `v_${'2'.repeat(32)}`
const R3 = `v_${'3'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const D2 = `v_${'b'.repeat(32)}`

test('opens paths and parses bytes with explicit location semantics', async () => {
  const document = await openMdv('fixtures/valid/bound-history.mdv')

  assert.equal(document.packagePath, FIXTURE_PATH)
  assert.equal(document.baseDirectory, FIXTURE_DIRECTORY)
  assert.deepEqual(document.manifest, {
    format: 'mdv',
    formatVersion: '0.1',
    documentId: `d_${'0'.repeat(32)}`,
    generation: 5,
    markdownProfile: 'gfm',
  })
  assert.deepEqual(document.referenceTree, { head: R2 })
  assert.deepEqual(document.documentTree, { head: D2 })
  assert.deepEqual(document.warnings, [
    {
      code: 'UNKNOWN_FIELD',
      entry: 'manifest.json',
      path: '$/fixtureExtension',
      message: 'field is not defined by MDV 0.1',
    },
    {
      code: 'UNKNOWN_FIELD',
      entry: `ref_tree/versions/${R3}/meta.json`,
      path: '$/fixtureExtension',
      message: 'field is not defined by MDV 0.1',
    },
  ])

  const bytes = await readFile(FIXTURE_PATH)
  const snapshot = await parseMdv(bytes, { baseDirectory: 'fixtures' })
  assert.equal(snapshot.packagePath, null)
  assert.equal(snapshot.baseDirectory, resolve('fixtures'))
  assert.equal((await parseMdv(bytes)).baseDirectory, null)
})

test('queries version history, children, binds, and traces through the public API', async () => {
  const document = await openMdv(FIXTURE_PATH)

  assert.deepEqual(document.listVersions().map(({ id }) => id), [R1, R2, R3, D1, D2])
  assert.deepEqual(
    document.listVersions({ tree: 'reference' }).map(({ id }) => id),
    [R1, R2, R3],
  )
  assert.deepEqual(document.listVersions({ tree: 'document' }).map(({ id }) => id), [D1, D2])
  assert.deepEqual(document.getHistory('reference').map(({ id }) => id), [R2, R1])
  assert.deepEqual(document.getHistory('reference', R3).map(({ id }) => id), [R3, R1])
  assert.deepEqual(document.getHistory('document').map(({ id }) => id), [D2, D1])
  assert.deepEqual(document.getChildren('reference', R1).map(({ id }) => id), [R2, R3])

  assert.equal(document.getDocumentReference(D1), R1)
  assert.equal(document.getDocumentReference(D2), R2)
  assert.deepEqual(document.listDocumentsUsingReference(R1).map(({ id }) => id), [D1])

  const documentTrace = document.traceDocument(D2)
  assert.equal(documentTrace.document.id, D2)
  assert.deepEqual(documentTrace.ancestry.map(({ id }) => id), [D2, D1])
  assert.equal(documentTrace.reference?.id, R2)

  const referenceTrace = document.traceReference(R2)
  assert.equal(referenceTrace.reference.id, R2)
  assert.deepEqual(referenceTrace.ancestry.map(({ id }) => id), [R2, R1])
  assert.deepEqual(referenceTrace.usedByDocuments.map(({ id }) => id), [D2])
})

test('reads working copies and committed versions as bytes and text', async () => {
  const document = await openMdv(FIXTURE_PATH)
  const reference = await document.readReference()
  const current = await document.readDocument()

  assert.equal(new TextDecoder().decode(reference.bytes), '# Reference two\n')
  assert.equal(reference.markdownProfile, 'gfm')
  assert.equal(reference.baseDirectory, FIXTURE_DIRECTORY)
  assert.deepEqual(reference.origin, {
    tree: 'reference',
    kind: 'working-copy',
    version: null,
  })
  assert.equal(new TextDecoder().decode(current.bytes), '# Document two\n')
  assert.deepEqual(current.origin, {
    tree: 'document',
    kind: 'working-copy',
    version: null,
  })
  assert.equal(await document.readReferenceText(), '# Reference two\n')
  assert.equal(await document.readDocumentText(), '# Document two\n')
  assert.equal(new TextDecoder().decode(await document.readVersionBytes(R1)), '# Reference one\n')
  assert.equal(await document.readVersionText(D1), '# Document one\n')
})

test('returned arrays and bytes cannot mutate snapshot state', async () => {
  const document = await openMdv(FIXTURE_PATH)
  const versions = document.listVersions()
  assert.throws(() => versions.push(versions[0]), TypeError)
  assert.deepEqual(document.listVersions().map(({ id }) => id), [R1, R2, R3, D1, D2])

  const workingCopy = await document.readDocument()
  workingCopy.bytes.fill(0)
  assert.equal(await document.readDocumentText(), '# Document two\n')

  const versionBytes = await document.readVersionBytes(D2)
  versionBytes.fill(0)
  assert.equal(await document.readVersionText(D2), '# Document two\n')
})

test('maps storage and graph failures to stable public errors', async () => {
  await assert.rejects(
    openMdv('fixtures/missing.mdv'),
    (error) => isMdvError(error, 'NOT_FOUND'),
  )

  await assert.rejects(
    parseMdv(Buffer.from('not a ZIP archive')),
    (error) => isMdvError(error, 'INVALID_ARCHIVE'),
  )

  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
  await assert.rejects(
    parseMdv(emptyZip),
    (error) => isMdvError(error, 'NOT_MDV'),
  )

  await assert.rejects(
    openMdv('fixtures/invalid/invalid-manifest.mdv'),
    (error) => isMdvError(error, 'NOT_MDV'),
  )

  await assert.rejects(
    openMdv('fixtures/invalid/unsupported-version.mdv'),
    (error) => isMdvError(error, 'UNSUPPORTED_FORMAT'),
  )

  await assert.rejects(
    openMdv('fixtures/invalid/malformed-version.mdv'),
    (error) => isMdvError(error, 'INVALID_MANIFEST'),
  )

  await assert.rejects(
    openMdv('fixtures/invalid/dangling-reference.mdv'),
    (error) => isMdvError(error, 'INVALID_GRAPH'),
  )

  await assert.rejects(
    openMdv('fixtures/invalid/markdown-bom.mdv'),
    (error) => isMdvError(error, 'INVALID_UTF8'),
  )

  const mismatched = await openMdv('fixtures/invalid/content-hash-mismatch.mdv')
  await assert.rejects(
    mismatched.readVersionBytes(`v_${'4'.repeat(32)}`),
    (error) => isMdvError(error, 'INTEGRITY_MISMATCH'),
  )
})

function isMdvError(error, code) {
  assert.ok(error instanceof MdvError)
  assert.equal(error.code, code)
  return true
}
