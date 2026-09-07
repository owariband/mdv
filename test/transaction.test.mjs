import assert from 'node:assert/strict'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { ArchiveError } from '../dist/archive/errors.js'
import { canonicalizeTargetPath } from '../dist/archive/lock.js'
import { runArchiveTransaction } from '../dist/archive/transaction.js'
import { hydrateArchiveIndex } from '../dist/core/hydrate.js'
import { createMdv, MdvError, openMdv } from '../dist/index.js'

const CONTENT_HASH_MISMATCH = resolve('fixtures/invalid/content-hash-mismatch.mdv')

test('concurrent creates publish exactly one package and clean transaction artifacts', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'race.mdv')
    const results = await Promise.allSettled([
      createMdv(packagePath),
      createMdv(packagePath),
    ])

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    const rejected = results.find(({ status }) => status === 'rejected')
    assert.ok(rejected)
    assertMdvError(rejected.reason, 'CONFLICT')

    const reopened = await openMdv(packagePath)
    assert.equal(reopened.manifest.generation, 0)
    assert.equal(await reopened.readReferenceText(), '')
    assert.equal(await reopened.readDocumentText(), '')
    assert.deepEqual(await readdir(directory), ['race.mdv'])
  })
})

test('create transactions reject a nonzero initial generation before publishing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'invalid-generation.mdv')

    await assert.rejects(
      runArchiveTransaction(
        packagePath,
        {
          type: 'create',
          manifest: {
            format: 'mdv',
            formatVersion: '0.1',
            documentId: `d_${'9'.repeat(32)}`,
            generation: 1,
            markdownProfile: 'gfm',
          },
        },
        transactionOptions(),
      ),
      (error) => {
        assertArchiveError(error, 'INVALID_MANIFEST')
        assert.equal(error.details.stage, 'check-target')
        assert.equal(error.details.committed, false)
        return true
      },
    )

    assert.deepEqual(await readdir(directory), [])
  })
})

test('same-generation saves commit at most once across concurrent writers', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'race.mdv')
    const initial = await createMdv(packagePath)
    const expectedGeneration = initial.manifest.generation
    const candidates = ['# writer one\n', '# writer two\n']

    const results = await Promise.allSettled(candidates.map((markdown) => (
      initial.saveDocument({ markdown, expectedGeneration })
    )))

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    const rejected = results.find(({ status }) => status === 'rejected')
    assert.ok(rejected)
    assertMdvError(rejected.reason, 'CONFLICT')

    const reopened = await openMdv(packagePath)
    assert.equal(reopened.manifest.generation, expectedGeneration + 1)
    assert.ok(candidates.includes(await reopened.readDocumentText()))
    assert.equal(reopened.listVersions().length, 0)
    assert.deepEqual(await readdir(directory), ['race.mdv'])
  })
})

test('existing path aliases use the filesystem final path for one lock identity', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const canonicalSpelling = join(directory, 'Case-Alias.mdv')
    const alternateSpelling = join(directory, 'case-alias.mdv')
    await createMdv(canonicalSpelling)

    try {
      await openMdv(alternateSpelling)
    } catch (error) {
      if (error instanceof MdvError && error.code === 'NOT_FOUND') {
        t.skip('filesystem is case-sensitive')
        return
      }
      throw error
    }

    assert.equal(
      await canonicalizeTargetPath(canonicalSpelling),
      await canonicalizeTargetPath(alternateSpelling),
    )
  })
})

test('save rejects a symlink target without changing the linked package', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'real.mdv')
    const linkPath = join(directory, 'link.mdv')
    await createMdv(packagePath)
    await symlink(packagePath, linkPath)
    const before = await readFile(packagePath)

    const linked = await openMdv(linkPath)
    await assert.rejects(
      linked.saveDocument({ markdown: '# must not be written\n', expectedGeneration: 0 }),
      (error) => {
        assert.ok(assertMdvError(error, 'IO_ERROR'))
        assert.equal(error.details.reason, 'symlink-target')
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), before)
    const reopened = await openMdv(packagePath)
    assert.equal(reopened.manifest.generation, 0)
    assert.equal(await reopened.readDocumentText(), '')
  })
})

test('save rejects hard-linked path aliases that cannot share a pathname lock', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'original.mdv')
    const aliasPath = join(directory, 'alias.mdv')
    const document = await createMdv(packagePath)
    await link(packagePath, aliasPath)
    const original = await readFile(packagePath)

    await assert.rejects(
      document.saveDocument({ markdown: '# must not fork\n', expectedGeneration: 0 }),
      (error) => {
        assert.ok(assertMdvError(error, 'IO_ERROR'))
        assert.equal(error.details.reason, 'hard-linked-target')
        assert.equal(error.details.links, '2')
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), original)
    assert.deepEqual(await readFile(aliasPath), original)
  })
})

