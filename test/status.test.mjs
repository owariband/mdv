import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { computeDocumentStatus } from '../dist/core/status.js'

const R1 = `v_${'1'.repeat(32)}`
const R2 = `v_${'2'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const CREATED_AT = '2026-09-08T12:00:00Z'
const ACTOR = { type: 'agent', id: 'test-agent' }

test('empty working copies without HEADs are clean and have no document relation', () => {
  const status = computeDocumentStatus(state(), bytes(''), bytes(''))

  assert.deepEqual(status, {
    reference: { head: null, dirty: false },
    document: { head: null, dirty: false },
    referenceRelation: { kind: 'no-document-head' },
  })
  assert.equal(Object.isFrozen(status), true)
  assert.equal(Object.isFrozen(status.reference), true)
  assert.equal(Object.isFrozen(status.document), true)
  assert.equal(Object.isFrozen(status.referenceRelation), true)
})

test('non-empty working copies without HEADs are dirty independently', () => {
  const referenceDirty = computeDocumentStatus(state(), bytes('# Draft\n'), bytes(''))
  const documentDirty = computeDocumentStatus(state(), bytes(''), bytes('# Draft\n'))

  assert.equal(referenceDirty.reference.dirty, true)
  assert.equal(referenceDirty.document.dirty, false)
  assert.equal(documentDirty.reference.dirty, false)
  assert.equal(documentDirty.document.dirty, true)
})

test('working copies are clean only when both byte length and SHA-256 match HEAD', () => {
  const referenceContent = bytes('# Reference\n')
  const documentContent = bytes('# Document\n')
  const latest = state({
    referenceHead: R1,
    documentHead: D1,
    references: new Map([[R1, reference(R1, null, referenceContent)]]),
    documents: new Map([[D1, document(D1, null, documentContent, R1)]]),
  })

  const clean = computeDocumentStatus(latest, referenceContent, documentContent)
  assert.deepEqual(clean.reference, { head: R1, dirty: false })
  assert.deepEqual(clean.document, { head: D1, dirty: false })

  const wrongReferenceLength = state({
    ...latest,
    references: new Map([[
      R1,
      { ...latest.references.get(R1), contentBytes: referenceContent.byteLength + 1 },
    ]]),
  })
  const wrongDocumentHash = state({
    ...latest,
    documents: new Map([[
      D1,
      { ...latest.documents.get(D1), contentSha256: 'f'.repeat(64) },
    ]]),
  })

  assert.equal(computeDocumentStatus(
    wrongReferenceLength,
    referenceContent,
    documentContent,
  ).reference.dirty, true)
  assert.equal(computeDocumentStatus(
    wrongDocumentHash,
    referenceContent,
    documentContent,
  ).document.dirty, true)
})

test('reports an unbound relation for a Document HEAD with a null bind', () => {
  const content = bytes('# Document\n')
  const latest = state({
    documentHead: D1,
    documents: new Map([[D1, document(D1, null, content, null)]]),
  })

  assert.deepEqual(
    computeDocumentStatus(latest, bytes(''), content).referenceRelation,
    { kind: 'unbound' },
  )
})

test('reports an aligned relation when the Document bind equals Reference HEAD', () => {
  const referenceContent = bytes('# Reference\n')
  const documentContent = bytes('# Document\n')
  const latest = state({
    referenceHead: R1,
    documentHead: D1,
    references: new Map([[R1, reference(R1, null, referenceContent)]]),
    documents: new Map([[D1, document(D1, null, documentContent, R1)]]),
  })

  assert.deepEqual(
    computeDocumentStatus(latest, referenceContent, documentContent).referenceRelation,
    { kind: 'aligned', referenceVersion: R1 },
  )
})

test('reports drift with the current Reference HEAD', () => {
  const r1Content = bytes('# R1\n')
  const r2Content = bytes('# R2\n')
  const documentContent = bytes('# Document\n')
  const latest = state({
    referenceHead: R2,
    documentHead: D1,
    references: new Map([
      [R1, reference(R1, null, r1Content)],
      [R2, reference(R2, R1, r2Content)],
    ]),
    documents: new Map([[D1, document(D1, null, documentContent, R1)]]),
  })

  assert.deepEqual(
    computeDocumentStatus(latest, r2Content, documentContent).referenceRelation,
    { kind: 'drifted', boundReference: R1, currentReference: R2 },
  )
})

test('reports drift when a bound Reference exists but Reference HEAD is absent', () => {
  const r1Content = bytes('# R1\n')
  const documentContent = bytes('# Document\n')
  const latest = state({
    documentHead: D1,
    references: new Map([[R1, reference(R1, null, r1Content)]]),
    documents: new Map([[D1, document(D1, null, documentContent, R1)]]),
  })

  assert.deepEqual(
    computeDocumentStatus(latest, bytes(''), documentContent).referenceRelation,
    { kind: 'drifted', boundReference: R1, currentReference: null },
  )
})

function state(overrides = {}) {
  return {
    manifest: {
      format: 'mdv',
      formatVersion: '0.1',
      documentId: `d_${'0'.repeat(32)}`,
      generation: 0,
      markdownProfile: 'gfm',
    },
    referenceHead: null,
    documentHead: null,
    references: new Map(),
    documents: new Map(),
    referenceChildren: new Map(),
    documentChildren: new Map(),
    documentsByReference: new Map(),
    ...overrides,
  }
}

function reference(id, parent, content) {
  return {
    kind: 'reference',
    id,
    parent,
    createdAt: CREATED_AT,
    actor: ACTOR,
    summary: `Reference ${id}`,
    contentSha256: sha256(content),
    contentBytes: content.byteLength,
  }
}

function document(id, parent, content, referenceVersion) {
  return {
    kind: 'document',
    id,
    parent,
    createdAt: CREATED_AT,
    actor: ACTOR,
    summary: `Document ${id}`,
    contentSha256: sha256(content),
    contentBytes: content.byteLength,
    referenceVersion,
  }
}

function bytes(markdown) {
  return Buffer.from(markdown, 'utf8')
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}
