import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMdv } from '../dist/index.js'
import { DEFAULT_READ_LIMITS } from '../dist/archive/limits.js'

test('freezes the documented Format 0.1 default read budgets', () => {
  assert.deepEqual(DEFAULT_READ_LIMITS, {
    maxEntries: 30_010, maxEntryBytes: 64 * 1024 * 1024,
    maxTotalUncompressedBytes: 512 * 1024 * 1024, maxCompressionRatio: 100,
    maxVersions: 10_000, maxJsonBytes: 1024 * 1024, maxJsonDepth: 32,
  })
  assert.ok(Object.isFrozen(DEFAULT_READ_LIMITS))
})

test('Windows ambiguous target names fail before any archive or lock is created', {
  skip: process.platform !== 'win32' ? 'Windows pathname normalization contract' : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-windows-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['example.mdv.', 'example.mdv ']) {
    await assert.rejects(createMdv(join(directory, name)), (error) => {
      assert.equal(error.code, 'IO_ERROR')
      assert.equal(error.details.reason, 'windows-trailing-dot-or-space')
      assert.equal(error.details.committed, false)
      return true
    })
  }
  assert.deepEqual(await readdir(directory), [])
})
