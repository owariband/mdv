import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as yazl from 'yazl'

import { ArchiveError } from '../dist/archive/errors.js'
import { parseJsonEntry } from '../dist/archive/json.js'
import {
  openArchiveFromBytes,
  openArchiveFromPath,
} from '../dist/archive/reader.js'
import { hydrateArchiveIndex } from '../dist/core/hydrate.js'
import { GraphValidationError } from '../dist/core/invariants.js'

test('opens the empty initialization fixture from a path', async () => {
  const archive = await openArchiveFromPath('fixtures/valid/empty.mdv')
  const state = hydrateArchiveIndex(archive)

  assert.equal(state.manifest.generation, 0)
  assert.equal((await archive.readWorkingCopy('reference')).byteLength, 0)
  assert.equal((await archive.readWorkingCopy('document')).byteLength, 0)
})

test('opens an unbound Document fixture from bytes and lazily verifies content', async () => {
  const bytes = await readFile('fixtures/valid/unbound-document.mdv')
  const archive = await openArchiveFromBytes(bytes)
  const state = hydrateArchiveIndex(archive)
  const version = state.documentHead

  assert.ok(version)
  assert.equal(state.references.size, 0)
  assert.equal(state.documents.get(version)?.referenceVersion, null)
  assert.equal(new TextDecoder().decode(await archive.readVersionContent('document', version)), '# Hello\n')
})

test('maps a non-MDV manifest before shape validation', async () => {
  await assert.rejects(
    openArchiveFromPath('fixtures/invalid/invalid-manifest.mdv'),
    (error) => isArchiveError(error, 'NOT_MDV'),
  )
})

test('distinguishes missing paths and ZIP archives without an MDV manifest', async () => {
  await assert.rejects(
    openArchiveFromPath('fixtures/missing.mdv'),
    (error) => {
      assert.ok(isArchiveError(error, 'NOT_FOUND'))
      assert.equal(error.details.ioCode, 'ENOENT')
      assert.match(error.details.path, /fixtures\/missing\.mdv$/)
      return true
    },
  )

  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
  await assert.rejects(
    openArchiveFromBytes(emptyZip),
    (error) => {
      assert.ok(isArchiveError(error, 'NOT_MDV'))
      assert.equal(error.details.entry, 'manifest.json')
      return true
    },
  )
})

test('keeps malformed ZIP bytes classified as an invalid archive', async () => {
  await assert.rejects(
    openArchiveFromBytes(Buffer.from('not a ZIP archive')),
    (error) => isArchiveError(error, 'INVALID_ARCHIVE'),
  )
})

test('rejects a ZIP64 container even when its MDV layout is otherwise valid', async () => {
  await assert.rejects(
    openArchiveFromBytes(await createMinimalZip64Mdv()),
    (error) => isArchiveError(error, 'INVALID_ARCHIVE'),
  )
})

test('rejects a classic EOCD whose central directory starts on another disk', async () => {
  const bytes = mutateClassicEocd(
    await readFile('fixtures/valid/empty.mdv'),
    (archive, eocdOffset) => archive.writeUInt16LE(1, eocdOffset + 6),
  )

  await assert.rejects(
    openArchiveFromBytes(bytes),
    (error) => isArchiveError(error, 'INVALID_ARCHIVE'),
  )
})

test('rejects a classic EOCD whose per-disk and total entry counts differ', async () => {
  const bytes = mutateClassicEocd(
    await readFile('fixtures/valid/empty.mdv'),
    (archive, eocdOffset) => {
      const totalEntries = archive.readUInt16LE(eocdOffset + 10)
      archive.writeUInt16LE(totalEntries === 0 ? 1 : totalEntries - 1, eocdOffset + 8)
    },
  )

  await assert.rejects(
    openArchiveFromBytes(bytes),
    (error) => isArchiveError(error, 'INVALID_ARCHIVE'),
  )
})

test('rejects a central-directory entry that starts on another disk', async () => {
  const bytes = Buffer.from(await readFile('fixtures/valid/empty.mdv'))
  const centralDirectoryOffset = bytes.indexOf(Buffer.from('504b0102', 'hex'))

  assert.notEqual(centralDirectoryOffset, -1)
  bytes.writeUInt16LE(1, centralDirectoryOffset + 34)

  await assert.rejects(
    openArchiveFromBytes(bytes),
    (error) => isArchiveError(error, 'INVALID_ARCHIVE'),
  )
})

test('rejects the UTF-8 BOM forbidden by the format', async () => {
  assert.throws(
    () => parseJsonEntry(
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      'manifest.json',
      32,
    ),
    (error) => isArchiveError(error, 'INVALID_MANIFEST'),
  )
  await assert.rejects(
    openArchiveFromPath('fixtures/invalid/markdown-bom.mdv'),
    (error) => isArchiveError(error, 'INVALID_UTF8'),
  )
})

test('leaves cross-entry bind validation to Core', async () => {
  const archive = await openArchiveFromPath('fixtures/invalid/dangling-reference.mdv')
  assert.throws(() => hydrateArchiveIndex(archive), GraphValidationError)
})

test('strict JSON parsing rejects duplicate members and excessive nesting', () => {
  assert.throws(
    () => parseJsonEntry(Buffer.from('{"a":1,"a":2}'), 'manifest.json', 32),
    (error) => isArchiveError(error, 'INVALID_MANIFEST'),
  )
  assert.throws(
    () => parseJsonEntry(Buffer.from('{"a":{"b":1}}'), 'manifest.json', 1),
    (error) => isArchiveError(error, 'LIMIT_EXCEEDED'),
  )
})

function isArchiveError(error, code) {
  assert.ok(error instanceof ArchiveError)
  assert.equal(error.code, code)
  return true
}

async function createMinimalZip64Mdv() {
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify({
    format: 'mdv',
    formatVersion: '0.1',
    documentId: 'd_00000000000000000000000000000000',
    generation: 0,
    markdownProfile: 'gfm',
  })), 'manifest.json')
  zip.addBuffer(Buffer.alloc(0), 'ref_tree/current.md')
  zip.addBuffer(Buffer.alloc(0), 'doc_tree/current.md')
  zip.end({ forceZip64Format: true, comment: '' })

  const chunks = []
  for await (const chunk of zip.outputStream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function mutateClassicEocd(bytes, mutate) {
  const archive = Buffer.from(bytes)
  const signature = Buffer.from('504b0506', 'hex')
  const eocdOffset = archive.lastIndexOf(signature)

  assert.notEqual(eocdOffset, -1)
  assert.equal(
    eocdOffset + 22 + archive.readUInt16LE(eocdOffset + 20),
    archive.byteLength,
  )
  mutate(archive, eocdOffset)
  return archive
}
