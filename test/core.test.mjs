import assert from 'node:assert/strict'
import test from 'node:test'

import { hydrateArchiveIndex } from '../dist/core/hydrate.js'
import { GraphValidationError } from '../dist/core/invariants.js'
import {
  getChildren,
  getDocumentReference,
  getHistory,
  listDocumentsUsingReference,
} from '../dist/core/queries.js'

const R1 = `v_${'1'.repeat(32)}`
const R2 = `v_${'2'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const D2 = `v_${'b'.repeat(32)}`

test('generation zero with no versions or heads is valid', () => {
  const state = hydrateArchiveIndex(index())

  assert.equal(state.manifest.generation, 0)
  assert.equal(state.referenceHead, null)
  assert.equal(state.documentHead, null)
  assert.equal(state.references.size, 0)
  assert.equal(state.documents.size, 0)
})

test('builds parent and reverse bind indexes without writing binds to Reference', () => {
  const state = hydrateArchiveIndex(index({
    referenceHead: R2,
    documentHead: D2,
    referenceVersions: [
      located(meta(R1, null, '2026-09-06T01:00:00Z')),
      located(meta(R2, R1, '2026-09-06T02:00:00Z')),
    ],
    documentVersions: [
      located({ ...meta(D1, null, '2026-09-06T03:00:00Z'), referenceVersion: R1 }),
      located({ ...meta(D2, D1, '2026-09-06T04:00:00Z'), referenceVersion: R2 }),
    ],
  }))

  assert.deepEqual(getHistory(state, 'document').map((version) => version.id), [D2, D1])
  assert.deepEqual(getChildren(state, 'reference', R1).map((version) => version.id), [R2])
  assert.equal(getDocumentReference(state, D1)?.id, R1)
  assert.deepEqual(listDocumentsUsingReference(state, R1).map((version) => version.id), [D1])
})

test('orders children by timestamp instant rather than timestamp spelling', () => {
  const R3 = `v_${'3'.repeat(32)}`
  const state = hydrateArchiveIndex(index({
    referenceHead: R1,
    referenceVersions: [
      located(meta(R1, null, '2026-09-06T00:00:00Z')),
      located(meta(R2, R1, '2026-09-06T10:00:00+08:00')),
      located(meta(R3, R1, '2026-09-06T03:00:00Z')),
    ],
  }))

  assert.deepEqual(getChildren(state, 'reference', R1).map((version) => version.id), [R2, R3])
})

test('allows an unbound Document history with an empty Reference tree', () => {
  const state = hydrateArchiveIndex(index({
    documentHead: D2,
    documentVersions: [
      located({ ...meta(D1, null, '2026-09-06T03:00:00Z'), referenceVersion: null }),
      located({ ...meta(D2, D1, '2026-09-06T04:00:00Z'), referenceVersion: null }),
    ],
  }))

  assert.equal(getDocumentReference(state, D2), null)
  assert.deepEqual(getHistory(state, 'document').map((version) => version.id), [D2, D1])
})

test('rejects cross-tree parents and parent cycles', () => {
  assertGraphError(index({
    referenceHead: R1,
    documentHead: D1,
    referenceVersions: [located(meta(R1, D1, '2026-09-06T01:00:00Z'))],
    documentVersions: [
      located({ ...meta(D1, null, '2026-09-06T02:00:00Z'), referenceVersion: R1 }),
    ],
  }), 'other tree')

  assertGraphError(index({
    referenceHead: R2,
    referenceVersions: [
      located(meta(R1, R2, '2026-09-06T01:00:00Z')),
      located(meta(R2, R1, '2026-09-06T02:00:00Z')),
    ],
  }), 'parent cycle')
})

function assertGraphError(value, message) {
  assert.throws(
    () => hydrateArchiveIndex(value),
    (error) => {
      assert.ok(error instanceof GraphValidationError)
      assert.match(error.message, new RegExp(message))
      return true
    },
  )
}

function index(overrides = {}) {
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
    referenceVersions: [],
    documentVersions: [],
    ...overrides,
  }
}

function located(value) {
  return { directoryId: value.id, meta: value }
}

function meta(id, parent, createdAt) {
  return {
    schemaVersion: 1,
    id,
    parent,
    createdAt,
    actor: { type: 'agent', id: 'test-agent' },
    summary: `Commit ${id}`,
    contentSha256: '0'.repeat(64),
    contentBytes: 0,
  }
}