test('checkpoint failures before publish preserve the old bytes and clean artifacts', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'faults.mdv')
    const document = await createMdv(packagePath)
    const original = await readFile(packagePath)
    const cases = [
      ['after-temp-write', 'write-temp'],
      ['after-temp-validate', 'validate-temp'],
      ['before-temp-sync', 'sync-temp'],
      ['before-publish', 'publish'],
    ]

    for (const [checkpoint, expectedStage] of cases) {
      await assert.rejects(
        runArchiveTransaction(
          packagePath,
          {
            type: 'save-working-copy',
            tree: 'document',
            markdown: Buffer.from(`# fail at ${checkpoint}\n`),
            expectedDocumentId: document.manifest.documentId,
            expectedGeneration: 0,
          },
          transactionOptions(failAt(checkpoint)),
        ),
        (error) => {
          assertArchiveError(error, 'IO_ERROR')
          assert.equal(error.details.stage, expectedStage)
          assert.equal(error.details.committed, false)
          assert.equal(error.details.generation, 1)
          return true
        },
      )

      assert.deepEqual(await readFile(packagePath), original)
      const reopened = await openMdv(packagePath)
      assert.equal(reopened.manifest.generation, 0)
      assert.equal(await reopened.readDocumentText(), '')
      assert.deepEqual(await readdir(directory), ['faults.mdv'])
    }
  })
})

test('a directory-sync failure reports that the new generation is committed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'committed.mdv')
    const document = await createMdv(packagePath)
    const markdown = Buffer.from('# already published\n')

    await assert.rejects(
      runArchiveTransaction(
        packagePath,
        {
          type: 'save-working-copy',
          tree: 'document',
          markdown,
          expectedDocumentId: document.manifest.documentId,
          expectedGeneration: 0,
        },
        transactionOptions(failAt('before-directory-sync')),
      ),
      (error) => {
        assertArchiveError(error, 'IO_ERROR')
        assert.equal(error.details.stage, 'sync-directory')
        assert.equal(error.details.committed, true)
        assert.equal(error.details.previousGeneration, 0)
        assert.equal(error.details.generation, 1)
        return true
      },
    )

    const reopened = await openMdv(packagePath)
    assert.equal(reopened.manifest.generation, 1)
    assert.equal(await reopened.readDocumentText(), '# already published\n')
    assert.deepEqual(await readdir(directory), ['committed.mdv'])
  })
})

test('a corrupted temporary archive is rejected before publish', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'corrupt-temp.mdv')
    const document = await createMdv(packagePath)
    const original = await readFile(packagePath)

    await assert.rejects(
      runArchiveTransaction(
        packagePath,
        {
          type: 'save-working-copy',
          tree: 'document',
          markdown: Buffer.from('# must not publish\n'),
          expectedDocumentId: document.manifest.documentId,
          expectedGeneration: 0,
        },
        transactionOptions({
          async checkpoint(stage, context) {
            if (stage === 'after-temp-write') {
              await writeFile(context.tempPath, 'not a ZIP archive')
            }
          },
        }),
      ),
      (error) => {
        assertArchiveError(error, 'INVALID_ARCHIVE')
        assert.equal(error.details.stage, 'validate-temp')
        assert.equal(error.details.committed, false)
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), original)
    assert.deepEqual(await readdir(directory), ['corrupt-temp.mdv'])
  })
})

test('save validates every historical content entry before publishing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'invalid-history.mdv')
    await copyFile(CONTENT_HASH_MISMATCH, packagePath)
    const document = await openMdv(packagePath)
    const original = await readFile(packagePath)

    await assert.rejects(
      document.saveDocument({ markdown: '# must not publish\n', expectedGeneration: 1 }),
      (error) => {
        assert.ok(assertMdvError(error, 'INTEGRITY_MISMATCH'))
        assert.equal(error.details.stage, 'write-temp')
        assert.equal(error.details.committed, false)
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), original)
    assert.deepEqual(await readdir(directory), ['invalid-history.mdv'])
  })
})

