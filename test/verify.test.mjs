import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ArchiveError } from '../dist/archive/errors.js'
import {
  verifyArchiveMetadataFromBytes,
  verifyArchiveMetadataFromPath,
  verifyArchiveVersionContents,
} from '../dist/archive/verify.js'
import { writeArchive } from '../dist/archive/writer.js'

const REFERENCE_HEAD = `v_${'1'.repeat(32)}`
const OLD_REFERENCE_BRANCH = `v_${'2'.repeat(32)}`
const DOCUMENT_ONE = `v_${'a'.repeat(32)}`
const DOCUMENT_TWO = `v_${'b'.repeat(32)}`

test('metadata verification reuses normal indexing and full verification checks an old branch', async (t) => {
  const path = await temporaryArchivePath(t)
  const headContent = Buffer.from('# Current reference\n')
  const expectedOldContent = Buffer.from('# Original old branch\n')
  const corruptedOldContent = Buffer.from('# Corrupted old branch\n')
  await writeArchive(path, [
    ...baseEntries({
      referenceHead: REFERENCE_HEAD,
      referenceCurrent: headContent,
    }),
    ...referenceVersionEntries(REFERENCE_HEAD, null, headContent),
    ...referenceVersionEntries(
      OLD_REFERENCE_BRANCH,
      null,
      expectedOldContent,
      corruptedOldContent,
    ),
  ])
  const before = await readFile(path)

  const metadata = await verifyArchiveMetadataFromPath(path)
  assert.equal(metadata.complete, true)
  assert.equal(metadata.issues.length, 0)
  assert.ok(metadata.archive)
  t.after(() => metadata.archive.close())

  const full = await verifyArchiveVersionContents(metadata.archive, 10)
  assert.equal(full.complete, true)
  assert.equal(full.issues.length, 1)
  assert.equal(full.issues[0]?.code, 'INTEGRITY_MISMATCH')
  assert.equal(full.issues[0]?.details.versionId, OLD_REFERENCE_BRANCH)
  assert.equal(full.issues[0]?.entry, `ref_tree/versions/${OLD_REFERENCE_BRANCH}/content.md`)
  assert.equal(Object.isFrozen(full), true)
  assert.equal(Object.isFrozen(full.issues), true)
  assert.equal(Object.isFrozen(full.issues[0]), true)
  assert.deepEqual(await readFile(path), before)
})

test('full verification aggregates independent UTF-8 and integrity issues in stable order', async (t) => {
  const path = await temporaryArchivePath(t)
  const invalidUtf8 = Buffer.from([0xc3, 0x28])
  const expectedTwo = Buffer.from('# Expected document two\n')
  const actualTwo = Buffer.from('# Changed document two\n')
  await writeArchive(path, [
    ...baseEntries({
      documentHead: DOCUMENT_TWO,
      documentCurrent: actualTwo,
    }),
    ...documentVersionEntries(DOCUMENT_ONE, null, invalidUtf8),
    ...documentVersionEntries(DOCUMENT_TWO, DOCUMENT_ONE, expectedTwo, actualTwo),
  ])

  const metadata = await verifyArchiveMetadataFromPath(path)
  assert.ok(metadata.archive)
  t.after(() => metadata.archive.close())
  const full = await verifyArchiveVersionContents(metadata.archive, 10)

  assert.equal(full.complete, true)
  assert.deepEqual(
    full.issues.map(({ code, details }) => [code, details.versionId]),
    [
      ['INVALID_UTF8', DOCUMENT_ONE],
      ['INTEGRITY_MISMATCH', DOCUMENT_TWO],
    ],
  )
})

test('maxIssues only marks verification incomplete when unchecked versions remain', async (t) => {
  const path = await temporaryArchivePath(t)
  const firstExpected = Buffer.from('# Expected one\n')
  const firstActual = Buffer.from('# Changed one\n')
  const secondExpected = Buffer.from('# Expected two\n')
  const secondActual = Buffer.from('# Changed two\n')
  await writeArchive(path, [
    ...baseEntries({
      documentHead: DOCUMENT_TWO,
      documentCurrent: secondActual,
    }),
    ...documentVersionEntries(DOCUMENT_ONE, null, firstExpected, firstActual),
    ...documentVersionEntries(DOCUMENT_TWO, DOCUMENT_ONE, secondExpected, secondActual),
  ])

  const metadata = await verifyArchiveMetadataFromPath(path)
  assert.ok(metadata.archive)
  t.after(() => metadata.archive.close())

  const truncated = await verifyArchiveVersionContents(metadata.archive, 1)
  assert.equal(truncated.complete, false)
  assert.equal(truncated.issues.length, 1)
  assert.equal(truncated.issues[0]?.details.versionId, DOCUMENT_ONE)

  const exactBudget = await verifyArchiveVersionContents(metadata.archive, 2)
  assert.equal(exactBudget.complete, true)
  assert.equal(exactBudget.issues.length, 2)
})

