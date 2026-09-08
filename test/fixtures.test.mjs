import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { openMdv, parseMdv, verifyMdv } from '../dist/index.js'

const expectations = (await readdir('fixtures/expected')).filter((name) => name.endsWith('.json')).sort()
test('every checked-in archive has exactly one conformance expectation', async () => {
  const archives = (await Promise.all(['valid', 'invalid'].map(async (kind) =>
    (await readdir(join('fixtures', kind))).filter((name) => name.endsWith('.mdv')).map((name) => name.slice(0, -4))))).flat()
  assert.deepEqual(archives.sort(), expectations.map((name) => name.slice(0, -5)))
})
for (const name of expectations) {
  test(`Format 0.1 conformance: ${name}`, async () => {
    const expected = JSON.parse(await readFile(join('fixtures/expected', name), 'utf8'))
    const path = join('fixtures', expected.valid ? 'valid' : 'invalid', name.replace(/\.json$/, '.mdv'))
    const bytes = await readFile(path)
    for (const input of [path, bytes]) {
      const report = await verifyMdv(input, { mode: 'full' })
      assert.equal(report.valid, expected.valid)
      if (!expected.valid) {
        assert.ok(report.issues.some(({ code }) => code === expected.errorCode), JSON.stringify(report))
        continue
      }
      assert.equal(report.complete, true)
      const snapshot = typeof input === 'string' ? await openMdv(input) : await parseMdv(input)
      assert.equal(snapshot.manifest.generation, expected.generation)
      assert.equal(snapshot.referenceTree.head, expected.referenceHead)
      assert.equal(snapshot.documentTree.head, expected.documentHead)
      assert.equal(snapshot.listVersions({ tree: 'reference' }).length, expected.referenceVersions)
      assert.equal(snapshot.listVersions({ tree: 'document' }).length, expected.documentVersions)
      if ('documentReference' in expected) {
        assert.equal(snapshot.getDocumentReference(snapshot.documentTree.head), expected.documentReference)
      }
      for (const version of snapshot.listVersions()) await snapshot.readVersionBytes(version.id)
    }
  })
}
