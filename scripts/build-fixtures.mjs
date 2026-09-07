import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureRoot = join(projectRoot, 'fixtures')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mdv-fixtures-'))
const fixtureTimestamp = new Date('2000-01-01T00:00:00Z')

try {
  mkdirSync(join(fixtureRoot, 'valid'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'invalid'), { recursive: true })

  buildArchive('empty', 'valid', emptyEntries())
  buildArchive('unbound-document', 'valid', unboundDocumentEntries())
  buildArchive('drifted-no-reference-head', 'valid', driftedNoReferenceHeadEntries())
  buildArchive('bound-history', 'valid', boundHistoryEntries())
  buildArchive('invalid-manifest', 'invalid', invalidManifestEntries())
  buildArchive('dangling-reference', 'invalid', danglingReferenceEntries())
  buildArchive('markdown-bom', 'invalid', markdownBomEntries())
  buildArchive('content-hash-mismatch', 'invalid', contentHashMismatchEntries())
  buildArchive('unsupported-version', 'invalid', unsupportedVersionEntries())
  buildArchive('malformed-version', 'invalid', malformedVersionEntries())
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function buildArchive(name, kind, entries) {
  const source = join(temporaryRoot, `${kind}-${name}`)
  const temporaryArchive = join(temporaryRoot, `${kind}-${name}.mdv`)
  mkdirSync(source, { recursive: true })

  const names = Object.keys(entries).sort()
  for (const entryName of names) {
    const target = join(source, entryName)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entries[entryName])
    utimesSync(target, fixtureTimestamp, fixtureTimestamp)
  }

  execFileSync('/usr/bin/zip', ['-X', '-0', '-q', temporaryArchive, ...names], {
    cwd: source,
    env: { ...process.env, TZ: 'UTC' },
  })
  copyFileSync(temporaryArchive, join(fixtureRoot, kind, `${name}.mdv`))
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
