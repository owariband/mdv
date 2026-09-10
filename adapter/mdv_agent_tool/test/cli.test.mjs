import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createMdv, openMdv, verifyMdv } from '@owariband/mdv'

const cli = process.env.MDV_AGENT_CLI ?? fileURLToPath(new URL('../dist/cli.cjs', import.meta.url))
const workingDirectory = process.env.MDV_AGENT_TEST_CWD ?? process.cwd()
const human = { type: 'human', name: 'Fixture author' }
const agent = { type: 'agent', name: 'Test Agent' }
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex')

function invoke(args, input, closeOutput = false) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workingDirectory, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => { child.kill(); fail(new Error('CLI timed out')) }, 20_000)
    child.on('error', fail)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error) })
    if (closeOutput) child.stdout.destroy()
    child.stdin.end(input)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mdv agent 中文 '))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function fixture(t) {
  const root = await directory(t)
  const file = join(root, '需求 # draft.mdv')
  let document = await createMdv(file)
  document = await document.saveReference({ markdown: 'Reference v1\r\n', expectedGeneration: 0 })
  const r1 = await document.commitReference({ expectedGeneration: document.manifest.generation, actor: human, summary: 'Reference one' })
  document = await r1.document.saveReference({ markdown: 'Reference v2\n', expectedGeneration: r1.document.manifest.generation })
  const r2 = await document.commitReference({ expectedGeneration: document.manifest.generation, actor: human, summary: 'Reference two' })
  document = await r2.document.saveDocument({ markdown: 'Historical Doc\r\n', expectedGeneration: r2.document.manifest.generation })
  const d1 = await document.commitDocument({
    expectedGeneration: document.manifest.generation,
    actor: human,
    summary: 'Uses older Ref',
    referenceVersion: r1.version,
  })
  document = await d1.document.saveReference({
    markdown: 'Current Ref draft\nactual document:\nnot a protocol field',
    expectedGeneration: d1.document.manifest.generation,
  })
  document = await document.saveDocument({
    markdown: '# Current Doc\r\n中文 e\u0301  \r\nno EOF newline',
    expectedGeneration: document.manifest.generation,
  })
  return { root, file, document, r1: r1.version, r2: r2.version, d1: d1.version }
}

function result(value) {
  assert.equal(value.code, 0, value.stdout + value.stderr)
  assert.equal(value.stderr, '')
  const json = JSON.parse(value.stdout)
  assert.equal(json.protocolVersion, 2)
  assert.equal(json.ok, true)
  return json.data
}

function rejected(value, code, exitCode) {
  assert.equal(value.code, exitCode, value.stdout + value.stderr)
  assert.equal(value.stderr, '')
  const json = JSON.parse(value.stdout)
  assert.equal(json.protocolVersion, 2)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, code)
  return json.error
}

const json = (command, file, request, ...flags) => invoke(
  [command, '--file', file, '--input', '-', ...flags], JSON.stringify(request),
)
const read = (file, ...args) => invoke(['read', '--file', file, '--json', ...args])
const current = async (file) => result(await read(file))
const save = (file, tree, baseline, markdown, ...flags) => json(
  `save-${tree}`, file, { baseline, markdown }, ...flags,
)
const commit = (file, tree, baseline, summary, referenceVersion, ...flags) => json(
  `commit-${tree}`, file,
  { baseline, summary, actor: agent, ...(tree === 'document' ? { referenceVersion } : {}) },
  ...flags,
)
const checkout = (file, tree, baseline, version, discardChanges, ...flags) => json(
  `checkout-${tree}`, file, { baseline, version, discardChanges }, ...flags,
)

test('help and version describe the complete permission-aware command surface', async () => {
  const help = await invoke(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /commit-document/)
  assert.match(help.stdout, /save-reference/)
  assert.match(help.stdout, /user-approved-reference-write/)
  assert.match(help.stdout, /target tree content/)
  assert.equal((await invoke(['--version'])).stdout, '0.1.0-preview.2\n')
})

