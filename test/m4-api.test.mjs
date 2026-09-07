import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openArchiveFromPath } from '../dist/archive/reader.js'
import { MdvError, createMdv, openMdv } from '../dist/index.js'

const HUMAN = Object.freeze({ type: 'human', id: 'hypnos', name: 'Hypnos' })
const AGENT = Object.freeze({ type: 'agent', id: 'writer-agent' })

test('commits immutable Reference and Document versions with an exact bind', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  document = await document.saveReference({
    markdown: '# Reference one\r\n',
    expectedGeneration: 0,
  })
  const referenceCommit = await document.commitReference({
    expectedGeneration: 1,
    actor: HUMAN,
    summary: 'Commit reference one',
  })
  assert.equal(referenceCommit.created, true)
  document = referenceCommit.document
  const referenceVersion = referenceCommit.version

  assert.equal(document.manifest.generation, 2)
  assert.equal(document.referenceTree.head, referenceVersion)
  assert.equal(document.documentTree.head, null)
  assert.equal(await document.readVersionText(referenceVersion), '# Reference one\r\n')

  document = await document.saveDocument({
    markdown: '# Document one\n',
    expectedGeneration: 2,
  })
  const documentCommit = await document.commitDocument({
    expectedGeneration: 3,
    referenceVersion,
    actor: AGENT,
    summary: 'Commit document one',
  })
  assert.equal(documentCommit.created, true)
  document = documentCommit.document
  const documentVersion = documentCommit.version

  assert.equal(document.manifest.generation, 4)
  assert.equal(document.documentTree.head, documentVersion)
  assert.equal(await document.readVersionText(documentVersion), '# Document one\n')
  assert.equal(document.getDocumentReference(documentVersion), referenceVersion)
  assert.deepEqual(
    document.listDocumentsUsingReference(referenceVersion).map(({ id }) => id),
    [documentVersion],
  )
  assert.equal(document.traceDocument(documentVersion).reference?.id, referenceVersion)

  const referenceSummary = document.listVersions({ tree: 'reference' })[0]
  const documentSummary = document.listVersions({ tree: 'document' })[0]
  assert.equal(referenceSummary?.parent, null)
  assert.deepEqual(referenceSummary?.actor, HUMAN)
  assert.equal(referenceSummary?.summary, 'Commit reference one')
  assert.equal(documentSummary?.parent, null)
  assert.deepEqual(documentSummary?.actor, AGENT)
  assert.equal(documentSummary?.referenceVersion, referenceVersion)
})

test('no-change commits still advance generation while bind-only commits create versions', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  const firstReference = await document.commitReference({
    expectedGeneration: 0,
    actor: HUMAN,
    summary: 'Explicit empty Reference root',
  })
  assert.equal(firstReference.created, true)
  document = firstReference.document

  const unchangedReference = await document.commitReference({
    expectedGeneration: 1,
    actor: HUMAN,
    summary: 'No changes',
  })
  assert.deepEqual(
    { created: unchangedReference.created, reason: unchangedReference.reason },
    { created: false, reason: 'no-changes' },
  )
  document = unchangedReference.document
  assert.equal(document.manifest.generation, 2)
  assert.equal(document.listVersions({ tree: 'reference' }).length, 1)
  assert.equal(document.referenceTree.head, firstReference.version)

  const firstDocument = await document.commitDocument({
    expectedGeneration: 2,
    referenceVersion: null,
    actor: AGENT,
    summary: 'Explicit empty Document root',
  })
  assert.equal(firstDocument.created, true)
  document = firstDocument.document

  const unchangedDocument = await document.commitDocument({
    expectedGeneration: 3,
    referenceVersion: null,
    actor: AGENT,
    summary: 'No content or bind changes',
  })
  assert.equal(unchangedDocument.created, false)
  document = unchangedDocument.document
  assert.equal(document.manifest.generation, 4)
  assert.equal(document.listVersions({ tree: 'document' }).length, 1)

  const bindOnly = await document.commitDocument({
    expectedGeneration: 4,
    referenceVersion: firstReference.version,
    actor: AGENT,
    summary: 'Bind the same content to Reference root',
  })
  assert.equal(bindOnly.created, true)
  document = bindOnly.document
  assert.equal(document.manifest.generation, 5)
  assert.equal(document.listVersions({ tree: 'document' }).length, 2)
  assert.equal(
    document.getDocumentReference(bindOnly.version),
    firstReference.version,
  )
  assert.equal(
    document.listVersions({ tree: 'document' }).find(({ id }) => id === bindOnly.version)?.parent,
    firstDocument.version,
  )
})

