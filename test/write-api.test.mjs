import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { openArchiveFromPath } from '../dist/archive/reader.js'
import { writeArchive } from '../dist/archive/writer.js'
import { createMdv, MdvError, openMdv } from '../dist/index.js'

const FIXTURE_PATH = resolve('fixtures/valid/bound-history.mdv')
const R1 = `v_${'1'.repeat(32)}`
const R2 = `v_${'2'.repeat(32)}`
const R3 = `v_${'3'.repeat(32)}`
const D1 = `v_${'a'.repeat(32)}`
const D2 = `v_${'b'.repeat(32)}`

test('creates a path-bound generation-zero document', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'new.mdv')
  const document = await createMdv(packagePath)

  assert.equal(document.packagePath, packagePath)
  assert.equal(document.baseDirectory, dirname(packagePath))
  assert.equal(document.manifest.generation, 0)
  assert.equal(document.manifest.markdownProfile, 'gfm')
  assert.deepEqual(document.referenceTree, { head: null })
  assert.deepEqual(document.documentTree, { head: null })
  assert.deepEqual(document.listVersions(), [])
  assert.equal(await document.readReferenceText(), '')
  assert.equal(await document.readDocumentText(), '')
  assert.equal(typeof document.saveReference, 'function')
  assert.equal(typeof document.saveDocument, 'function')

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 0)
  assert.deepEqual(reopened.referenceTree, { head: null })
  assert.deepEqual(reopened.documentTree, { head: null })
  assert.deepEqual(reopened.listVersions(), [])
})

test('refuses to replace an existing create target', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'existing.mdv')
  const original = Buffer.from('existing bytes')
  await writeFile(packagePath, original)

  await assert.rejects(
    createMdv(packagePath),
    (error) => isMdvError(error, 'CONFLICT'),
  )
  assert.deepEqual(await readFile(packagePath), original)
})

test('creates a document with an explicit Markdown profile', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'profile.mdv')
  const document = await createMdv(packagePath, { markdownProfile: 'company-gfm' })

  assert.equal(document.manifest.markdownProfile, 'company-gfm')
  assert.deepEqual(document.warnings, [{
    code: 'UNKNOWN_MARKDOWN_PROFILE',
    entry: 'manifest.json',
    path: '$/markdownProfile',
    message: 'profile "company-gfm" is not registered by MDV 0.1',
  }])

  const invalidPath = join(directory, 'invalid-profile.mdv')
  await assert.rejects(createMdv(invalidPath, { markdownProfile: 'Not Valid' }), TypeError)
  await assert.rejects(readFile(invalidPath), (error) => error?.code === 'ENOENT')

  const nonStringPath = join(directory, 'non-string-profile.mdv')
  await assert.rejects(createMdv(nonStringPath, { markdownProfile: 1 }), TypeError)
  await assert.rejects(readFile(nonStringPath), (error) => error?.code === 'ENOENT')
})

test('saves each working copy without creating versions and preserves exact bytes', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'working-copies.mdv')
  const original = await createMdv(packagePath)
  const referenceText = '# 摘要\r\n猫猫\r\n'

  const afterReference = await original.saveReference({
    markdown: referenceText,
    expectedGeneration: 0,
  })

  assert.equal(original.manifest.generation, 0)
  assert.equal(await original.readReferenceText(), '')
  assert.equal(afterReference.manifest.generation, 1)
  assert.deepEqual(
    Buffer.from((await afterReference.readReference()).bytes),
    Buffer.from(referenceText),
  )
  assert.equal(await afterReference.readDocumentText(), '')
  assert.deepEqual(afterReference.listVersions(), [])
  assert.deepEqual(afterReference.referenceTree, { head: null })
  assert.deepEqual(afterReference.documentTree, { head: null })

  const documentBytes = Buffer.from('# 正文\r\n最后一行\n')
  const afterDocument = await afterReference.saveDocument({
    markdown: documentBytes,
    expectedGeneration: 1,
  })

  assert.equal(afterReference.manifest.generation, 1)
  assert.equal(await afterReference.readDocumentText(), '')
  assert.equal(afterDocument.manifest.generation, 2)
  assert.deepEqual(
    Buffer.from((await afterDocument.readReference()).bytes),
    Buffer.from(referenceText),
  )
  assert.deepEqual(Buffer.from((await afterDocument.readDocument()).bytes), documentBytes)
  assert.deepEqual(afterDocument.listVersions(), [])
  assert.deepEqual(afterDocument.referenceTree, { head: null })
  assert.deepEqual(afterDocument.documentTree, { head: null })
})

