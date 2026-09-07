import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeDocumentVersionValue,
  decodeManifestValue,
  decodeReferenceVersionValue,
  encodeDocumentVersionValue,
  encodeReferenceVersionValue,
  FormatDecodeError,
} from '../dist/archive/codec.js'

const VERSION = `v_${'1'.repeat(32)}`

test('manifest codec preserves extension fields and reports warnings', () => {
  const decoded = decodeManifestValue({
    format: 'mdv',
    formatVersion: '0.1',
    documentId: `d_${'0'.repeat(32)}`,
    generation: 0,
    markdownProfile: 'company-gfm',
    extension: { enabled: true },
  })

  assert.deepEqual(decoded.value.extension, { enabled: true })
  assert.deepEqual(decoded.warnings.map((warning) => warning.code), [
    'UNKNOWN_FIELD',
    'UNKNOWN_MARKDOWN_PROFILE',
  ])
})

test('version codecs distinguish Reference and Document metadata', () => {
  const reference = decodeReferenceVersionValue(versionMeta(VERSION)).value
  const document = decodeDocumentVersionValue({
    ...versionMeta(VERSION),
    referenceVersion: null,
  }).value

  assert.equal(reference.id, VERSION)
  assert.equal(document.referenceVersion, null)
})

test('version encoders emit canonical JSON that round-trips through their decoders', () => {
  const referenceValue = {
    ...versionMeta(VERSION),
    extension: { reviewed: true },
  }
  const documentValue = {
    ...versionMeta(`v_${'2'.repeat(32)}`),
    parent: VERSION,
    referenceVersion: VERSION,
  }

  const referenceBytes = encodeReferenceVersionValue(referenceValue)
  const documentBytes = encodeDocumentVersionValue(documentValue)

  assert.equal(Buffer.from(referenceBytes).toString('utf8'), `${JSON.stringify(referenceValue, null, 2)}\n`)
  assert.equal(Buffer.from(documentBytes).toString('utf8'), `${JSON.stringify(documentValue, null, 2)}\n`)
  assert.deepEqual(
    JSON.parse(JSON.stringify(decodeReferenceVersionValue(JSON.parse(referenceBytes)).value)),
    referenceValue,
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(decodeDocumentVersionValue(JSON.parse(documentBytes)).value)),
    documentValue,
  )
})

test('document version encoder requires referenceVersion', () => {
  assert.throws(
    () => encodeDocumentVersionValue(versionMeta(VERSION)),
    (error) => {
      assert.ok(error instanceof FormatDecodeError)
      assert.equal(error.kind, 'document-version')
      assert.ok(error.issues.some((issue) => issue.path === '$/referenceVersion'))
      return true
    },
  )
})

test('version encoders reject metadata invalid under the decode contract', () => {
  const invalidValues = [
    { ...versionMeta('invalid-id') },
    { ...versionMeta(VERSION), actor: { type: 'robot' } },
    { ...versionMeta(VERSION), summary: '   ' },
    { ...versionMeta(VERSION), createdAt: '2026-02-30T12:00:00Z' },
    { ...versionMeta(VERSION), contentSha256: 'invalid-hash' },
  ]

  for (const value of invalidValues) {
    assert.throws(() => encodeReferenceVersionValue(value), FormatDecodeError)
  }
})

test('codec collects field errors instead of accepting partial metadata', () => {
  assert.throws(
    () => decodeDocumentVersionValue({
      ...versionMeta('bad-id'),
      actor: { type: 'robot' },
      summary: '   ',
      referenceVersion: 12,
    }),
    (error) => {
      assert.ok(error instanceof FormatDecodeError)
      assert.equal(error.kind, 'document-version')
      assert.ok(error.issues.length >= 4)
      return true
    },
  )
})

test('codec rejects calendar dates that only match the timestamp shape', () => {
  assert.throws(
    () => decodeReferenceVersionValue({
      ...versionMeta(VERSION),
      createdAt: '2026-02-30T12:00:00Z',
    }),
    FormatDecodeError,
  )
})

function versionMeta(id) {
  return {
    schemaVersion: 1,
    id,
    parent: null,
    createdAt: '2026-09-06T12:00:00+08:00',
    actor: { type: 'human', name: 'Reviewer' },
    summary: 'Initial version',
    contentSha256: '0'.repeat(64),
    contentBytes: 0,
  }
}