test('checkout restores exact content, protects a dirty Draft, and permits branches', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  document = await document.saveDocument({ markdown: '# One\r\n', expectedGeneration: 0 })
  const first = await document.commitDocument({
    expectedGeneration: 1,
    referenceVersion: null,
    actor: HUMAN,
    summary: 'Document one',
  })
  assert.equal(first.created, true)
  document = first.document

  document = await document.saveDocument({ markdown: '# Two\n', expectedGeneration: 2 })
  const second = await document.commitDocument({
    expectedGeneration: 3,
    referenceVersion: null,
    actor: HUMAN,
    summary: 'Document two',
  })
  assert.equal(second.created, true)
  document = second.document

  document = await document.checkoutDocument({
    version: first.version,
    expectedGeneration: 4,
  })
  assert.equal(document.manifest.generation, 5)
  assert.equal(document.documentTree.head, first.version)
  assert.equal(await document.readDocumentText(), '# One\r\n')
  assert.equal(document.listVersions({ tree: 'document' }).length, 2)

  document = await document.saveDocument({
    markdown: '# Branch Draft\n',
    expectedGeneration: 5,
  })
  await assert.rejects(
    document.checkoutDocument({ version: second.version, expectedGeneration: 6 }),
    (error) => {
      assert.ok(isMdvError(error, 'CONFLICT'))
      assert.equal(error.details.reason, 'working-copy-dirty')
      assert.equal(error.details.tree, 'document')
      return true
    },
  )
  let reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 6)
  assert.equal(reopened.documentTree.head, first.version)
  assert.equal(await reopened.readDocumentText(), '# Branch Draft\n')

  document = await document.checkoutDocument({
    version: second.version,
    expectedGeneration: 6,
    discardChanges: true,
  })
  assert.equal(document.manifest.generation, 7)
  assert.equal(document.documentTree.head, second.version)
  assert.equal(await document.readDocumentText(), '# Two\n')

  document = await document.checkoutDocument({
    version: first.version,
    expectedGeneration: 7,
  })
  document = await document.saveDocument({
    markdown: '# Branch\n',
    expectedGeneration: 8,
  })
  const branch = await document.commitDocument({
    expectedGeneration: 9,
    referenceVersion: null,
    actor: HUMAN,
    summary: 'Branch from Document one',
  })
  assert.equal(branch.created, true)
  document = branch.document

  assert.equal(document.manifest.generation, 10)
  assert.equal(document.documentTree.head, branch.version)
  assert.equal(
    document.listVersions({ tree: 'document' }).find(({ id }) => id === branch.version)?.parent,
    first.version,
  )
  assert.deepEqual(
    new Set(document.getChildren('document', first.version).map(({ id }) => id)),
    new Set([second.version, branch.version]),
  )
  assert.equal(await document.readVersionText(second.version), '# Two\n')
  assert.equal(await document.readVersionText(first.version), '# One\r\n')

  reopened = await openMdv(packagePath)
  assert.equal(reopened.documentTree.head, branch.version)
  assert.equal(await reopened.readDocumentText(), '# Branch\n')
})

