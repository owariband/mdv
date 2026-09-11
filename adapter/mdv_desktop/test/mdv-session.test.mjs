import assert from 'node:assert/strict'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMdv, openMdv } from '@owariband/mdv'
import {
  MdvSession,
  issueReferenceWritePermit,
} from '../out/main/mdv-session.js'

async function fixture(t, content = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-desktop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'document.mdv')
  let document = await createMdv(file)
  if (content.reference !== undefined) {
    document = await document.saveReference({
      markdown: content.reference,
      expectedGeneration: document.manifest.generation,
    })
  }
  if (content.document !== undefined) {
    document = await document.saveDocument({
      markdown: content.document,
      expectedGeneration: document.manifest.generation,
    })
  }
  return { directory, file, document }
}

test('opens Reference and Document from one snapshot', async (t) => {
  const { file, document } = await fixture(t, {
    reference: '# Reference\n',
    document: '# Document\n',
  })
  const opened = await MdvSession.open(file)

  assert.equal(opened.view.documentId, document.manifest.documentId)
  assert.equal(opened.view.generation, document.manifest.generation)
  assert.equal(opened.view.reference.markdown, '# Reference\n')
  assert.equal(opened.view.document.markdown, '# Document\n')
  assert.equal(opened.view.reference.workingCopyDirty, true)
  assert.equal(opened.view.document.workingCopyDirty, true)
  assert.deepEqual(opened.view.versions, { reference: [], document: [] })
  assert.deepEqual(opened.view.referenceRelation, { kind: 'no-document-head' })
})

test('saves Document without changing Reference or creating versions', async (t) => {
  const { file } = await fixture(t, { reference: 'requirements\n', document: 'draft\n' })
  const { session, view } = await MdvSession.open(file)
  const result = await session.saveDocument({
    sessionId: view.sessionId,
    markdown: 'finished\n',
    revision: 4,
  })
  const current = await openMdv(file)

  assert.equal(await current.readReferenceText(), 'requirements\n')
  assert.equal(await current.readDocumentText(), 'finished\n')
  assert.deepEqual(current.listVersions(), [])
  assert.equal(result.tree, 'document')
  assert.equal(result.savedRevision, 4)
  assert.equal(result.workingCopyDirty, true)
})

test('requires and consumes a one-shot Reference permit', async (t) => {
  const { file } = await fixture(t, { reference: 'old\n' })
  const { session, view } = await MdvSession.open(file)
  const request = { sessionId: view.sessionId, markdown: 'new\n', revision: 1 }

  assert.throws(
    () => session.saveReference(request, undefined),
    (error) => error?.code === 'PERMISSION_DENIED',
  )

  const permit = issueReferenceWritePermit()
  await session.saveReference(request, permit)
  assert.throws(
    () => session.saveReference({ ...request, revision: 2 }, permit),
    (error) => error?.code === 'PERMISSION_DENIED',
  )
  assert.equal(await (await openMdv(file)).readReferenceText(), 'new\n')
})

test('rebases a stale Document save when only Reference changed externally', async (t) => {
  const { file } = await fixture(t, { reference: 'R1\n', document: 'D1\n' })
  const { session, view } = await MdvSession.open(file)
  const external = await openMdv(file)
  await external.saveReference({ markdown: 'R2\n', expectedGeneration: external.manifest.generation })

  const result = await session.saveDocument({
    sessionId: view.sessionId,
    markdown: 'D2\n',
    revision: 1,
  })
  const current = await openMdv(file)

  assert.equal(await current.readReferenceText(), 'R2\n')
  assert.equal(await current.readDocumentText(), 'D2\n')
  assert.deepEqual(result.staleTrees, ['reference'])
})

test('blocks a stale save when the same tree changed externally', async (t) => {
  const { file } = await fixture(t, { document: 'D1\n' })
  const { session, view } = await MdvSession.open(file)
  const external = await openMdv(file)
  await external.saveDocument({ markdown: 'external\n', expectedGeneration: external.manifest.generation })

  await assert.rejects(
    session.saveDocument({ sessionId: view.sessionId, markdown: 'local\n', revision: 1 }),
    (error) => error?.code === 'CONFLICT' && error?.details?.reason === 'working-copy-changed',
  )
  assert.equal(await (await openMdv(file)).readDocumentText(), 'external\n')
})

test('allows only one writer from the same baseline', async (t) => {
  const { file } = await fixture(t, { document: 'base\n' })
  const first = await MdvSession.open(file)
  const second = await MdvSession.open(file)
  const outcomes = await Promise.allSettled([
    first.session.saveDocument({ sessionId: first.view.sessionId, markdown: 'first\n', revision: 1 }),
    second.session.saveDocument({ sessionId: second.view.sessionId, markdown: 'second\n', revision: 1 }),
  ])

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
  const finalText = await (await openMdv(file)).readDocumentText()
  assert.ok(finalText === 'first\n' || finalText === 'second\n')
})

test('invalidates a session when the path is replaced by another MDV', async (t) => {
  const { directory, file } = await fixture(t, { document: 'original\n' })
  const { session, view } = await MdvSession.open(file)
  const replacement = join(directory, 'replacement.mdv')
  const other = await createMdv(replacement)
  const otherId = other.manifest.documentId
  await rename(replacement, file)

  await assert.rejects(
    session.saveDocument({ sessionId: view.sessionId, markdown: 'must not write\n', revision: 1 }),
    (error) => error?.code === 'CONFLICT' && error?.details?.reason === 'document-changed',
  )
  const current = await openMdv(file)
  assert.equal(current.manifest.documentId, otherId)
  assert.equal(await current.readDocumentText(), '')
})

test('opens and performs the first save on a zero-byte MDV file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-desktop-empty-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'empty.mdv')
  await writeFile(file, new Uint8Array())
  const { session, view } = await MdvSession.open(file)

  assert.equal(view.reference.markdown, '')
  assert.equal(view.document.markdown, '')
  await session.saveDocument({ sessionId: view.sessionId, markdown: '# First draft\n', revision: 1 })
  assert.equal(await (await openMdv(file)).readDocumentText(), '# First draft\n')
})
