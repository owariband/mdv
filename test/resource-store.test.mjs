import assert from 'node:assert/strict'
import {
  appendFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm,
  stat, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { prepareResource } from '../dist/resource/model.js'
import { importResource, readResource, resolveResource } from '../dist/resource/store.js'
import { DOCUMENT_ID, GIF, PNG } from './helpers/resources.mjs'

const IMAGE = prepareResource(DOCUMENT_ID, { bytes: PNG }, 1024)

test('parallel imports converge on complete immutable files without leaving temporary names', async (t) => {
  const base = await temporaryDirectory(t)
  const other = prepareResource(DOCUMENT_ID, { bytes: GIF }, 1024)
  await Promise.all(Array.from({ length: 16 }, (_, index) => importResource(base, index % 2 ? IMAGE : other)))
  assert.deepEqual((await readdir(resourceDirectory(base))).sort(),
    [IMAGE.location.fileName, other.location.fileName].sort())
  assert.deepEqual(Buffer.from(await readResource(base, IMAGE.location, 1024)), PNG)
  assert.equal(await resolveResource(base, IMAGE.location), join(base, IMAGE.location.relativePath))
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(base, IMAGE.location.relativePath))).mode & 0o777, 0o600)
  }
})

test('corrupted targets are reported and never overwritten by another import', async (t) => {
  const base = await temporaryDirectory(t)
  await importResource(base, IMAGE)
  const target = join(base, IMAGE.location.relativePath)
  for (const corrupted of [PNG.subarray(0, 10), Buffer.alloc(PNG.length, 1), GIF]) {
    await writeFile(target, corrupted)
    await assert.rejects(readResource(base, IMAGE.location, 1024), { code: 'INTEGRITY_MISMATCH' })
    await assert.rejects(importResource(base, IMAGE), { code: 'INTEGRITY_MISMATCH' })
    assert.deepEqual(await readFile(target), corrupted)
    // Location alone does not claim content integrity.
    assert.equal(await resolveResource(base, IMAGE.location), target)
  }
})

