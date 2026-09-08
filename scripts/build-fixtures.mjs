import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yazl from 'yazl'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureRoot = join(projectRoot, 'fixtures')
const check = process.argv.includes('--check')
assert.ok(process.argv.slice(2).every((arg) => arg === '--check'), 'usage: node scripts/build-fixtures.mjs [--check]')
// DOS timestamps are local-time fields: use the same wall clock in every timezone.
const fixtureTimestamp = new Date(2000, 0, 1, 0, 0, 0)

await buildArchive('empty', 'valid', emptyEntries())
await buildArchive('unbound-document', 'valid', unboundDocumentEntries())
await buildArchive('drifted-no-reference-head', 'valid', driftedNoReferenceHeadEntries())
await buildArchive('bound-history', 'valid', boundHistoryEntries())
await buildArchive('invalid-manifest', 'invalid', invalidManifestEntries())
await buildArchive('dangling-reference', 'invalid', danglingReferenceEntries())
await buildArchive('markdown-bom', 'invalid', markdownBomEntries())
await buildArchive('content-hash-mismatch', 'invalid', contentHashMismatchEntries())
await buildArchive('unsupported-version', 'invalid', unsupportedVersionEntries())
await buildArchive('malformed-version', 'invalid', malformedVersionEntries())
await buildArchive('duplicate-json-key', 'invalid', {
  ...emptyEntries(), 'manifest.json': Buffer.from('{"format":"mdv","for\\u006dat":"mdv"}'),
})
await buildArchive('invalid-utf8', 'invalid', {
  ...emptyEntries(), 'doc_tree/current.md': Buffer.from([0xc3, 0x28]),
})
await buildArchive('dangling-head', 'invalid', {
  ...emptyEntries(), 'doc_tree/HEAD': Buffer.from(`v_${'1'.repeat(32)}\n`),
})
const missingCurrent = emptyEntries()
delete missingCurrent['ref_tree/current.md']
await buildArchive('missing-current', 'invalid', missingCurrent)
const parentCycle = documentEntries(null)
const cycleMetaPath = Object.keys(parentCycle).find((name) => name.endsWith('/meta.json'))
const cycleMeta = JSON.parse(parentCycle[cycleMetaPath])
parentCycle[cycleMetaPath] = json({ ...cycleMeta, parent: cycleMeta.id })
await buildArchive('parent-cycle', 'invalid', parentCycle)
console.log(`Fixtures ${check ? 'match' : 'generated'} (deterministic ZIP32, no system zip command).`)