test('bad archive bytes become metadata diagnostics while missing paths remain errors', async (t) => {
  const badZip = await verifyArchiveMetadataFromBytes(Buffer.from('not a ZIP archive'))
  assert.equal(badZip.archive, null)
  assert.equal(badZip.complete, false)
  assert.equal(badZip.issues.length, 1)
  assert.equal(badZip.issues[0]?.code, 'INVALID_ARCHIVE')
  assert.deepEqual(badZip.warnings, [])

  const limited = await verifyArchiveMetadataFromBytes(
    await readFile('fixtures/valid/empty.mdv'),
    { limits: { maxEntries: 1 } },
  )
  assert.equal(limited.complete, false)
  assert.equal(limited.issues[0]?.code, 'LIMIT_EXCEEDED')

  const wrongFormat = await verifyArchiveMetadataFromPath(
    'fixtures/invalid/invalid-manifest.mdv',
  )
  assert.equal(wrongFormat.archive, null)
  assert.equal(wrongFormat.complete, false)
  assert.equal(wrongFormat.issues[0]?.code, 'NOT_MDV')

  const directory = await temporaryDirectory(t)
  const missing = join(directory, 'missing.mdv')
  await assert.rejects(
    verifyArchiveMetadataFromPath(missing),
    (error) => {
      assert.ok(error instanceof ArchiveError)
      assert.equal(error.code, 'NOT_FOUND')
      return true
    },
  )
})

test('full verification handles an archive with no versions without rescanning content', async (t) => {
  const metadata = await verifyArchiveMetadataFromPath('fixtures/valid/empty.mdv')
  assert.ok(metadata.archive)
  t.after(() => metadata.archive.close())

  const full = await verifyArchiveVersionContents(metadata.archive, 10)
  assert.deepEqual(full, {
    complete: true,
    issues: [],
  })
})

test('path verification keeps one snapshot when replacement succeeds or is blocked until close', async (t) => {
  const path = await temporaryArchivePath(t)
  const originalContent = Buffer.from('# Original snapshot\n')
  await writeArchive(path, [
    ...baseEntries({
      referenceHead: REFERENCE_HEAD,
      referenceCurrent: originalContent,
    }),
    ...referenceVersionEntries(REFERENCE_HEAD, null, originalContent),
  ])
  const originalBytes = await readFile(path)

  const metadata = await verifyArchiveMetadataFromPath(path)
  assert.ok(metadata.archive)
  t.after(() => metadata.archive.close())

  const replacementPath = `${path}.replacement`
  const replacementContent = Buffer.from('# Replacement snapshot\n')
  await writeArchive(replacementPath, [
    ...baseEntries({
      referenceHead: REFERENCE_HEAD,
      referenceCurrent: replacementContent,
    }),
    ...referenceVersionEntries(REFERENCE_HEAD, null, replacementContent),
  ])
  const replacementBytes = await readFile(replacementPath)
  let replacementBlocked = false
  try {
    await rename(replacementPath, path)
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    replacementBlocked = true
    assert.deepEqual(await readFile(path), originalBytes)
    assert.deepEqual(await readFile(replacementPath), replacementBytes)
  }

  const full = await verifyArchiveVersionContents(metadata.archive, 10)
  assert.deepEqual(full, {
    complete: true,
    issues: [],
  })
  await metadata.archive.close()
  if (replacementBlocked) await rename(replacementPath, path)
  const replacement = await verifyArchiveMetadataFromPath(path)
  assert.ok(replacement.archive)
  try {
    assert.deepEqual(Buffer.from(await replacement.archive.readWorkingCopy('reference')), replacementContent)
  } finally {
    await replacement.archive.close()
  }
})

function baseEntries({
  referenceHead = null,
  documentHead = null,
  referenceCurrent = Buffer.alloc(0),
  documentCurrent = Buffer.alloc(0),
} = {}) {
  return [
    {
      name: 'manifest.json',
      bytes: json({
        format: 'mdv',
        formatVersion: '0.1',
        documentId: `d_${'0'.repeat(32)}`,
        generation: 0,
        markdownProfile: 'gfm',
      }),
    },
    ...(referenceHead === null
      ? []
      : [{ name: 'ref_tree/HEAD', bytes: Buffer.from(`${referenceHead}\n`) }]),
    { name: 'ref_tree/current.md', bytes: referenceCurrent },
    ...(documentHead === null
      ? []
      : [{ name: 'doc_tree/HEAD', bytes: Buffer.from(`${documentHead}\n`) }]),
    { name: 'doc_tree/current.md', bytes: documentCurrent },
  ]
}

function referenceVersionEntries(id, parent, expectedContent, actualContent = expectedContent) {
  return versionEntries('ref_tree', id, parent, expectedContent, actualContent)
}

function documentVersionEntries(id, parent, expectedContent, actualContent = expectedContent) {
  return versionEntries('doc_tree', id, parent, expectedContent, actualContent, {
    referenceVersion: null,
  })
}

function versionEntries(tree, id, parent, expectedContent, actualContent, extra = {}) {
  const directory = `${tree}/versions/${id}`
  return [
    {
      name: `${directory}/content.md`,
      bytes: actualContent,
    },
    {
      name: `${directory}/meta.json`,
      bytes: json({
        schemaVersion: 1,
        id,
        parent,
        createdAt: '2026-09-08T00:00:00Z',
        actor: { type: 'agent', id: 'verify-test' },
        summary: `Commit ${id}`,
        contentSha256: createHash('sha256').update(expectedContent).digest('hex'),
        contentBytes: expectedContent.byteLength,
        ...extra,
      }),
    },
  ]
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

async function temporaryArchivePath(t) {
  const directory = await temporaryDirectory(t)
  return join(directory, 'verify.mdv')
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-verify-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
