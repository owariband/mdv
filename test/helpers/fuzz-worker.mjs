import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { MdvError, parseMdv, verifyMdv } from '../../dist/index.js'
import { emptyEntries, zipEntries } from './archive.mjs'

const { seed, cases } = workerData
let state = seed || 1
const limits = { maxEntries: 64, maxEntryBytes: 32_768, maxTotalUncompressedBytes: 131_072,
  maxCompressionRatio: 100, maxVersions: 16, maxJsonBytes: 4096, maxJsonDepth: 16 }
const corpus = await Promise.all(['valid/empty', 'valid/bound-history', 'invalid/content-hash-mismatch']
  .map((name) => readFile(new URL(`../../fixtures/${name}.mdv`, import.meta.url))))
let accepted = 0
let rejected = 0
for (let index = 0; index < cases; index++) {
  const kind = index % 6
  parentPort.postMessage({ seed, case: index, kind })
  let bytes = Buffer.from(corpus[random(corpus.length)])
  if (kind === 0) {
    bytes = bytes.subarray(0, random(bytes.length))
  } else if (kind === 1) {
    for (let count = 0; count < 1 + random(8); count++) bytes[random(bytes.length)] ^= 1 << random(8)
  } else if (kind === 2) {
    bytes = Buffer.from(Array.from({ length: random(2048) }, () => random(256)))
  } else if (kind === 3 || kind === 4) {
    const entries = emptyEntries()
    const value = { ...JSON.parse(entries[0][1]), extension: { values: [random(100), '中文', null] } }
    let json = JSON.stringify(value)
    if (kind === 3) {
      const offset = random(json.length)
      json = json.slice(0, offset) + String.fromCharCode(random(128)) + json.slice(offset + 1)
    }
    entries[0][1] = Buffer.from(json)
    entries[2][1] = Buffer.from(`seed=${seed}, case=${index}, unicode=🐱\r\n`)
    bytes = await zipEntries(entries)
  } // kind 5 exercises untouched valid and lazily-invalid archive paths.
  const before = Buffer.from(bytes)
  let fullyReadable = false
  try {
    const snapshot = await parseMdv(bytes, { limits })
    await snapshot.readDocument()
    await snapshot.readReference()
    for (const version of snapshot.listVersions()) await snapshot.readVersionBytes(version.id)
    fullyReadable = true
    accepted++
  } catch (error) {
    assert.ok(error instanceof MdvError, `Unclassified error, seed=${seed}, case=${index}: ${error}`)
    rejected++
  }
  const report = await verifyMdv(bytes, { mode: 'full', maxIssues: 8, limits })
  assert.equal(report.valid, fullyReadable, `Read/verify disagreement, seed=${seed}, case=${index}`)
  assert.ok(report.issues.length <= 8)
  assert.deepEqual(bytes, before, 'Parser mutated the input buffer')
}
parentPort.postMessage({ complete: true, seed, cases, accepted, rejected })

function random(max) {
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return (state >>> 0) % max
}