test('current read returns exact paired text and independent reusable baselines without mutation', async (t) => {
  const { file, document } = await fixture(t)
  const before = await readFile(file)
  const data = await current(file)
  assert.equal(data.documentId, document.manifest.documentId)
  assert.equal(data.generation, document.manifest.generation)
  assert.equal(data.reference.text, await document.readReferenceText())
  assert.equal(data.document.text, await document.readDocumentText())
  assert.deepEqual(data.permissions, { reference: 'approval-required', document: 'read-write' })
  for (const [tree, text] of [['reference', data.reference.text], ['document', data.document.text]]) {
    assert.equal(data[tree].baseline.documentId, data.documentId)
    assert.equal(data[tree].baseline.generation, data.generation)
    assert.equal(data[tree].baseline.tree, tree)
    assert.equal(data[tree].baseline.contentBytes, Buffer.byteLength(text))
    assert.equal(data[tree].baseline.contentSha256, createHash('sha256').update(text).digest('hex'))
  }
  assert.deepEqual(await readFile(file), before)
})

test('text reads retain fixed headings and expose copyable per-tree baselines', async (t) => {
  const { file, document } = await fixture(t)
  const value = await invoke(['read', '--file', file])
  assert.equal(value.code, 0)
  assert.match(value.stdout, /reference baseline: \{"documentId":"d_/)
  assert.match(value.stdout, /document baseline: \{"documentId":"d_/)
  assert.ok(value.stdout.includes('\n\nreference document:\n' + await document.readReferenceText()))
  assert.ok(value.stdout.endsWith('\n\nactual document:\n' + await document.readDocumentText() + '\n'))
})

test('historical reads pair a Document with its exact bound Reference and remain read-only', async (t) => {
  const { file, d1, r1 } = await fixture(t)
  const data = result(await read(file, '--document-version', d1))
  assert.equal(data.reference.text, 'Reference v1\r\n')
  assert.equal(data.document.text, 'Historical Doc\r\n')
  assert.deepEqual(data.reference.source, { tree: 'reference', kind: 'version', version: r1 })
  assert.deepEqual(data.document.source, { tree: 'document', kind: 'version', version: d1 })
  assert.deepEqual(data.permissions, { reference: 'read-only', document: 'read-only' })
  assert.equal(data.reference.baseline, undefined)
  assert.equal(data.document.baseline, undefined)
})

test('status, versions, trace, diff and verify expose the Core query surface', async (t) => {
  const { file, document, r1, d1 } = await fixture(t)
  const state = result(await invoke(['status', '--file', file]))
  assert.equal(state.documentId, document.manifest.documentId)
  assert.equal(state.status.reference.dirty, true)
  assert.equal(state.status.document.dirty, true)
  assert.equal(state.baselines.reference.tree, 'reference')
  assert.equal(state.baselines.document.tree, 'document')

  const documentVersions = result(await invoke(['versions', '--file', file, '--tree', 'document']))
  assert.deepEqual(documentVersions.versions.map(({ id }) => id), [d1])
  const documentTrace = result(await invoke(['trace', '--file', file, '--tree', 'document', '--version-id', d1]))
  assert.equal(documentTrace.trace.reference.id, r1)

  const review = result(await json('diff', file, {
    from: { tree: 'document', kind: 'version', version: d1 },
    to: { tree: 'document', kind: 'working-copy' },
    contextLines: 2,
  }))
  assert.match(review.result.unifiedText, /Current Doc/)
  const report = result(await invoke(['verify', '--file', file, '--mode', 'full']))
  assert.equal(report.report.valid, true)
})

test('Document save, explicit commit and clean checkout form one complete lifecycle', async (t) => {
  const { file, r2, d1 } = await fixture(t)
  const readData = await current(file)
  const saved = result(await save(file, 'document', readData.document.baseline, '# Agent draft\n'))
  assert.equal(saved.baseline.tree, 'document')
  assert.equal(saved.baseline.head, d1)

  const committed = result(await commit(file, 'document', saved.baseline, 'Agent version', r2))
  assert.equal(committed.created, true)
  assert.match(committed.version, /^v_[0-9a-f]{32}$/)
  let document = await openMdv(file)
  assert.equal(document.documentTree.head, committed.version)
  assert.deepEqual(document.listVersions({ tree: 'document' }).at(-1).actor, agent)
  assert.equal(document.getDocumentReference(committed.version), r2)

  const restored = result(await checkout(file, 'document', committed.baseline, d1, false))
  assert.equal(restored.restoredVersion, d1)
  document = await openMdv(file)
  assert.equal(document.documentTree.head, d1)
  assert.equal(await document.readDocumentText(), 'Historical Doc\r\n')
})

test('Document commits reject implicit binding and agents posing as humans', async (t) => {
  const { file } = await fixture(t)
  const data = await current(file)
  const before = await readFile(file)
  const missing = { baseline: data.document.baseline, summary: 'No bind', actor: agent }
  rejected(await json('commit-document', file, missing), 'INVALID_ARGUMENT', 2)
  rejected(await json('commit-document', file,
    { ...missing, actor: { type: 'human' }, referenceVersion: null }), 'INVALID_ARGUMENT', 2)
  assert.deepEqual(await readFile(file), before)
})

test('all Reference writes fail closed until the visible-approval flag is supplied', async (t) => {
  const { file, r1 } = await fixture(t)
  const data = await current(file)
  const before = await readFile(file)
  const saveRequest = { baseline: data.reference.baseline, markdown: '# Approved Ref\n' }
  const approval = rejected(await json('save-reference', file, saveRequest), 'USER_APPROVAL_REQUIRED', 4)
  assert.deepEqual(approval.requiredApproval, { scope: 'reference-write', action: 'save-reference', file })
  assert.deepEqual(await readFile(file), before)

  const saved = result(await json('save-reference', file, saveRequest, '--user-approved-reference-write'))
  const commitRequest = { baseline: saved.baseline, summary: 'Agent Ref', actor: agent }
  rejected(await json('commit-reference', file, commitRequest), 'USER_APPROVAL_REQUIRED', 4)
  const committed = result(await json('commit-reference', file, commitRequest, '--user-approved-reference-write'))
  assert.equal(committed.created, true)
  const checkoutRequest = { baseline: committed.baseline, version: r1, discardChanges: false }
  rejected(await json('checkout-reference', file, checkoutRequest), 'USER_APPROVAL_REQUIRED', 4)
  const restored = result(await checkout(file, 'reference', committed.baseline, r1, false,
    '--user-approved-reference-write'))
  assert.equal(restored.restoredVersion, r1)
})

test('discarding dirty working copies requires a second explicit approval', async (t) => {
  const { file, d1, r1 } = await fixture(t)
  const data = await current(file)
  const request = { baseline: data.document.baseline, version: d1, discardChanges: true }
  const before = await readFile(file)
  const approval = rejected(await json('checkout-document', file, request), 'USER_APPROVAL_REQUIRED', 4)
  assert.equal(approval.requiredApproval.scope, 'discard-working-copy')
  assert.deepEqual(await readFile(file), before)
  result(await json('checkout-document', file, request, '--user-approved-discard'))
  assert.equal(await (await openMdv(file)).readDocumentText(), 'Historical Doc\r\n')

  const referenceRequest = { baseline: data.reference.baseline, version: r1, discardChanges: true }
  const referenceApproval = rejected(await json('checkout-reference', file, referenceRequest,
    '--user-approved-reference-write'), 'USER_APPROVAL_REQUIRED', 4)
  assert.equal(referenceApproval.requiredApproval.scope, 'discard-working-copy')
  result(await json('checkout-reference', file, referenceRequest,
    '--user-approved-reference-write', '--user-approved-discard'))
  assert.equal(await (await openMdv(file)).readReferenceText(), 'Reference v1\r\n')
})

test('different-tree changes rebase stale generations without creating false conflicts', async (t) => {
  const first = await fixture(t)
  const firstRead = await current(first.file)
  await first.document.saveReference({ markdown: '# User changed only Ref\n', expectedGeneration: first.document.manifest.generation })
  result(await save(first.file, 'document', firstRead.document.baseline, '# Doc survives Ref write\n'))
  let reopened = await openMdv(first.file)
  assert.equal(await reopened.readReferenceText(), '# User changed only Ref\n')
  assert.equal(await reopened.readDocumentText(), '# Doc survives Ref write\n')

  const second = await fixture(t)
  const secondRead = await current(second.file)
  await second.document.saveDocument({ markdown: '# User changed only Doc\n', expectedGeneration: second.document.manifest.generation })
  result(await save(second.file, 'reference', secondRead.reference.baseline, '# Ref survives Doc write\n',
    '--user-approved-reference-write'))
  reopened = await openMdv(second.file)
  assert.equal(await reopened.readDocumentText(), '# User changed only Doc\n')
  assert.equal(await reopened.readReferenceText(), '# Ref survives Doc write\n')
})

test('same-tree changes reject stale baselines without overwriting the winner', async (t) => {
  const { file, document } = await fixture(t)
  const data = await current(file)
  await document.saveDocument({ markdown: '# Winner\n', expectedGeneration: document.manifest.generation })
  const before = await readFile(file)
  const error = rejected(await save(file, 'document', data.document.baseline, '# Loser\n'), 'CONFLICT', 3)
  assert.equal(error.origin, 'adapter')
  assert.equal(error.details.reason, 'working-copy-changed')
  assert.deepEqual(await readFile(file), before)
  assert.equal(await (await openMdv(file)).readDocumentText(), '# Winner\n')

  const referenceFixture = await fixture(t)
  const referenceData = await current(referenceFixture.file)
  await referenceFixture.document.saveReference({
    markdown: '# Reference winner\n',
    expectedGeneration: referenceFixture.document.manifest.generation,
  })
  const referenceBefore = await readFile(referenceFixture.file)
  const referenceError = rejected(await save(referenceFixture.file, 'reference',
    referenceData.reference.baseline, '# Reference loser\n', '--user-approved-reference-write'), 'CONFLICT', 3)
  assert.equal(referenceError.details.reason, 'working-copy-changed')
  assert.deepEqual(await readFile(referenceFixture.file), referenceBefore)
  assert.equal(await (await openMdv(referenceFixture.file)).readReferenceText(), '# Reference winner\n')
})

test('cross-process Ref and Doc saves serialize physically but both complete logically', async (t) => {
  const { file } = await fixture(t)
  const data = await current(file)
  const [documentWrite, referenceWrite] = await Promise.all([
    save(file, 'document', data.document.baseline, '# Concurrent Doc\n'),
    save(file, 'reference', data.reference.baseline, '# Concurrent Ref\n', '--user-approved-reference-write'),
  ])
  result(documentWrite)
  result(referenceWrite)
  const reopened = await openMdv(file)
  assert.equal(await reopened.readDocumentText(), '# Concurrent Doc\n')
  assert.equal(await reopened.readReferenceText(), '# Concurrent Ref\n')
})

test('cross-process commits on different trees do not create false conflicts', async (t) => {
  const { file, r2 } = await fixture(t)
  const data = await current(file)
  const [documentCommit, referenceCommit] = await Promise.all([
    commit(file, 'document', data.document.baseline, 'Concurrent Doc commit', r2),
    commit(file, 'reference', data.reference.baseline, 'Concurrent Ref commit', undefined,
      '--user-approved-reference-write'),
  ])
  assert.equal(result(documentCommit).created, true)
  assert.equal(result(referenceCommit).created, true)
  const reopened = await openMdv(file)
  assert.equal(reopened.listVersions({ tree: 'document' }).length, 2)
  assert.equal(reopened.listVersions({ tree: 'reference' }).length, 3)
})

test('two writers using one Document baseline still produce exactly one winner', async (t) => {
  const { file } = await fixture(t)
  const data = await current(file)
  const values = await Promise.all(['first', 'second'].map((text) =>
    save(file, 'document', data.document.baseline, text)))
  assert.deepEqual(values.map(({ code }) => code).sort(), [0, 3])
  rejected(values.find(({ code }) => code !== 0), 'CONFLICT', 3)
  const reopened = await openMdv(file)
  assert.ok(['first', 'second'].includes(await reopened.readDocumentText()))

  const referenceFixture = await fixture(t)
  const referenceData = await current(referenceFixture.file)
  const referenceValues = await Promise.all(['ref first', 'ref second'].map((text) =>
    save(referenceFixture.file, 'reference', referenceData.reference.baseline, text,
      '--user-approved-reference-write')))
  assert.deepEqual(referenceValues.map(({ code }) => code).sort(), [0, 3])
  rejected(referenceValues.find(({ code }) => code !== 0), 'CONFLICT', 3)
  const referenceReopened = await openMdv(referenceFixture.file)
  assert.ok(['ref first', 'ref second'].includes(await referenceReopened.readReferenceText()))
})

test('history operations reject a same-tree HEAD change even when content stayed identical', async (t) => {
  const { file, document, r2 } = await fixture(t)
  const data = await current(file)
  const external = await document.commitDocument({
    expectedGeneration: document.manifest.generation,
    actor: human,
    summary: 'External commit',
    referenceVersion: r2,
  })
  const before = await readFile(file)
  const error = rejected(await commit(file, 'document', data.document.baseline, 'Stale parent', r2), 'CONFLICT', 3)
  assert.equal(error.details.reason, 'head-changed')
  assert.deepEqual(await readFile(file), before)
  assert.equal((await openMdv(file)).documentTree.head, external.version)

  const referenceFixture = await fixture(t)
  const referenceData = await current(referenceFixture.file)
  const externalReference = await referenceFixture.document.commitReference({
    expectedGeneration: referenceFixture.document.manifest.generation,
    actor: human,
    summary: 'External reference commit',
  })
  const referenceBefore = await readFile(referenceFixture.file)
  const referenceError = rejected(await commit(referenceFixture.file, 'reference',
    referenceData.reference.baseline, 'Stale reference parent', undefined,
    '--user-approved-reference-write'), 'CONFLICT', 3)
  assert.equal(referenceError.details.reason, 'head-changed')
  assert.deepEqual(await readFile(referenceFixture.file), referenceBefore)
  assert.equal((await openMdv(referenceFixture.file)).referenceTree.head, externalReference.version)
})

test('another document at the same path cannot inherit any previous tree baseline', async (t) => {
  const root = await directory(t)
  const file = join(root, 'target.mdv')
  await createMdv(file)
  const data = await current(file)
  const replacement = join(root, 'replacement.mdv')
  await createMdv(replacement)
  await rename(replacement, file)
  const before = await readFile(file)
  rejected(await save(file, 'document', data.document.baseline, 'must not save'), 'CONFLICT', 3)
  assert.deepEqual(await readFile(file), before)
})

test('create and managed-resource commands work without changing archive generation', async (t) => {
  const root = await directory(t)
  const file = join(root, 'created.mdv')
  const created = result(await invoke(['create', '--file', file, '--markdown-profile', 'gfm']))
  assert.equal(created.generation, 0)
  const image = join(root, 'cat.png')
  await writeFile(image, PNG)
  const imported = result(await json('import-resource', file, {
    expectedDocumentId: created.documentId,
    sourceFile: image,
    mediaType: 'image/png',
  }))
  assert.equal(imported.generation, 0)
  assert.match(imported.relativePath, /^\.\/\.mdv-assets\/d_[0-9a-f]{32}\/[0-9a-f]{64}\.png$/)
  const resolved = result(await json('resolve-resource', file, {
    expectedDocumentId: created.documentId,
    relativePath: imported.relativePath,
  }))
  assert.equal(resolved.path, await realpath(join(root, imported.relativePath)))
  const verified = result(await json('verify-resource', file, {
    expectedDocumentId: created.documentId,
    relativePath: imported.relativePath,
  }))
  assert.equal(verified.verified, true)
  assert.equal((await openMdv(file)).manifest.generation, 0)
})

test('invalid baselines, command fields, flags and paths fail before writes', async (t) => {
  const { file } = await fixture(t)
  const data = await current(file)
  const before = await readFile(file)
  for (const request of [
    {},
    { baseline: data.reference.baseline, markdown: 'wrong tree' },
    { baseline: { ...data.document.baseline, contentSha256: 'bad' }, markdown: 'bad hash' },
    { baseline: data.document.baseline, markdown: null },
    { baseline: data.document.baseline, markdown: 'x', permissions: {} },
  ]) rejected(await json('save-document', file, request), 'INVALID_ARGUMENT', 2)
  rejected(await invoke(['read', '--file', file, '--user-approved-reference-write']), 'INVALID_ARGUMENT', 2)
  rejected(await invoke(['trace', '--file', file, '--tree', 'document']), 'INVALID_ARGUMENT', 2)
  rejected(await json('resolve-resource', file, {
    expectedDocumentId: data.documentId,
    relativePath: './.mdv-assets/not-a-managed-path.png',
    maxBytes: 1,
  }), 'INVALID_ARGUMENT', 2)
  rejected(await invoke(['read', '--file', 'mdv:/virtual.mdv']), 'INVALID_ARGUMENT', 2)
  rejected(await invoke(['read', '--file', 'https://example.com/file.mdv']), 'INVALID_ARGUMENT', 2)
  assert.deepEqual(await readFile(file), before)
})

test('JSON files, relative paths, malformed input and UTF-8 errors retain clear boundaries', async (t) => {
  const { file, root } = await fixture(t)
  const data = await current(file)
  const input = join(root, 'request 中文.json')
  await writeFile(input, JSON.stringify({ baseline: data.document.baseline, markdown: '' }))
  result(await invoke(['save-document', '--file', relative(workingDirectory, file), '--input', input]))
  assert.equal(await (await openMdv(file)).readDocumentText(), '')
  for (const body of ['', '{', '\ufeff' + JSON.stringify({ baseline: data.document.baseline, markdown: 'bad' })]) {
    rejected(await invoke(['save-document', '--file', file, '--input', '-'], body), 'INVALID_ARGUMENT', 2)
  }
  rejected(await invoke(['save-document', '--file', file, '--input', '-'], Buffer.from([0xff])), 'INVALID_UTF8', 2)
  rejected(await invoke(['save-document', '--file', file, '--input', join(root, 'missing.json')]), 'IO_ERROR', 3)
})

test('input and escaped-output budgets fail closed without partial successful data', async (t) => {
  const { file } = await fixture(t)
  const before = await readFile(file)
  rejected(await invoke(['save-document', '--file', file, '--input', '-'], Buffer.alloc(16 * 1024 * 1024 + 1, 32)),
    'LIMIT_EXCEEDED', 2)
  assert.deepEqual(await readFile(file), before)

  const large = join(await directory(t), 'large.mdv')
  let document = await createMdv(large)
  document = await document.saveReference({ markdown: '"'.repeat(16 * 1024 * 1024), expectedGeneration: 0 })
  const output = await read(large)
  rejected(output, 'LIMIT_EXCEEDED', 2)
  assert.ok(output.stdout.length < 1000)
})

test('missing and malformed archives retain diagnostic behavior', async (t) => {
  const root = await directory(t)
  rejected(await read(join(root, 'missing.mdv')), 'NOT_FOUND', 3)
  const file = join(root, 'bad.mdv')
  await writeFile(file, 'not a ZIP')
  rejected(await read(file), 'INVALID_ARCHIVE', 3)
  const report = result(await invoke(['verify', '--file', file]))
  assert.equal(report.report.valid, false)
  assert.equal(await readFile(file, 'utf8'), 'not a ZIP')
})

test('closed stdout reports delivery uncertainty without implying rollback', async (t) => {
  const { file } = await fixture(t)
  const data = await current(file)
  const value = await invoke(
    ['save-document', '--file', file, '--input', '-'],
    JSON.stringify({ baseline: data.document.baseline, markdown: 'saved before pipe failure' }),
    true,
  )
  assert.equal(value.code, 1, value.stderr)
  assert.match(value.stderr, /MDV OUTPUT_ERROR/)
  assert.equal(await (await openMdv(file)).readDocumentText(), 'saved before pipe failure')
  assert.equal((await verifyMdv(file, { mode: 'full' })).valid, true)
})