test('commit and checkout validate selections and public inputs without changing the file', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)
  const missing = `v_${'9'.repeat(32)}`

  await assert.rejects(
    document.commitDocument({
      expectedGeneration: 0,
      referenceVersion: missing,
      actor: AGENT,
      summary: 'Missing bind',
    }),
    (error) => isMdvError(error, 'NOT_FOUND'),
  )
  await assert.rejects(
    document.commitReference({
      expectedGeneration: 0,
      actor: { type: 'robot' },
      summary: 'Invalid actor',
    }),
    TypeError,
  )
  await assert.rejects(
    document.commitReference({
      expectedGeneration: 0,
      actor: HUMAN,
      summary: '   ',
    }),
    TypeError,
  )
  await assert.rejects(
    document.commitDocument({
      expectedGeneration: 0,
      actor: AGENT,
      summary: 'Missing explicit referenceVersion',
    }),
    TypeError,
  )
  await assert.rejects(
    document.checkoutDocument({ version: missing, expectedGeneration: 0 }),
    (error) => isMdvError(error, 'NOT_FOUND'),
  )

  const reference = await document.commitReference({
    expectedGeneration: 0,
    actor: HUMAN,
    summary: 'Reference root',
  })
  document = reference.document
  await assert.rejects(
    document.checkoutDocument({ version: reference.version, expectedGeneration: 1 }),
    (error) => {
      assert.ok(isMdvError(error, 'NOT_FOUND'))
      assert.equal(error.details.reason, 'wrong-tree')
      return true
    },
  )

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 1)
  assert.equal(reopened.listVersions().length, 1)
})

test('concurrent commits from one generation create at most one version', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)
  document = await document.saveDocument({ markdown: '# Draft\n', expectedGeneration: 0 })
  const other = await openMdv(packagePath)

  const results = await Promise.allSettled([
    document.commitDocument({
      expectedGeneration: 1,
      referenceVersion: null,
      actor: AGENT,
      summary: 'Commit A',
    }),
    other.commitDocument({
      expectedGeneration: 1,
      referenceVersion: null,
      actor: AGENT,
      summary: 'Commit B',
    }),
  ])

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  const rejected = results.find(({ status }) => status === 'rejected')
  assert.equal(rejected?.status, 'rejected')
  assert.ok(isMdvError(rejected.reason, 'CONFLICT'))

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 2)
  assert.equal(reopened.listVersions({ tree: 'document' }).length, 1)
})

test('write calls snapshot mutable JavaScript inputs before their first async boundary', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  const saveInput = { markdown: '# Original\n', expectedGeneration: 0 }
  const saving = document.saveDocument(saveInput)
  saveInput.markdown = '# Mutated\n'
  saveInput.expectedGeneration = 99
  document = await saving
  assert.equal(await document.readDocumentText(), '# Original\n')

  const actor = { type: 'human', id: 'before', name: 'Before' }
  const commitInput = {
    expectedGeneration: 1,
    referenceVersion: null,
    actor,
    summary: 'Before mutation',
  }
  const committing = document.commitDocument(commitInput)
  actor.id = 'after'
  actor.name = 'After'
  commitInput.summary = 'After mutation'
  commitInput.expectedGeneration = 99
  commitInput.referenceVersion = `v_${'e'.repeat(32)}`

  const commit = await committing
  assert.equal(commit.created, true)
  document = commit.document
  const summary = document.listVersions({ tree: 'document' })[0]
  assert.deepEqual(summary?.actor, { type: 'human', id: 'before', name: 'Before' })
  assert.equal(summary?.summary, 'Before mutation')

  const checkoutInput = {
    version: commit.version,
    expectedGeneration: 2,
  }
  const checkingOut = document.checkoutDocument(checkoutInput)
  checkoutInput.version = `v_${'f'.repeat(32)}`
  checkoutInput.expectedGeneration = 99
  document = await checkingOut
  assert.equal(document.documentTree.head, commit.version)
  assert.equal(document.manifest.generation, 3)
})

