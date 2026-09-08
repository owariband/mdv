import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { openMdv, verifyMdv } from '../dist/index.js'
import { emptyEntries, zipEntries } from '../test/helpers/archive.mjs'

if (process.argv[2] === '--worker') {
  await measure(process.argv[3], Number(process.argv[4]), Number(process.argv[5]))
} else {
  assert.ok(process.argv.slice(2).every((arg) => arg === '--quick'), 'usage: npm run bench -- [--quick]')
  const quick = process.argv.includes('--quick')
  const directory = await mkdtemp(join(tmpdir(), 'mdv-benchmark-'))
  const results = []
  try {
    for (const versions of quick ? [10] : [10, 100, 1000]) {
      for (const contentBytes of quick ? [2048] : [2048, 65_536]) {
        const path = join(directory, `${versions}-${contentBytes}.mdv`)
        // Setup runs in the parent; its archive buffers do not inflate measured child RSS.
        await writeFile(path, await historyArchive(versions, contentBytes))
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [
          fileURLToPath(import.meta.url), '--worker', path, String(versions), String(contentBytes),
        ], { timeout: 180_000, maxBuffer: 1024 * 1024 })
        process.stderr.write(stderr)
        results.push(JSON.parse(stdout))
      }
    }
    console.log(JSON.stringify({
      schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version,
      platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
      repetitions: 3, statistic: 'median', rssUnit: 'KiB',
      notes: 'Local warm-cache baseline, not an SLA. Peak RSS covers the entire worker, not each operation. Versions = initial total across both trees.',
      results,
    }, null, 2))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function measure(path, versions, contentBytes) {
  const archiveBytes = (await stat(path)).size
  const samples = { open: [], historyRead: [], trace: [], fullVerify: [], save: [], commit: [] }
  for (let repetition = 0; repetition < 3; repetition++) {
    let document = await timed('open', () => openMdv(path))
    assert.equal(document.listVersions().length, versions + repetition)
    const oldest = document.getHistory('document').at(-1).id
    const bytes = await timed('historyRead', () => document.readVersionBytes(oldest))
    assert.equal(bytes.byteLength, contentBytes)
    const trace = await timed('trace', () => document.traceDocument(document.documentTree.head))
    assert.ok(trace.reference)
    const report = await timed('fullVerify', () => verifyMdv(path, { mode: 'full' }))
    assert.equal(report.valid, true)
    document = await timed('save', () => document.saveDocument({
      markdown: body(contentBytes, `changed-${repetition}`), expectedGeneration: document.manifest.generation,
    }))
    const result = await timed('commit', () => document.commitDocument({
      expectedGeneration: document.manifest.generation, referenceVersion: document.referenceTree.head,
      actor: { type: 'agent', id: 'benchmark' }, summary: `Benchmark ${repetition}`,
    }))
    assert.equal(result.created, true)
    assert.equal(result.document.listVersions().length, versions + repetition + 1)
  }
  console.log(JSON.stringify({
    versions, contentBytes, archiveBytes,
    medianMs: Object.fromEntries(Object.entries(samples).map(([name, values]) =>
      [name, Number([...values].sort((a, b) => a - b)[1].toFixed(3))])),
    samplesMs: samples, peakRssKiB: process.resourceUsage().maxRSS,
  }))
  async function timed(name, operation) {
    const start = performance.now()
    const result = await operation()
    samples[name].push(Number((performance.now() - start).toFixed(3)))
    return result
  }
}

async function historyArchive(versions, contentBytes) {
  const entries = emptyEntries()
  const manifest = JSON.parse(entries[0][1])
  entries[0][1] = Buffer.from(JSON.stringify({ ...manifest, generation: versions }))
  const referenceCount = Math.floor(versions / 2)
  const referenceHead = versionId(referenceCount)
  for (const [tree, start, count, currentIndex] of [
    ['ref_tree', 1, referenceCount, 1],
    ['doc_tree', referenceCount + 1, versions - referenceCount, 2],
  ]) {
    for (let index = 0; index < count; index++) {
      const id = versionId(start + index)
      const content = body(contentBytes, `${tree}-${index}`)
      const meta = {
        schemaVersion: 1, id, parent: index === 0 ? null : versionId(start + index - 1),
        createdAt: new Date(Date.UTC(2026, 0, 1) + (start + index) * 1000).toISOString(),
        actor: { type: 'agent', id: 'benchmark' }, summary: `Version ${index}`,
        contentSha256: createHash('sha256').update(content).digest('hex'), contentBytes,
        ...(tree === 'doc_tree' ? { referenceVersion: referenceHead } : {}),
      }
      entries.push([`${tree}/versions/${id}/meta.json`, Buffer.from(JSON.stringify(meta))],
        [`${tree}/versions/${id}/content.md`, content])
      if (index === count - 1) {
        entries[currentIndex][1] = content
        entries.push([`${tree}/HEAD`, Buffer.from(`${id}\n`)])
      }
    }
  }
  return zipEntries(entries)
}

function versionId(index) { return `v_${index.toString(16).padStart(32, '0')}` }
function body(size, label) {
  const prefix = Buffer.from(`# ${label}\n`)
  assert.ok(prefix.length < size)
  const bytes = Buffer.alloc(size, 65)
  bytes.set(prefix)
  bytes[size - 1] = 10
  return bytes
}
