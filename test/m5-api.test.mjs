import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { MdvError, createMdv, openMdv, verifyMdv } from '../dist/index.js'

const HUMAN = Object.freeze({ type: 'human', id: 'hypnos' })
const R1 = `v_${'1'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const D2 = `v_${'b'.repeat(32)}`

test('reports working-copy status and exact Reference drift without changing the model', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  let status = await document.getStatus()
  assert.deepEqual(status, {
    reference: { head: null, dirty: false },
    document: { head: null, dirty: false },
    referenceRelation: { kind: 'no-document-head' },
  })
  assert.equal(Object.isFrozen(status), true)
  assert.equal(Object.isFrozen(status.referenceRelation), true)

  document = await document.saveReference({
    markdown: '# Reference one\n',
    expectedGeneration: 0,
  })
  status = await document.getStatus()
  assert.equal(status.reference.dirty, true)
  assert.equal(status.document.dirty, false)

  const firstReference = await document.commitReference({
    expectedGeneration: 1,
    actor: HUMAN,
    summary: 'Reference one',
  })
  assert.equal(firstReference.created, true)
  document = firstReference.document

  document = await document.saveDocument({
    markdown: '# Document one\n',
    expectedGeneration: 2,
  })
  const firstDocument = await document.commitDocument({
    expectedGeneration: 3,
    actor: HUMAN,
    summary: 'Document one',
    referenceVersion: firstReference.version,
  })
  assert.equal(firstDocument.created, true)
  document = firstDocument.document

  status = await document.getStatus()
  assert.deepEqual(status.referenceRelation, {
    kind: 'aligned',
    referenceVersion: firstReference.version,
  })
  assert.equal(status.reference.dirty, false)
  assert.equal(status.document.dirty, false)

  document = await document.saveReference({
    markdown: '# Reference two\n',
    expectedGeneration: 4,
  })
  const secondReference = await document.commitReference({
    expectedGeneration: 5,
    actor: HUMAN,
    summary: 'Reference two',
  })
  assert.equal(secondReference.created, true)
  document = secondReference.document

  status = await document.getStatus()
  assert.deepEqual(status.referenceRelation, {
    kind: 'drifted',
    boundReference: firstReference.version,
    currentReference: secondReference.version,
  })

  document = await document.saveDocument({
    markdown: '# Document draft\n',
    expectedGeneration: 6,
  })
  status = await document.getStatus()
  assert.equal(status.document.dirty, true)
  assert.equal(document.manifest.generation, 7)
  assert.equal(document.documentTree.head, firstDocument.version)
})

test('keeps an explicitly unbound Document distinct from drift', async () => {
  const document = await openMdv('fixtures/valid/unbound-document.mdv')

  assert.deepEqual((await document.getStatus()).referenceRelation, { kind: 'unbound' })
})

test('reports a historical bind as drift when Reference HEAD is absent', async () => {
  const document = await openMdv('fixtures/valid/drifted-no-reference-head.mdv')

  assert.deepEqual((await document.getStatus()).referenceRelation, {
    kind: 'drifted',
    boundReference: `v_${'2'.repeat(32)}`,
    currentReference: null,
  })
})

test('reads and diffs any declared ContentSpec, including Document against Document', async () => {
  const packagePath = resolve('fixtures/valid/bound-history.mdv')
  const before = await readFile(packagePath)
  const document = await openMdv(packagePath)

  const oldDocument = await document.readContent({
    tree: 'document',
    kind: 'version',
    version: D1,
  })
  assert.equal(new TextDecoder().decode(oldDocument.bytes), '# Document one\n')
  assert.deepEqual(oldDocument.origin, {
    tree: 'document',
    kind: 'version',
    version: D1,
  })

  const workingReference = await document.readContent({
    tree: 'reference',
    kind: 'working-copy',
  })
  assert.equal(new TextDecoder().decode(workingReference.bytes), '# Reference two\n')

  const documentDiff = await document.diff(
    { tree: 'document', kind: 'version', version: D1 },
    { tree: 'document', kind: 'version', version: D2 },
  )
  assert.equal(documentDiff.hunks.length, 1)
  assert.deepEqual(
    documentDiff.hunks[0].lines.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: 'deletion', text: '# Document one\n' },
      { kind: 'addition', text: '# Document two\n' },
    ],
  )
  assert.match(documentDiff.unifiedText, new RegExp(`^--- document:${D1}`))
  assert.match(documentDiff.unifiedText, new RegExp(`\\n\\+\\+\\+ document:${D2}\\n`))
  assert.equal(Object.isFrozen(documentDiff), true)
  assert.equal(Object.isFrozen(documentDiff.hunks), true)
  assert.equal(Object.isFrozen(documentDiff.hunks[0].lines), true)

  const crossTree = await document.diff(
    { tree: 'reference', kind: 'version', version: R1 },
    { tree: 'document', kind: 'version', version: D1 },
  )
  assert.equal(crossTree.hunks.length, 1)

  assert.deepEqual(
    await document.diff(
      { tree: 'document', kind: 'working-copy' },
      { tree: 'document', kind: 'working-copy' },
    ),
    { hunks: [], unifiedText: '' },
  )

  await assert.rejects(
    document.readContent({ tree: 'reference', kind: 'version', version: D1 }),
    (error) => {
      assert.ok(isMdvError(error, 'NOT_FOUND'))
      assert.equal(error.details.reason, 'wrong-tree')
      return true
    },
  )
  await assert.rejects(
    document.diff(
      { tree: 'document', kind: 'version', version: D1 },
      { tree: 'document', kind: 'version', version: D2 },
      { limits: { maxInputBytes: 1 } },
    ),
    (error) => {
      assert.ok(isMdvError(error, 'LIMIT_EXCEEDED'))
      assert.equal(error.details.limit, 'maxInputBytes')
      return true
    },
  )
  await assert.rejects(
    document.diff(
      { tree: 'document', kind: 'version', version: D1 },
      { tree: 'document', kind: 'version', version: D2 },
      { contextLines: -1 },
    ),
    RangeError,
  )

  assert.deepEqual(await readFile(packagePath), before)
})

test('verifies valid, graph-invalid, content-corrupt, and unreadable sources at package root', async () => {
  const validPath = resolve('fixtures/valid/bound-history.mdv')
  const before = await readFile(validPath)
  const metadata = await verifyMdv(validPath)
  assert.deepEqual(
    { mode: metadata.mode, valid: metadata.valid, complete: metadata.complete },
    { mode: 'metadata', valid: true, complete: true },
  )
  assert.equal(Object.isFrozen(metadata), true)
  assert.equal(Object.isFrozen(metadata.issues), true)
  assert.equal(Object.isFrozen(metadata.warnings), true)

  const full = await verifyMdv(validPath, { mode: 'full' })
  assert.deepEqual(
    { mode: full.mode, valid: full.valid, complete: full.complete },
    { mode: 'full', valid: true, complete: true },
  )
  assert.deepEqual(await readFile(validPath), before)

  const graph = await verifyMdv('fixtures/invalid/dangling-reference.mdv')
  assert.equal(graph.valid, false)
  assert.equal(graph.complete, true)
  assert.ok(graph.issues.some(({ code }) => code === 'INVALID_GRAPH'))
  const fullGraph = await verifyMdv(
    'fixtures/invalid/dangling-reference.mdv',
    { mode: 'full' },
  )
  assert.equal(fullGraph.valid, false)
  assert.equal(fullGraph.complete, true)
  assert.ok(fullGraph.issues.some(({ code }) => code === 'INVALID_GRAPH'))

  const shallowCorrupt = await verifyMdv('fixtures/invalid/content-hash-mismatch.mdv')
  assert.equal(shallowCorrupt.valid, true)
  const deepCorrupt = await verifyMdv(
    'fixtures/invalid/content-hash-mismatch.mdv',
    { mode: 'full' },
  )
  assert.equal(deepCorrupt.valid, false)
  assert.equal(deepCorrupt.complete, true)
  assert.ok(deepCorrupt.issues.some(({ code }) => code === 'INTEGRITY_MISMATCH'))
  assert.ok(deepCorrupt.issues.every(Object.isFrozen))
  assert.ok(deepCorrupt.issues.every(({ details }) => Object.isFrozen(details)))

  const badZip = await verifyMdv(Buffer.from('not a ZIP archive'))
  assert.deepEqual(
    { valid: badZip.valid, complete: badZip.complete },
    { valid: false, complete: false },
  )
  assert.equal(badZip.issues[0]?.code, 'INVALID_ARCHIVE')

  await assert.rejects(
    verifyMdv('fixtures/missing.mdv'),
    (error) => isMdvError(error, 'NOT_FOUND'),
  )
  await assert.rejects(
    verifyMdv(resolve('fixtures')),
    (error) => isMdvError(error, 'IO_ERROR'),
  )

  const mutableBytes = await readFile(validPath)
  const pendingVerification = verifyMdv(mutableBytes, { mode: 'full' })
  mutableBytes.fill(0)
  assert.equal((await pendingVerification).valid, true)

  await assert.rejects(verifyMdv(validPath, { mode: 'deep' }), TypeError)
  await assert.rejects(verifyMdv(validPath, { maxIssues: 0 }), RangeError)
  await assert.rejects(
    verifyMdv(validPath, { limits: { maxEntries: 0 } }),
    RangeError,
  )
})

async function temporaryPackagePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-m5-api-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return join(directory, 'document.mdv')
}

function isMdvError(error, code) {
  assert.ok(error instanceof MdvError)
  assert.equal(error.code, code)
  return true
}