test('rejects BOM and invalid UTF-8 without changing the package', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'invalid-markdown.mdv')
  const document = await createMdv(packagePath)
  const original = await readFile(packagePath)

  for (const markdown of [
    Uint8Array.from([0xef, 0xbb, 0xbf, 0x23]),
    Uint8Array.from([0xff]),
  ]) {
    await assert.rejects(
      document.saveDocument({ markdown, expectedGeneration: 0 }),
      (error) => isMdvError(error, 'INVALID_UTF8'),
    )
    assert.deepEqual(await readFile(packagePath), original)
  }

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 0)
  assert.equal(await reopened.readDocumentText(), '')
})

test('reports stale generations as conflicts without overwriting the winner', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'generation-conflict.mdv')
  const stale = await createMdv(packagePath)
  const current = await stale.saveReference({
    markdown: '# Winner\n',
    expectedGeneration: 0,
  })

  await assert.rejects(
    stale.saveDocument({
      markdown: '# Must not be written\n',
      expectedGeneration: 0,
    }),
    (error) => {
      assert.ok(isMdvError(error, 'CONFLICT'))
      assert.equal(error.details.expectedGeneration, 0)
      assert.equal(error.details.actualGeneration, 1)
      return true
    },
  )

  assert.equal(current.manifest.generation, 1)
  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 1)
  assert.equal(await reopened.readReferenceText(), '# Winner\n')
  assert.equal(await reopened.readDocumentText(), '')
})

test('rejects a save when the path contains a different document with the same generation', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'original.mdv')
  const replacementPath = join(directory, 'replacement.mdv')
  const original = await createMdv(packagePath)
  const replacement = await createMdv(replacementPath)
  const replacementBytes = await readFile(replacementPath)
  await copyFile(replacementPath, packagePath)

  await assert.rejects(
    original.saveDocument({ markdown: '# wrong document\n', expectedGeneration: 0 }),
    (error) => {
      assert.ok(isMdvError(error, 'CONFLICT'))
      assert.equal(error.details.reason, 'document-changed')
      assert.equal(error.details.expectedDocumentId, original.manifest.documentId)
      assert.equal(error.details.actualDocumentId, replacement.manifest.documentId)
      return true
    },
  )

  assert.deepEqual(await readFile(packagePath), replacementBytes)
  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.documentId, replacement.manifest.documentId)
  assert.equal(reopened.manifest.generation, 0)
  assert.equal(await reopened.readDocumentText(), '')
})

test('rejects a handle after its parent-directory symlink is retargeted', async (t) => {
  const directory = await temporaryDirectory(t)
  const firstDirectory = join(directory, 'first')
  const secondDirectory = join(directory, 'second')
  const aliasDirectory = join(directory, 'current')
  await mkdir(firstDirectory)
  await mkdir(secondDirectory)
  await symlink(firstDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')

  const aliasedPath = join(aliasDirectory, 'document.mdv')
  const original = await createMdv(aliasedPath)
  const replacement = await createMdv(join(secondDirectory, 'document.mdv'))
  await unlink(aliasDirectory)
  await symlink(secondDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(
    original.saveReference({ markdown: '# must not move\n', expectedGeneration: 0 }),
    (error) => {
      assert.ok(isMdvError(error, 'CONFLICT'))
      assert.equal(error.details.reason, 'target-path-changed')
      return true
    },
  )

  const first = await openMdv(join(firstDirectory, 'document.mdv'))
  const second = await openMdv(join(secondDirectory, 'document.mdv'))
  assert.equal(first.manifest.documentId, original.manifest.documentId)
  assert.equal(second.manifest.documentId, replacement.manifest.documentId)
  assert.equal(first.manifest.generation, 0)
  assert.equal(second.manifest.generation, 0)
})

test('rejects oversized Markdown before acquiring the write lock', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'bounded.mdv')
  await createMdv(packagePath)
  const document = await openMdv(packagePath, { limits: { maxEntryBytes: 1024 } })
  const original = await readFile(packagePath)

  await assert.rejects(
    document.saveDocument({ markdown: Buffer.alloc(1025, 0x61), expectedGeneration: 0 }),
    (error) => {
      assert.ok(isMdvError(error, 'LIMIT_EXCEEDED'))
      assert.equal(error.details.actualBytes, 1025)
      assert.equal(error.details.maxEntryBytes, 1024)
      return true
    },
  )

  assert.deepEqual(await readFile(packagePath), original)
})

