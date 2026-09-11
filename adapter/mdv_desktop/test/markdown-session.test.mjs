import assert from 'node:assert/strict'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MarkdownSession,
  toMarkdownFailure,
} from '../out/main/markdown-session.js'

const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024

async function fixture(t, contents = '# Draft\n') {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mdv-markdown-session-'))
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))
  const file = join(temporaryDirectory, 'notes.md')
  await writeFile(file, contents)
  return { file, temporaryDirectory }
}

async function rejection(promise) {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught, 'expected the promise to reject')
  return caught
}

async function assertNoTemporaryFiles(temporaryDirectory) {
  const names = await readdir(temporaryDirectory)
  assert.equal(names.some((name) => name.startsWith('.mdv-markdown-')), false)
}

test('opens UTF-8 Markdown and atomically saves the requested revision', async (t) => {
  const { file, temporaryDirectory } = await fixture(t, '# Original\n')
  await chmod(file, 0o640)
  const { session, view } = await MarkdownSession.open(file)

  assert.equal(view.kind, 'markdown')
  assert.equal(view.sessionId, session.id)
  assert.equal(view.displayName, 'notes.md')
  assert.equal(view.markdown, '# Original\n')
  assert.equal(JSON.stringify(view).includes(temporaryDirectory), false)

  const saved = await session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Saved\n',
    revision: 7,
  })

  assert.deepEqual(saved, { savedRevision: 7 })
  assert.equal(await readFile(file, 'utf8'), '# Saved\n')
  assert.equal(Number((await stat(file)).mode & 0o777), 0o640)
  await assertNoTemporaryFiles(temporaryDirectory)
})

test('rejects invalid UTF-8 and oversized files without disclosing their path', async (t) => {
  const { file, temporaryDirectory } = await fixture(t)
  await writeFile(file, Uint8Array.from([0x23, 0x20, 0xc3, 0x28]))

  const invalidUtf8 = await rejection(MarkdownSession.open(file))
  assert.equal(invalidUtf8.code, 'INVALID_ARGUMENT')
  assert.equal(invalidUtf8.details.reason, 'invalid-utf8')
  assert.equal(JSON.stringify(toMarkdownFailure(invalidUtf8)).includes(temporaryDirectory), false)

  await truncate(file, MAX_MARKDOWN_BYTES + 1)
  const oversized = await rejection(MarkdownSession.open(file))
  assert.equal(oversized.code, 'LIMIT_EXCEEDED')
  assert.equal(oversized.details.reason, 'markdown-too-large')
  assert.equal(JSON.stringify(toMarkdownFailure(oversized)).includes(temporaryDirectory), false)
})

test('rejects oversized save requests before touching the file', async (t) => {
  const { file } = await fixture(t, '# Stable\n')
  const { session } = await MarkdownSession.open(file)

  const error = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: 'x'.repeat(MAX_MARKDOWN_BYTES + 1),
    revision: 1,
  }))

  assert.equal(error.code, 'LIMIT_EXCEEDED')
  assert.equal(await readFile(file, 'utf8'), '# Stable\n')
})

test('detects external content changes and preserves the external version', async (t) => {
  const { file, temporaryDirectory } = await fixture(t, '# Original\n')
  const { session } = await MarkdownSession.open(file)
  await writeFile(file, '# External\n')

  const error = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Editor\n',
    revision: 2,
  }))

  assert.equal(error.code, 'CONFLICT')
  assert.equal(error.details.reason, 'content-changed')
  assert.equal(await readFile(file, 'utf8'), '# External\n')
  await assertNoTemporaryFiles(temporaryDirectory)
})

test('detects an identity replacement even when content is unchanged', async (t) => {
  const { file, temporaryDirectory } = await fixture(t, '# Same\n')
  const { session } = await MarkdownSession.open(file)
  const replacement = join(temporaryDirectory, 'replacement.md')
  await writeFile(replacement, '# Same\n')
  await rename(replacement, file)

  const error = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Editor\n',
    revision: 3,
  }))

  assert.equal(error.code, 'CONFLICT')
  assert.equal(error.details.reason, 'target-identity-changed')
  assert.equal(await readFile(file, 'utf8'), '# Same\n')
  await assertNoTemporaryFiles(temporaryDirectory)
})

test('rechecks the baseline immediately before publish and removes its temporary file', async (t) => {
  const { file, temporaryDirectory } = await fixture(t, '# Original\n')
  const { session } = await MarkdownSession.open(file, {
    checkpoint: async (stage) => {
      if (stage === 'before-publish') await writeFile(file, '# External during save\n')
    },
  })

  const error = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Editor\n',
    revision: 4,
  }))

  assert.equal(error.code, 'CONFLICT')
  assert.equal(error.details.reason, 'content-changed')
  assert.equal(await readFile(file, 'utf8'), '# External during save\n')
  await assertNoTemporaryFiles(temporaryDirectory)
})

test('reports committed true and invalidates the session after a post-rename failure', async (t) => {
  const { file, temporaryDirectory } = await fixture(t, '# Original\n')
  const { session } = await MarkdownSession.open(file, {
    checkpoint: (stage) => {
      if (stage === 'after-publish') throw new Error('simulated durability failure')
    },
  })

  const error = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Published\n',
    revision: 5,
  }))
  const publicFailure = toMarkdownFailure(error)

  assert.equal(error.code, 'SESSION_INVALID')
  assert.equal(error.details.committed, true)
  assert.equal(publicFailure?.committed, true)
  assert.equal(JSON.stringify(publicFailure).includes(temporaryDirectory), false)
  assert.equal(await readFile(file, 'utf8'), '# Published\n')
  await assertNoTemporaryFiles(temporaryDirectory)

  const retry = await rejection(session.saveMarkdown({
    sessionId: session.id,
    markdown: '# Must not replay\n',
    revision: 6,
  }))
  assert.equal(retry.code, 'SESSION_INVALID')
  assert.equal(await readFile(file, 'utf8'), '# Published\n')
})