async function buildArchive(name, kind, entries) {
  // Deliberately independent of the Core writer so fixtures can detect its regressions.
  const zip = new yazl.ZipFile()
  for (const entryName of Object.keys(entries).sort()) {
    zip.addBuffer(entries[entryName], entryName, {
      compress: false, mtime: fixtureTimestamp, forceDosTimestamp: true, mode: 0o100600,
    })
  }
  zip.end()
  const chunks = []
  for await (const chunk of zip.outputStream) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  const path = join(fixtureRoot, kind, `${name}.mdv`)
  if (check) assert.deepEqual(bytes, await readFile(path), `${path}: run npm run fixtures`)
  else {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
}

function emptyEntries() {
  return {
    'manifest.json': json(manifest(0)),
    'ref_tree/current.md': Buffer.alloc(0),
    'doc_tree/current.md': Buffer.alloc(0),
  }
}

function unboundDocumentEntries() {
  return documentEntries(null)
}

function danglingReferenceEntries() {
  return documentEntries(`v_${'2'.repeat(32)}`)
}

function driftedNoReferenceHeadEntries() {
  const reference = `v_${'2'.repeat(32)}`
  const document = `v_${'a'.repeat(32)}`
  const referenceContent = Buffer.from('# Historical reference\n')
  const documentContent = Buffer.from('# Bound document\n')
  return {
    'manifest.json': json(manifest(2)),
    'ref_tree/current.md': Buffer.alloc(0),
    'doc_tree/HEAD': Buffer.from(`${document}\n`),
    'doc_tree/current.md': documentContent,
    ...versionEntries(
      'ref_tree',
      reference,
      null,
      '2026-09-06T01:00:00Z',
      'Historical reference without a current Head',
      referenceContent,
    ),
    ...versionEntries(
      'doc_tree',
      document,
      null,
      '2026-09-06T02:00:00Z',
      'Document bound to historical reference',
      documentContent,
      { referenceVersion: reference },
    ),
  }
}

function boundHistoryEntries() {
  const referenceOne = `v_${'1'.repeat(32)}`
  const referenceTwo = `v_${'2'.repeat(32)}`
  const referenceBranch = `v_${'3'.repeat(32)}`
  const documentOne = `v_${'a'.repeat(32)}`
  const documentTwo = `v_${'b'.repeat(32)}`
  const referenceOneContent = Buffer.from('# Reference one\n')
  const referenceTwoContent = Buffer.from('# Reference two\n')
  const referenceBranchContent = Buffer.from('# Reference branch\n')
  const documentOneContent = Buffer.from('# Document one\n')
  const documentTwoContent = Buffer.from('# Document two\n')

  return {
    'manifest.json': json({ ...manifest(5), fixtureExtension: { enabled: true } }),
    'ref_tree/HEAD': Buffer.from(`${referenceTwo}\n`),
    'ref_tree/current.md': referenceTwoContent,
    'doc_tree/HEAD': Buffer.from(`${documentTwo}\n`),
    'doc_tree/current.md': documentTwoContent,
    ...versionEntries(
      'ref_tree',
      referenceOne,
      null,
      '2026-09-06T01:00:00Z',
      'Initial reference',
      referenceOneContent,
    ),
    ...versionEntries(
      'ref_tree',
      referenceTwo,
      referenceOne,
      '2026-09-06T02:00:00Z',
      'Update reference',
      referenceTwoContent,
    ),
    ...versionEntries(
      'ref_tree',
      referenceBranch,
      referenceOne,
      '2026-09-06T03:00:00Z',
      'Branch reference',
      referenceBranchContent,
      { fixtureExtension: true },
    ),
    ...versionEntries(
      'doc_tree',
      documentOne,
      null,
      '2026-09-06T04:00:00Z',
      'Initial document',
      documentOneContent,
      { referenceVersion: referenceOne },
    ),
    ...versionEntries(
      'doc_tree',
      documentTwo,
      documentOne,
      '2026-09-06T05:00:00Z',
      'Update document',
      documentTwoContent,
      { referenceVersion: referenceTwo },
    ),
  }
}

function documentEntries(referenceVersion) {
  const id = `v_${'1'.repeat(32)}`
  const content = Buffer.from('# Hello\n')
  return {
    'manifest.json': json(manifest(1)),
    'ref_tree/current.md': Buffer.alloc(0),
    'doc_tree/HEAD': Buffer.from(`${id}\n`),
    'doc_tree/current.md': content,
    [`doc_tree/versions/${id}/meta.json`]: json({
      schemaVersion: 1,
      id,
      parent: null,
      createdAt: '2026-09-06T12:00:00+08:00',
      actor: { type: 'human', name: 'Fixture author' },
      summary: 'Initial document',
      contentSha256: createHash('sha256').update(content).digest('hex'),
      contentBytes: content.byteLength,
      referenceVersion,
    }),
    [`doc_tree/versions/${id}/content.md`]: content,
  }
}

function versionEntries(tree, id, parent, createdAt, summary, content, extraMeta = {}) {
  const directory = `${tree}/versions/${id}`
  return {
    [`${directory}/meta.json`]: json({
      schemaVersion: 1,
      id,
      parent,
      createdAt,
      actor: { type: 'agent', id: 'fixture-builder' },
      summary,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      contentBytes: content.byteLength,
      ...extraMeta,
    }),
    [`${directory}/content.md`]: content,
  }
}

function invalidManifestEntries() {
  return {
    ...emptyEntries(),
    'manifest.json': json({ ...manifest(0), format: 'not-mdv' }),
  }
}

function markdownBomEntries() {
  return {
    ...emptyEntries(),
    'doc_tree/current.md': Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x42, 0x4f, 0x4d, 0x0a]),
  }
}

function contentHashMismatchEntries() {
  const id = `v_${'4'.repeat(32)}`
  const content = Buffer.from('# Changed after commit\n')
  return {
    'manifest.json': json(manifest(1)),
    'ref_tree/current.md': Buffer.alloc(0),
    'doc_tree/HEAD': Buffer.from(`${id}\n`),
    'doc_tree/current.md': content,
    [`doc_tree/versions/${id}/meta.json`]: json({
      schemaVersion: 1,
      id,
      parent: null,
      createdAt: '2026-09-06T06:00:00Z',
      actor: { type: 'agent', id: 'fixture-builder' },
      summary: 'Mismatched content hash',
      contentSha256: '0'.repeat(64),
      contentBytes: content.byteLength,
      referenceVersion: null,
    }),
    [`doc_tree/versions/${id}/content.md`]: content,
  }
}

function unsupportedVersionEntries() {
  return {
    ...emptyEntries(),
    'manifest.json': json({ ...manifest(0), formatVersion: '9.9' }),
  }
}

function malformedVersionEntries() {
  return {
    ...emptyEntries(),
    'manifest.json': json({ ...manifest(0), formatVersion: null }),
  }
}

function manifest(generation) {
  return {
    format: 'mdv',
    formatVersion: '0.1',
    documentId: `d_${'0'.repeat(32)}`,
    generation,
    markdownProfile: 'gfm',
  }
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}