for (const level of ['assets', 'document', 'file']) {
  test(`sidecar ${level} cannot redirect access through symlinks/junctions`, async (t) => {
    const base = await temporaryDirectory(t)
    const outside = await temporaryDirectory(t)
    const assets = join(base, '.mdv-assets')
    const document = resourceDirectory(base)
    if (level === 'assets') {
      await symlink(outside, assets, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (level === 'document') {
      await mkdir(assets)
      await symlink(outside, document, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      await mkdir(document, { recursive: true })
      const original = join(outside, 'original.png')
      await writeFile(original, PNG)
      try {
        await symlink(original, join(document, IMAGE.location.fileName), 'file')
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
        t.skip('Windows file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege')
        return
      }
    }
    const before = await readdir(outside)
    await assert.rejects(importResource(base, IMAGE), { code: 'INVALID_RESOURCE' }, level)
    await assert.rejects(readResource(base, IMAGE.location, 1024), { code: 'INVALID_RESOURCE' }, level)
    await assert.rejects(resolveResource(base, IMAGE.location), { code: 'INVALID_RESOURCE' }, level)
    assert.deepEqual(await readdir(outside), before)
  })
}

test('non-regular targets are refused while legitimate base-directory aliases work', async (t) => {
  const base = await temporaryDirectory(t)
  const alias = join(await temporaryDirectory(t), 'alias')
  await symlink(base, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await importResource(alias, IMAGE)
  const target = join(base, IMAGE.location.relativePath)
  assert.equal(await resolveResource(alias, IMAGE.location), target)
  await unlink(target)
  await mkdir(target)
  await assert.rejects(readResource(alias, IMAGE.location, 1024), { code: 'INVALID_RESOURCE' })
  await assert.rejects(importResource(alias, IMAGE), { code: 'INVALID_RESOURCE' })
})

test('hard-link aliases are judged by verified bytes, including during publication', async (t) => {
  const base = await temporaryDirectory(t)
  const alias = join(base, 'alias.png')
  await importResource(base, IMAGE, {
    async checkpoint(stage, context) {
      if (stage === 'after-publish') {
        assert.ok((await stat(context.path)).nlink >= 2)
        await importResource(base, IMAGE)
        assert.deepEqual(Buffer.from(await readResource(base, IMAGE.location, 1024)), PNG)
      }
    },
  })
  await link(join(base, IMAGE.location.relativePath), alias)
  await importResource(base, IMAGE)
  await writeFile(alias, GIF)
  await assert.rejects(readResource(base, IMAGE.location, 1024), { code: 'INTEGRITY_MISMATCH' })
})

test('bounded reads check both initial size and growth after opening', async (t) => {
  const base = await temporaryDirectory(t)
  await importResource(base, IMAGE)
  assert.deepEqual(Buffer.from(await readResource(base, IMAGE.location, PNG.length)), PNG)
  await assert.rejects(readResource(base, IMAGE.location, PNG.length - 1), { code: 'LIMIT_EXCEEDED' })
  await assert.rejects(readResource(base, IMAGE.location, PNG.length, {
    async checkpoint(stage, { path }) {
      if (stage === 'after-open') await appendFile(path, Buffer.from([0]))
    },
  }), { code: 'LIMIT_EXCEEDED' })
})

test('resource reads use one opened file even if its pathname is atomically replaced', async (t) => {
  const base = await temporaryDirectory(t)
  await importResource(base, IMAGE)
  const bytes = await readResource(base, IMAGE.location, 1024, {
    async checkpoint(stage, { path }) {
      if (stage === 'after-open') {
        await writeFile(`${path}.replacement`, GIF)
        await rename(`${path}.replacement`, path)
      }
    },
  })
  assert.deepEqual(Buffer.from(bytes), PNG)
  await assert.rejects(readResource(base, IMAGE.location, 1024), { code: 'INTEGRITY_MISMATCH' })
})

test('in-place writes during a read report a conflict', async (t) => {
  const base = await temporaryDirectory(t)
  await importResource(base, IMAGE)
  let changed = false
  await assert.rejects(readResource(base, IMAGE.location, 1024, {
    async checkpoint(stage, { path }) {
      if (stage === 'after-read-chunk' && !changed) {
        changed = true
        await appendFile(path, Buffer.from([0]))
      }
    },
  }), { code: 'CONFLICT' })
})

test('pre-publication failures leave no target; post-publication failures remain safely retryable', async (t) => {
  for (const stage of ['after-temp-write', 'before-temp-sync', 'before-publish',
    'after-publish', 'before-temp-cleanup', 'before-directory-sync']) {
    const base = await temporaryDirectory(t)
    const committed = ['after-publish', 'before-temp-cleanup', 'before-directory-sync'].includes(stage)
    await assert.rejects(importResource(base, IMAGE, {
      checkpoint(point) {
        if (point === stage) throw new Error(`Injected ${stage}`)
      },
    }), (error) => {
      assert.equal(error.code, 'IO_ERROR')
      assert.equal(error.details.committed, committed, stage)
      assert.equal(error.details.relativePath, IMAGE.location.relativePath)
      return true
    })
    assert.deepEqual(await readdir(resourceDirectory(base)), committed ? [IMAGE.location.fileName] : [])
    await importResource(base, IMAGE)
    assert.deepEqual(Buffer.from(await readResource(base, IMAGE.location, 1024)), PNG)
  }
})

test('readers see no target before publication and complete bytes immediately afterward', async (t) => {
  const base = await temporaryDirectory(t)
  await importResource(base, IMAGE, {
    async checkpoint(stage) {
      if (stage === 'before-publish') {
        await assert.rejects(readResource(base, IMAGE.location, 1024), { code: 'NOT_FOUND' })
      } else if (stage === 'after-publish') {
        assert.deepEqual(Buffer.from(await readResource(base, IMAGE.location, 1024)), PNG)
      }
    },
  })
})

test('corrupted or replaced temporary resources are rejected before publication', async (t) => {
  for (const stage of ['after-temp-write', 'before-publish']) {
    const base = await temporaryDirectory(t)
    await assert.rejects(importResource(base, IMAGE, {
      async checkpoint(point, { tempPath }) {
        if (point === stage) await writeFile(tempPath, GIF)
      },
    }), (error) => {
      assert.equal(error.code, stage === 'after-temp-write' ? 'INTEGRITY_MISMATCH' : 'CONFLICT')
      assert.equal(error.details.committed, false)
      return true
    })
    assert.deepEqual(await readdir(resourceDirectory(base)), [])
  }
})

test('retargeted resource directories block publication and unsafe cleanup', async (t) => {
  const base = await temporaryDirectory(t)
  const outside = await temporaryDirectory(t)
  await assert.rejects(importResource(base, IMAGE, {
    async checkpoint(stage, { tempPath }) {
      if (stage === 'before-publish') {
        const directory = dirname(tempPath)
        await rename(directory, `${directory}.old`)
        await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
      }
    },
  }), (error) => {
    assert.equal(error.code, 'CONFLICT')
    assert.equal(error.details.committed, false)
    assert.equal(error.details.cleanupFailures.length, 1)
    return true
  })
  assert.deepEqual(await readdir(outside), [])
})

function resourceDirectory(base) {
  return join(base, '.mdv-assets', DOCUMENT_ID)
}

async function temporaryDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mdv-resource-store-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