test('commit and checkout preserve every existing Version metadata and content byte', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  let document = await createMdv(packagePath)

  document = await document.saveReference({ markdown: '# Reference one\r\n', expectedGeneration: 0 })
  const firstReference = await document.commitReference({
    expectedGeneration: 1,
    actor: HUMAN,
    summary: 'Reference one',
  })
  assert.equal(firstReference.created, true)
  document = firstReference.document

  document = await document.saveDocument({ markdown: '# Document one\n', expectedGeneration: 2 })
  const firstDocument = await document.commitDocument({
    expectedGeneration: 3,
    referenceVersion: firstReference.version,
    actor: AGENT,
    summary: 'Document one',
  })
  assert.equal(firstDocument.created, true)
  document = firstDocument.document

  const beforeCommit = await readHistoricalEntryBytes(packagePath)
  document = await document.saveReference({ markdown: '# Reference two\n', expectedGeneration: 4 })
  const secondReference = await document.commitReference({
    expectedGeneration: 5,
    actor: HUMAN,
    summary: 'Reference two',
  })
  assert.equal(secondReference.created, true)
  document = secondReference.document

  const afterCommit = await readHistoricalEntryBytes(packagePath)
  assertExistingHistoryUnchanged(beforeCommit, afterCommit)

  document = await document.checkoutReference({
    version: firstReference.version,
    expectedGeneration: 6,
  })
  assert.equal(document.referenceTree.head, firstReference.version)
  assert.equal(await document.readReferenceText(), '# Reference one\r\n')

  const afterCheckout = await readHistoricalEntryBytes(packagePath)
  assertExistingHistoryUnchanged(afterCommit, afterCheckout)
})

test('maxVersions rejects an append without changing generation, HEAD, Draft, or history', async (t) => {
  const packagePath = await temporaryPackagePath(t)
  const options = { limits: { maxVersions: 1 } }
  let document = await createMdv(packagePath, options)

  document = await document.saveDocument({ markdown: '# Version one\n', expectedGeneration: 0 })
  const first = await document.commitDocument({
    expectedGeneration: 1,
    referenceVersion: null,
    actor: HUMAN,
    summary: 'Version one',
  })
  assert.equal(first.created, true)
  document = first.document
  document = await document.saveDocument({ markdown: '# Pending draft\n', expectedGeneration: 2 })

  const packageBytes = await readFile(packagePath)
  const historyBytes = await readHistoricalEntryBytes(packagePath, options)
  const generation = document.manifest.generation
  const head = document.documentTree.head
  const draft = await document.readDocumentText()

  await assert.rejects(
    document.commitDocument({
      expectedGeneration: generation,
      referenceVersion: null,
      actor: HUMAN,
      summary: 'Must exceed maxVersions',
    }),
    (error) => isMdvError(error, 'LIMIT_EXCEEDED'),
  )

  assert.deepEqual(await readFile(packagePath), packageBytes)
  const reopened = await openMdv(packagePath, options)
  assert.equal(reopened.manifest.generation, generation)
  assert.equal(reopened.documentTree.head, head)
  assert.equal(await reopened.readDocumentText(), draft)
  assert.equal(reopened.listVersions().length, 1)
  assert.deepEqual(await readHistoricalEntryBytes(packagePath, options), historyBytes)
})

async function readHistoricalEntryBytes(packagePath, options = {}) {
  const archive = await openArchiveFromPath(packagePath, options)
  const entries = new Map()
  try {
    for await (const version of archive.readVersionContents()) {
      entries.set(`${version.tree}:${version.versionId}`, {
        metadata: Buffer.from(version.metadataBytes),
        content: Buffer.from(version.bytes),
      })
    }
  } finally {
    await archive.close()
  }
  return entries
}

function assertExistingHistoryUnchanged(before, after) {
  for (const [version, bytes] of before) {
    assert.ok(after.has(version), `missing historical Version ${version}`)
    assert.deepEqual(after.get(version), bytes, `historical Version ${version} changed`)
  }
}

async function temporaryPackagePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-m4-api-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'document.mdv')
}

function isMdvError(error, code) {
  assert.ok(error instanceof MdvError)
  assert.equal(error.code, code)
  return true
}
