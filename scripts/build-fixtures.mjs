import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureRoot = join(projectRoot, 'fixtures')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mdv-fixtures-'))

try {
  mkdirSync(join(fixtureRoot, 'valid'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'invalid'), { recursive: true })

  buildArchive('empty', 'valid', emptyEntries())
  buildArchive('unbound-document', 'valid', unboundDocumentEntries())
  buildArchive('invalid-manifest', 'invalid', invalidManifestEntries())
  buildArchive('dangling-reference', 'invalid', danglingReferenceEntries())
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
  }

  execFileSync('/usr/bin/zip', ['-X', '-0', '-q', temporaryArchive, ...names], { cwd: source })
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

function invalidManifestEntries() {
  return {
    ...emptyEntries(),
    'manifest.json': json({ ...manifest(0), format: 'not-mdv' }),
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

