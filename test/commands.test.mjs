import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  planCheckout,
  planDocumentCommit,
  planReferenceCommit,
  VersionIdCollisionError,
  VersionSelectionError,
  WorkingCopyDirtyError,
} from '../dist/core/commands.js'

const R1 = `v_${'1'.repeat(32)}`
const R2 = `v_${'2'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const D2 = `v_${'b'.repeat(32)}`
const CREATED_AT = '2026-09-07T12:00:00Z'
const ACTOR = { type: 'agent', id: 'test-agent' }

test('first Reference commit appends a root version even when the working copy is empty', () => {
  const content = bytes('')
  const plan = planReferenceCommit(commitInput(state(), content, R1))

  assert.equal(plan.kind, 'append')
  assert.equal(plan.tree, 'reference')
  assert.equal(plan.version.id, R1)
  assert.equal(plan.version.parent, null)
  assert.equal(plan.version.contentSha256, sha256(content))
  assert.equal(plan.version.contentBytes, 0)
  assert.equal(plan.content, content)
})

test('Reference commit reports no changes when the working-copy hash matches HEAD', () => {
  const content = bytes('# Reference\n')
  const current = reference(R1, null, content)
  const plan = planReferenceCommit(commitInput(state({
    referenceHead: R1,
    references: new Map([[R1, current]]),
  }), content, R2))

  assert.deepEqual(plan, { kind: 'no-changes', tree: 'reference' })
})

test('Reference commit appends to the current HEAD and records exact content metadata', () => {
  const oldContent = bytes('# Before\n')
  const content = bytes('# After\n')
  const plan = planReferenceCommit(commitInput(state({
    referenceHead: R1,
    references: new Map([[R1, reference(R1, null, oldContent)]]),
  }), content, R2))

  assert.equal(plan.kind, 'append')
  assert.equal(plan.version.parent, R1)
  assert.equal(plan.version.contentSha256, sha256(content))
  assert.equal(plan.version.contentBytes, content.byteLength)
})

test('first Document commit appends an unbound empty root version', () => {
  const content = bytes('')
  const plan = planDocumentCommit({
    ...commitInput(state(), content, D1),
    referenceVersion: null,
  })

  assert.equal(plan.kind, 'append')
  assert.equal(plan.version.parent, null)
  assert.equal(plan.version.referenceVersion, null)
  assert.equal(plan.version.contentBytes, 0)
})

test('Document commit reports no changes only when both content and bind match HEAD', () => {
  const content = bytes('# Document\n')
  const latest = state({
    referenceHead: R1,
    documentHead: D1,
    references: new Map([[R1, reference(R1, null, bytes('# Reference\n'))]]),
    documents: new Map([[D1, document(D1, null, content, R1)]]),
  })

  const plan = planDocumentCommit({
    ...commitInput(latest, content, D2),
    referenceVersion: R1,
  })

  assert.deepEqual(plan, { kind: 'no-changes', tree: 'document' })
})

test('Document commit appends when only its Reference bind changes', () => {
  const content = bytes('# Document\n')
  const latest = state({
    referenceHead: R2,
    documentHead: D1,
    references: new Map([
      [R1, reference(R1, null, bytes('# R1\n'))],
      [R2, reference(R2, R1, bytes('# R2\n'))],
    ]),
    documents: new Map([[D1, document(D1, null, content, R1)]]),
  })

  const plan = planDocumentCommit({
    ...commitInput(latest, content, D2),
    referenceVersion: R2,
  })

  assert.equal(plan.kind, 'append')
  assert.equal(plan.version.parent, D1)
  assert.equal(plan.version.referenceVersion, R2)
})

test('Document commit rejects missing and wrong-tree Reference binds', () => {
  const latest = state({
    documents: new Map([[D1, document(D1, null, bytes('# D1\n'), null)]]),
  })

  assert.throws(
    () => planDocumentCommit({
      ...commitInput(latest, bytes('# Draft\n'), D2),
      referenceVersion: R1,
    }),
    (error) => selectionError(error, 'reference', R1, 'missing'),
  )
  assert.throws(
    () => planDocumentCommit({
      ...commitInput(latest, bytes('# Draft\n'), D2),
      referenceVersion: D1,
    }),
    (error) => selectionError(error, 'reference', D1, 'wrong-tree'),
  )
})

test('commit rejects a new Version ID already used by either tree', () => {
  const latest = state({
    references: new Map([[R1, reference(R1, null, bytes('# R1\n'))]]),
    documents: new Map([[D1, document(D1, null, bytes('# D1\n'), R1)]]),
  })

  assert.throws(
    () => planReferenceCommit(commitInput(latest, bytes('# changed\n'), D1)),
    (error) => {
      assert.ok(error instanceof VersionIdCollisionError)
      assert.equal(error.reason, 'version-id-collision')
      assert.equal(error.version, D1)
      return true
    },
  )
  assert.throws(
    () => planDocumentCommit({
      ...commitInput(latest, bytes('# changed\n'), R1),
      referenceVersion: null,
    }),
    VersionIdCollisionError,
  )
})

test('checkout validates that the target belongs to the selected tree', () => {
  const content = bytes('# R1\n')
  const latest = state({
    referenceHead: R1,
    references: new Map([[R1, reference(R1, null, content)]]),
    documents: new Map([[D1, document(D1, null, bytes('# D1\n'), R1)]]),
  })

  assert.throws(
    () => planCheckout({ state: latest, tree: 'reference', version: R2, workingCopy: content }),
    (error) => selectionError(error, 'reference', R2, 'missing'),
  )
  assert.throws(
    () => planCheckout({ state: latest, tree: 'reference', version: D1, workingCopy: content }),
    (error) => selectionError(error, 'reference', D1, 'wrong-tree'),
  )
})

test('checkout permits a clean working copy and reports whether changes were discarded', () => {
  const r1Content = bytes('# R1\n')
  const latest = state({
    referenceHead: R1,
    references: new Map([
      [R1, reference(R1, null, r1Content)],
      [R2, reference(R2, R1, bytes('# R2\n'))],
    ]),
  })

  assert.deepEqual(planCheckout({
    state: latest,
    tree: 'reference',
    version: R2,
    workingCopy: r1Content,
  }), {
    kind: 'checkout',
    tree: 'reference',
    version: R2,
    discardedChanges: false,
  })
})

test('checkout refuses a dirty working copy unless discarding is explicit', () => {
  const headContent = bytes('# R1\n')
  const latest = state({
    referenceHead: R1,
    references: new Map([
      [R1, reference(R1, null, headContent)],
      [R2, reference(R2, R1, bytes('# R2\n'))],
    ]),
  })
  const draft = bytes('# unsaved as a version\n')

  assert.throws(
    () => planCheckout({ state: latest, tree: 'reference', version: R2, workingCopy: draft }),
    (error) => {
      assert.ok(error instanceof WorkingCopyDirtyError)
      assert.equal(error.reason, 'working-copy-dirty')
      assert.equal(error.tree, 'reference')
      return true
    },
  )

  assert.equal(planCheckout({
    state: latest,
    tree: 'reference',
    version: R2,
    workingCopy: draft,
    discardChanges: true,
  }).discardedChanges, true)
})

test('without a HEAD, only a non-empty working copy is dirty', () => {
  const latest = state({
    references: new Map([[R1, reference(R1, null, bytes('# R1\n'))]]),
  })

  assert.doesNotThrow(() => planCheckout({
    state: latest,
    tree: 'reference',
    version: R1,
    workingCopy: bytes(''),
  }))
  assert.throws(() => planCheckout({
    state: latest,
    tree: 'reference',
    version: R1,
    workingCopy: bytes('# Draft\n'),
  }), WorkingCopyDirtyError)
})

function selectionError(error, tree, version, reason) {
  assert.ok(error instanceof VersionSelectionError)
  assert.equal(error.tree, tree)
  assert.equal(error.version, version)
  assert.equal(error.reason, reason)
  return true
}

function commitInput(latest, workingCopy, versionId) {
  return {
    state: latest,
    workingCopy,
    actor: ACTOR,
    summary: 'Create version',
    versionId,
    createdAt: CREATED_AT,
  }
}

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
