import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  DEFAULT_RESOURCE_MAX_BYTES,
  identifyImage,
  parseResourcePath,
  prepareResource,
  resolveResourceLimit,
  validateResourceContent,
} from '../dist/resource/model.js'
import { DOCUMENT_ID, GIF, JPEG_HEADER, PNG, WEBP } from './helpers/resources.mjs'

test('resource content uniquely determines MIME, hash and canonical extension', () => {
  for (const [bytes, mediaType, extension] of [
    [PNG, 'image/png', 'png'], [JPEG_HEADER, 'image/jpeg', 'jpg'],
    [GIF, 'image/gif', 'gif'], [WEBP, 'image/webp', 'webp'],
  ]) {
    assert.equal(identifyImage(bytes), mediaType)
    const resource = prepareResource(DOCUMENT_ID, { bytes }, 1024)
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(resource.location.relativePath, `./.mdv-assets/${DOCUMENT_ID}/${hash}.${extension}`)
    assert.equal(resource.location.mediaType, mediaType)
    assert.equal(Object.isFrozen(resource.location), true)
    assert.equal(Object.isFrozen(resource), true)
    assert.deepEqual(prepareResource(DOCUMENT_ID, { bytes, mediaType }, 1024), resource)
  }
})

test('managed paths accept only canonical components and the current document', () => {
  const path = prepareResource(DOCUMENT_ID, { bytes: PNG }, 1024).location.relativePath
  assert.deepEqual(parseResourcePath(DOCUMENT_ID, path), parseResourcePath(DOCUMENT_ID, path.slice(2)))
  const invalid = [
    '', './assets/cat.png', `/notes/${path}`, `../${path}`, path.replace('./', './x/../'),
    path.replaceAll('/', '\\'), `${path}?x=1`, `${path}#image`, `${path}\n`, `${path}\0`,
    path.replace('.png', '.png.exe'), path.replace('.png', '.PNG'),
    path.replace('.png', '.jpeg'), path.replace('.png', '.svg'),
    path.replace('mdv-assets', 'MDV-ASSETS'), path.replace('./', '%2e%2f'),
    path.replace(/\/[0-9a-f]{64}/, '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  ]
  for (const candidate of invalid) {
    assert.throws(() => parseResourcePath(DOCUMENT_ID, candidate), { code: 'INVALID_RESOURCE' }, candidate)
  }
  assert.throws(() => parseResourcePath(`d_${'b'.repeat(32)}`, path), (error) => {
    assert.equal(error.code, 'INVALID_RESOURCE')
    assert.equal(error.details.reason, 'wrong-document')
    return true
  })
})

test('image identification rejects unsupported, short and misleading headers', () => {
  const highBitGif = Buffer.from(GIF)
  highBitGif[0] |= 0x80
  const truncatedWebp = WEBP.subarray(0, WEBP.length - 1)
  for (const bytes of [Buffer.alloc(0), PNG.subarray(0, 8), Buffer.from('<svg/>'),
    Buffer.from('plain text'), highBitGif, truncatedWebp]) {
    assert.throws(() => identifyImage(bytes), { code: 'INVALID_RESOURCE' })
  }
  assert.throws(() => prepareResource(DOCUMENT_ID, { bytes: PNG, mediaType: 'image/jpeg' }, 1024),
    { code: 'INVALID_RESOURCE' })
})

test('resource limits apply at the exact boundary and inputs are copied immediately', () => {
  assert.equal(DEFAULT_RESOURCE_MAX_BYTES, 32 * 1024 * 1024)
  assert.equal(resolveResourceLimit(), DEFAULT_RESOURCE_MAX_BYTES)
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, null, '32']) {
    assert.throws(() => resolveResourceLimit({ maxBytes }), RangeError)
  }
  assert.throws(() => resolveResourceLimit(null), TypeError)
  assert.throws(() => prepareResource(DOCUMENT_ID, { bytes: PNG }, PNG.length - 1),
    { code: 'LIMIT_EXCEEDED' })
  const input = Buffer.from(PNG)
  const prepared = prepareResource(DOCUMENT_ID, { bytes: input }, PNG.length)
  input.fill(0)
  assert.deepEqual(Buffer.from(prepared.bytes), PNG)
})

test('hash and extension integrity are verified independently of the supplied filename', () => {
  const { location } = prepareResource(DOCUMENT_ID, { bytes: PNG }, 1024)
  validateResourceContent(PNG, location)
  assert.throws(() => validateResourceContent(GIF, location), { code: 'INTEGRITY_MISMATCH' })
  const wrongType = parseResourcePath(DOCUMENT_ID, location.relativePath.replace('.png', '.jpg'))
  assert.throws(() => validateResourceContent(PNG, wrongType), { code: 'INTEGRITY_MISMATCH' })
  const raw = Buffer.from('not an image')
  const hash = createHash('sha256').update(raw).digest('hex')
  const unsupported = parseResourcePath(DOCUMENT_ID, `./.mdv-assets/${DOCUMENT_ID}/${hash}.png`)
  assert.throws(() => validateResourceContent(raw, unsupported), { code: 'INTEGRITY_MISMATCH' })
})
