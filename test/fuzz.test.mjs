import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

test('seeded ZIP/JSON mutations stay bounded and return classified results', { timeout: 65_000 }, async (t) => {
  const seed = Number(process.env.MDV_FUZZ_SEED ?? 0x4d445630)
  const cases = Number(process.env.MDV_FUZZ_CASES ?? 256)
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'MDV_FUZZ_SEED must be uint32')
  assert.ok(Number.isSafeInteger(cases) && cases >= 1 && cases <= 10_000, 'MDV_FUZZ_CASES must be 1..10000')
  const worker = new Worker(new URL('./helpers/fuzz-worker.mjs', import.meta.url), {
    workerData: { seed, cases }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
  })
  let progress = { seed, case: -1 }
  let completed
  try {
    await new Promise((resolve, reject) => {
      // Parent can terminate a stuck synchronous parser; node:test timeout alone cannot.
      const timer = setTimeout(() => {
        reject(new Error(`Fuzz time budget exceeded: ${JSON.stringify(progress)}`))
        void worker.terminate()
      }, 60_000)
      worker.on('message', (message) => {
        progress = message
        if (message.complete) completed = message
      })
      worker.once('error', (error) => { clearTimeout(timer); reject(new Error(JSON.stringify(progress), { cause: error })) })
      worker.once('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0 || !completed) reject(new Error(`Fuzz worker exited ${code}: ${JSON.stringify(progress)}`))
        else resolve()
      })
    })
    assert.equal(completed.cases, cases)
    t.diagnostic(JSON.stringify(completed))
  } finally {
    await worker.terminate()
  }
})