test('save preserves a read-only target mode while syncing through an open handle', {
  skip: process.platform === 'win32',
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'read-only.mdv')
    const document = await createMdv(packagePath)
    await chmod(packagePath, 0o444)

    const saved = await document.saveDocument({
      markdown: '# still writable transactionally\n',
      expectedGeneration: 0,
    })

    assert.equal(saved.manifest.generation, 1)
    assert.equal((await stat(packagePath)).mode & 0o777, 0o444)
    assert.equal(await saved.readDocumentText(), '# still writable transactionally\n')
  })
})

test('temporary archives never widen private target permissions', {
  skip: process.platform === 'win32',
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'private.mdv')
    const document = await createMdv(packagePath)
    assert.equal((await stat(packagePath)).mode & 0o777, 0o600)

    await runArchiveTransaction(
      packagePath,
      {
        type: 'save-working-copy',
        tree: 'document',
        markdown: Buffer.from('# private\n'),
        expectedDocumentId: document.manifest.documentId,
        expectedGeneration: 0,
      },
      transactionOptions({
        async checkpoint(stage, context) {
          if (stage === 'after-temp-write') {
            assert.equal((await stat(context.tempPath)).mode & 0o777, 0o600)
          }
        },
      }),
    )

    assert.equal((await stat(packagePath)).mode & 0o777, 0o600)
  })
})

test('does not silently reclaim an existing lock directory', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'locked.mdv')
    const document = await createMdv(packagePath)
    const original = await readFile(packagePath)
    await mkdir(`${packagePath}.lock`)

    await assert.rejects(
      document.saveDocument({ markdown: '# blocked\n', expectedGeneration: 0 }),
      (error) => {
        assert.ok(assertMdvError(error, 'CONFLICT'))
        assert.equal(error.details.reason, 'locked')
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), original)
    assert.deepEqual((await readdir(directory)).sort(), ['locked.mdv', 'locked.mdv.lock'])
  })
})

test('reports an incomplete lock cleanup alongside the primary failure', async () => {
  await withTemporaryDirectory(async (directory) => {
    const packagePath = join(directory, 'cleanup-failure.mdv')
    const document = await createMdv(packagePath)
    const original = await readFile(packagePath)

    await assert.rejects(
      runArchiveTransaction(
        packagePath,
        {
          type: 'save-working-copy',
          tree: 'document',
          markdown: Buffer.from('# must not publish\n'),
          expectedDocumentId: document.manifest.documentId,
          expectedGeneration: 0,
        },
        transactionOptions({
          async checkpoint(stage, context) {
            if (stage === 'after-lock') {
              await mkdir(join(`${context.targetPath}.lock`, 'child'))
              throw new ArchiveError('IO_ERROR', 'injected primary failure')
            }
          },
        }),
      ),
      (error) => {
        assertArchiveError(error, 'IO_ERROR')
        assert.equal(error.details.committed, false)
        assert.equal(error.details.cleanupIncomplete, true)
        assert.deepEqual(
          error.details.cleanupFailures.map(({ resource, ioCode }) => ({ resource, ioCode })),
          [{ resource: 'lock', ioCode: 'ENOTEMPTY' }],
        )
        return true
      },
    )

    assert.deepEqual(await readFile(packagePath), original)
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ['cleanup-failure.mdv', 'cleanup-failure.mdv.lock'],
    )
  })
})

test('create rejects a non-regular-file target without replacing it', async () => {
  await withTemporaryDirectory(async (directory) => {
    const directoryPath = join(directory, 'not-a-file.mdv')
    await mkdir(directoryPath)

    await assert.rejects(
      createMdv(directoryPath),
      (error) => assertMdvError(error, 'CONFLICT'),
    )
    assert.deepEqual(await readdir(directoryPath), [])
  })
})

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-transaction-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function assertMdvError(error, code) {
  assert.ok(error instanceof MdvError)
  assert.equal(error.code, code)
  return true
}

function assertArchiveError(error, code) {
  assert.ok(error instanceof ArchiveError)
  assert.equal(error.code, code)
  return true
}

function failAt(expectedCheckpoint) {
  return {
    checkpoint(actualCheckpoint) {
      if (actualCheckpoint === expectedCheckpoint) {
        throw new ArchiveError('IO_ERROR', `injected failure at ${expectedCheckpoint}`)
      }
    },
  }
}

function transactionOptions(hooks) {
  return {
    hooks,
    validate(archive) {
      hydrateArchiveIndex({
        manifest: archive.manifest,
        referenceHead: archive.referenceHead,
        documentHead: archive.documentHead,
        referenceVersions: archive.referenceVersions,
        documentVersions: archive.documentVersions,
      })
    },
  }
}
