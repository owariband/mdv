import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MdvError, parseMdv, verifyMdv } from '../dist/index.js'
import { emptyEntries, zipEntries } from './helpers/archive.mjs'

for (const name of ['../escape.md', '/absolute.md', 'C:/drive.md', 'a\\escape.md', 'a/./file.md', 'a//file.md', 'nul\0name.md']) {
  test(`rejects unsafe ZIP path ${JSON.stringify(name)} before layout parsing`, async () => {
    // yazl refuses unsafe names itself: mutate both same-length names in the ZIP.
    const placeholder = 'x'.repeat(Buffer.byteLength(name))
    const bytes = await zipEntries([...emptyEntries(), [placeholder, Buffer.alloc(0)]])
    let count = 0
    for (let offset = bytes.indexOf(placeholder); offset >= 0; offset = bytes.indexOf(placeholder, offset + placeholder.length)) {
      bytes.set(Buffer.from(name), offset)
      count++
    }
    assert.equal(count, 2)
    await rejects(bytes, 'INVALID_ARCHIVE')
  })
}

test('rejects duplicate entries, ASCII case collisions, non-NFC names and ZIP symlinks', async () => {
  for (const extras of [
    [['manifest.json', Buffer.from('{}')]],
    [['MANIFEST.JSON', Buffer.from('{}')]],
    [['e\u0301.md', Buffer.alloc(0)]],
    [['link.md', Buffer.from('../outside'), { mode: 0o120777 }]],
  ]) await rejects(await zipEntries([...emptyEntries(), ...extras]), 'INVALID_ARCHIVE')
})

test('strict JSON rejects malformed UTF-8, duplicate escaped keys and non-JSON values', async () => {
  const invalidUtf8 = emptyEntries()
  invalidUtf8[0][1] = Buffer.from([0xc3, 0x28])
  await rejects(await zipEntries(invalidUtf8), 'INVALID_UTF8')
  for (const manifest of [
    Buffer.from('\ufeff{}'),
    Buffer.from('{"format":"mdv","for\\u006dat":"mdv"}'),
    Buffer.from('{"format":NaN}'), Buffer.from('{"format":Infinity}'),
    Buffer.from('{"format":"mdv",}'), Buffer.from('{} trailing'),
    Buffer.from('{/* comment */}'),
  ]) {
    const entries = emptyEntries()
    entries[0][1] = manifest
    await rejects(await zipEntries(entries), 'INVALID_MANIFEST')
  }
})

test('ZIP entry/total/count/ratio/version/JSON budgets are independently enforced', async () => {
  const empty = await zipEntries(emptyEntries())
  for (const limits of [{ maxEntries: 2 }, { maxEntryBytes: 10 },
    { maxTotalUncompressedBytes: 10 }, { maxJsonBytes: 10 }]) {
    await rejects(empty, 'LIMIT_EXCEEDED', limits)
  }
  const entries = emptyEntries()
  entries[0][1] = Buffer.from(JSON.stringify({ ...JSON.parse(entries[0][1]), extension: { a: { b: true } } }))
  await rejects(await zipEntries(entries), 'LIMIT_EXCEEDED', { maxJsonDepth: 2 })
  entries[2][1] = Buffer.alloc(64 * 1024, 65)
  await rejects(await zipEntries(entries, { compress: true }), 'LIMIT_EXCEEDED', { maxCompressionRatio: 10 })
  await rejects(await readFile('fixtures/valid/bound-history.mdv'), 'LIMIT_EXCEEDED', { maxVersions: 1 })
})

test('unknown JSON extensions do not modify Object.prototype', async () => {
  const entries = emptyEntries()
  entries[0][1] = Buffer.from(entries[0][1].toString().replace(/}$/, ',"__proto__":{"mdvPolluted":true}}'))
  const snapshot = await parseMdv(await zipEntries(entries))
  assert.equal({}.mdvPolluted, undefined)
  assert.ok(snapshot.warnings.some(({ path }) => path === '$/__proto__'))
})

async function rejects(bytes, code, limits) {
  await assert.rejects(parseMdv(bytes, { limits }), (error) => error instanceof MdvError && error.code === code)
  const report = await verifyMdv(bytes, { mode: 'full', limits })
  assert.equal(report.valid, false)
  assert.ok(report.issues.some((issue) => issue.code === code), JSON.stringify(report))
}