test('preserves opaque JSON bytes while changing only manifest generation', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'opaque-json.mdv')
  const versionId = `v_${'7'.repeat(32)}`
  const content = Buffer.from('# Reference\n')
  const contentHash = createHash('sha256').update(content).digest('hex')
  const manifestBytes = Buffer.from([
    '{',
    '  "format" : "mdv",',
    '  "formatVersion" : "0.1",',
    `  "documentId" : "d_${'8'.repeat(32)}",`,
    '  "generation" : 7e0,',
    '  "markdownProfile" : "gfm",',
    '  "extensionBig" : 9007199254740993,',
    '  "extensionHuge" : 1e400,',
    '  "extensionNested" : { "minusZero": -0 }',
    '}',
    '',
  ].join('\n'))
  const metadataBytes = Buffer.from([
    '{',
    '  "schemaVersion" : 1,',
    `  "id" : "${versionId}",`,
    '  "parent" : null,',
    '  "createdAt" : "2026-09-07T12:00:00+08:00",',
    '  "actor" : { "type": "agent", "extensionBig": 9007199254740993 },',
    '  "summary" : "initial",',
    `  "contentSha256" : "${contentHash}",`,
    `  "contentBytes" : ${content.byteLength},`,
    '  "extensionHuge" : 1e400',
    '}',
    '',
  ].join('\n'))

  await writeArchive(packagePath, [
    { name: 'manifest.json', bytes: manifestBytes },
    { name: 'ref_tree/HEAD', bytes: Buffer.from(`${versionId}\n`) },
    { name: 'ref_tree/current.md', bytes: content },
    { name: `ref_tree/versions/${versionId}/meta.json`, bytes: metadataBytes },
    { name: `ref_tree/versions/${versionId}/content.md`, bytes: content },
    { name: 'doc_tree/current.md', bytes: new Uint8Array() },
  ])

  const original = await openMdv(packagePath)
  const saved = await original.saveDocument({
    markdown: '# Edited\n',
    expectedGeneration: 7,
  })
  assert.equal(saved.manifest.generation, 8)

  const archive = await openArchiveFromPath(packagePath)
  const expectedManifest = Buffer.from(
    manifestBytes.toString('utf8').replace('"generation" : 7e0', '"generation" : 8'),
  )
  assert.deepEqual(Buffer.from(await archive.readManifestBytes()), expectedManifest)
  const versions = []
  for await (const version of archive.readVersionContents()) {
    versions.push(version)
  }
  assert.equal(versions.length, 1)
  assert.deepEqual(Buffer.from(versions[0].metadataBytes), metadataBytes)
  await archive.close()
})

test('preserves history, extension metadata, and lazy reads when saving a fixture', async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'bound-history.mdv')
  await copyFile(FIXTURE_PATH, packagePath)
  const original = await openMdv(packagePath)
  const originalVersions = original.listVersions()

  const saved = await original.saveDocument({
    markdown: '# Edited working copy\n',
    expectedGeneration: 5,
  })

  assert.equal(saved.manifest.generation, 6)
  assert.deepEqual(saved.referenceTree, { head: R2 })
  assert.deepEqual(saved.documentTree, { head: D2 })
  assert.deepEqual(saved.listVersions(), originalVersions)
  assert.deepEqual(saved.warnings, original.warnings)
  assert.ok(saved.warnings.some(({ entry, path }) => (
    entry === 'manifest.json' && path === '$/fixtureExtension'
  )))
  assert.ok(saved.warnings.some(({ entry, path }) => (
    entry === `ref_tree/versions/${R3}/meta.json` && path === '$/fixtureExtension'
  )))

  const trace = saved.traceDocument(D2)
  assert.deepEqual(trace.ancestry.map(({ id }) => id), [D2, D1])
  assert.equal(trace.reference?.id, R2)
  assert.deepEqual(saved.traceReference(R2).ancestry.map(({ id }) => id), [R2, R1])
  assert.equal(await saved.readReferenceText(), '# Reference two\n')
  assert.equal(await saved.readDocumentText(), '# Edited working copy\n')
  assert.equal(await saved.readVersionText(R3), '# Reference branch\n')
  assert.equal(await saved.readVersionText(D1), '# Document one\n')

  const archive = await openArchiveFromPath(packagePath)
  assert.deepEqual(archive.manifest.fixtureExtension, { enabled: true })
  assert.equal(
    archive.referenceVersions.find(({ directoryId }) => directoryId === R3)?.meta.fixtureExtension,
    true,
  )
  await archive.close()
})

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-write-api-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function isMdvError(error, code) {
  assert.ok(error instanceof MdvError)
  assert.equal(error.code, code)
  return true
}
