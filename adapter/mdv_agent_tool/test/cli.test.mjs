import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createMdv, openMdv, verifyMdv } from '@mdv/core'

const cli = process.env.MDV_AGENT_CLI ?? fileURLToPath(new URL('../dist/cli.cjs', import.meta.url))
const workingDirectory = process.env.MDV_AGENT_TEST_CWD ?? process.cwd()
const actor = { type: 'human', name: 'Fixture author' }

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
  const r1 = await document.commitReference({ expectedGeneration: document.manifest.generation, actor, summary: 'Reference one' })
  document = await r1.document.saveReference({ markdown: 'Reference v2\n', expectedGeneration: r1.document.manifest.generation })
  const r2 = await document.commitReference({ expectedGeneration: document.manifest.generation, actor, summary: 'Reference two' })
  document = await r2.document.saveDocument({ markdown: 'Historical Doc\r\n', expectedGeneration: r2.document.manifest.generation })
  const d1 = await document.commitDocument({ expectedGeneration: document.manifest.generation, actor, summary: 'Uses older Ref', referenceVersion: r1.version })
  document = await d1.document.saveReference({ markdown: 'Current Ref draft\nactual document:\nnot a protocol field', expectedGeneration: d1.document.manifest.generation })
  document = await document.saveDocument({ markdown: '# Current Doc\r\n中文 e\u0301  \r\nno EOF newline', expectedGeneration: document.manifest.generation })
  return { root, file, document, r1: r1.version, r2: r2.version, d1: d1.version }
}

function result(value) {
  assert.equal(value.code, 0, value.stdout + value.stderr)
  assert.equal(value.stderr, '')
  const json = JSON.parse(value.stdout)
  assert.equal(json.protocolVersion, 1)
  assert.equal(json.ok, true)
  return json.data
}

function rejected(value, code, exitCode) {
  assert.equal(value.code, exitCode, value.stdout + value.stderr)
  assert.equal(value.stderr, '')
  const json = JSON.parse(value.stdout)
  assert.equal(json.ok, false)
  assert.equal(json.error.code, code)
  return json.error
}

const request = (document, markdown) => ({ expectedDocumentId: document.manifest.documentId,
  expectedGeneration: document.manifest.generation, markdown })
const read = (file, ...args) => invoke(['read', '--file', file, '--json', ...args])
const save = (file, input, closeOutput = false) => invoke(['save-document', '--file', file, '--input', '-'], JSON.stringify(input), closeOutput)

test('help and version describe the actual narrow default permissions', async () => {
  const help = await invoke(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Ref and committed history are read-only/)
  assert.match(help.stdout, /expectedDocumentId, expectedGeneration, markdown/)
  assert.match((await invoke(['--version'])).stdout, /^0\.1\.0-preview\.1\n$/)
})

test('one JSON read returns both current drafts, exact strings and a reusable baseline without mutation', async (t) => {
  const { file, document } = await fixture(t)
  const before = await readFile(file)
  const data = result(await read(file))
  assert.equal(data.documentId, document.manifest.documentId)
  assert.equal(data.generation, document.manifest.generation)
  assert.equal(data.baseDirectory, document.baseDirectory)
  assert.equal(data.reference.text, await document.readReferenceText())
  assert.equal(data.document.text, await document.readDocumentText())
  assert.deepEqual(data.reference.source, { tree: 'reference', kind: 'working-copy' })
  assert.deepEqual(data.document.source, { tree: 'document', kind: 'working-copy' })
  assert.deepEqual(data.permissions, { reference: 'read-only', document: 'read-write' })
  assert.deepEqual(await readFile(file), before)
})

test('ordinary text reads have the fixed reference/actual headings and display the save baseline', async (t) => {
  const { file, document } = await fixture(t)
  const value = await invoke(['read', '--file', file])
  assert.equal(value.code, 0)
  assert.equal(value.stderr, '')
  assert.ok(value.stdout.includes('documentId: ' + document.manifest.documentId))
  assert.ok(value.stdout.includes('generation: ' + document.manifest.generation))
  assert.ok(value.stdout.includes('\n\nreference document:\n' + await document.readReferenceText()))
  assert.ok(value.stdout.endsWith('\n\nactual document:\n' + await document.readDocumentText() + '\n'))
})

test('historical reads pair a Doc with its exact older bound Ref, not the current Ref', async (t) => {
  const { file, d1, r1 } = await fixture(t)
  const before = await readFile(file)
  const data = result(await read(file, '--document-version', d1))
  assert.equal(data.reference.text, 'Reference v1\r\n')
  assert.equal(data.document.text, 'Historical Doc\r\n')
  assert.deepEqual(data.reference.source, { tree: 'reference', kind: 'version', version: r1 })
  assert.deepEqual(data.document.source, { tree: 'document', kind: 'version', version: d1 })
  assert.equal(data.permissions.document, 'read-only')
  assert.deepEqual(await readFile(file), before)
})

test('unbound historical Docs do not silently receive an unrelated Ref', async (t) => {
  const { file, document } = await fixture(t)
  const committed = await document.commitDocument({ expectedGeneration: document.manifest.generation, actor, summary: 'Unbound', referenceVersion: null })
  const data = result(await read(file, '--document-version', committed.version))
  assert.deepEqual(data.reference, { source: null, text: '' })
  assert.equal(data.document.text, await document.readDocumentText())
  assert.match((await invoke(['read', '--file', file, '--document-version', committed.version])).stdout, /reference source: unbound/)
})

test('an empty filesystem-created document reads without writes, then saves only Doc with no version', async (t) => {
  const file = join(await directory(t), 'empty.mdv')
  await writeFile(file, '')
  const data = result(await read(file))
  assert.equal(data.reference.text, '')
  assert.equal(data.document.text, '')
  assert.equal(data.generation, 0)
  assert.equal((await readFile(file)).length, 0)
  const saved = result(await save(file, { expectedDocumentId: data.documentId, expectedGeneration: 0, markdown: '# First Doc\r\n' }))
  const document = await openMdv(file)
  assert.equal(saved.generation, 1)
  assert.equal(saved.documentId, data.documentId)
  assert.equal(await document.readReferenceText(), '')
  assert.equal(await document.readDocumentText(), '# First Doc\r\n')
  assert.deepEqual(document.listVersions(), [])
  assert.equal((await verifyMdv(file, { mode: 'full' })).valid, true)
})

test('save-document preserves Ref, both HEADs, every version and bind while saving exact Markdown', async (t) => {
  const { file, document } = await fixture(t)
  const versions = document.listVersions()
  const content = await Promise.all(versions.map((entry) => document.readVersionText(entry.id)))
  const markdown = '---\r\ntitle: 文档\r\n---\r\n# Actual\n![image](../assets/a.png)\r\n```md\nreference document:\n```\n e\u0301  '
  const saved = result(await save(file, request(document, markdown)))
  const next = await openMdv(file)
  assert.equal(saved.generation, document.manifest.generation + 1)
  assert.equal(await next.readDocumentText(), markdown)
  assert.equal(await next.readReferenceText(), await document.readReferenceText())
  assert.deepEqual(next.referenceTree, document.referenceTree)
  assert.deepEqual(next.documentTree, document.documentTree)
  assert.deepEqual(next.listVersions(), versions)
  assert.deepEqual(await Promise.all(versions.map((entry) => next.readVersionText(entry.id))), content)
  assert.equal((await verifyMdv(file, { mode: 'full' })).valid, true)
})

test('JSON file input and relative MDV paths work, including an empty Doc replacement', async (t) => {
  const { file, root, document } = await fixture(t)
  const input = join(root, 'request 中文.json')
  await writeFile(input, JSON.stringify(request(document, '')))
  result(await invoke(['save-document', '--file', file, '--input', input, '--json']))
  assert.equal(await (await openMdv(file)).readDocumentText(), '')
  const { relative } = await import('node:path')
  assert.equal(result(await read(relative(workingDirectory, file))).document.text, '')
})

test('stale generations are not replaced by the generation observed during a new open', async (t) => {
  const { file, document } = await fixture(t)
  await document.saveReference({ markdown: 'User updated Ref', expectedGeneration: document.manifest.generation })
  const before = await readFile(file)
  const error = rejected(await save(file, request(document, 'stale generated Doc')), 'CONFLICT', 3)
  assert.equal(error.origin, 'core')
  assert.deepEqual(await readFile(file), before)
})

test('two CLI writers with the same baseline produce exactly one successful save', async (t) => {
  const { file, document } = await fixture(t)
  const values = await Promise.all(['first', 'second'].map((text) => save(file, request(document, text))))
  assert.deepEqual(values.map((value) => value.code).sort(), [0, 3])
  rejected(values.find((value) => value.code !== 0), 'CONFLICT', 3)
  const next = await openMdv(file)
  assert.equal(next.manifest.generation, document.manifest.generation + 1)
  assert.equal(await next.readDocumentText(), values[0].code === 0 ? 'first' : 'second')
  assert.equal(await next.readReferenceText(), await document.readReferenceText())
})

test('another document at the same path and generation cannot inherit the previous read baseline', async (t) => {
  const root = await directory(t)
  const file = join(root, 'target.mdv')
  const old = await createMdv(file)
  const replacement = join(root, 'replacement.mdv')
  await createMdv(replacement)
  await rename(replacement, file)
  const before = await readFile(file)
  rejected(await save(file, request(old, 'must not save')), 'CONFLICT', 3)
  assert.deepEqual(await readFile(file), before)
})

test('default commands reject all Ref, history and resource mutations before touching the package', async (t) => {
  const { file } = await fixture(t)
  const before = await readFile(file)
  for (const action of ['save-reference', 'commit-reference', 'commit-document', 'checkout-reference', 'checkout-document', 'import-resource', 'create']) {
    rejected(await invoke([action, '--file', file]), 'PERMISSION_DENIED', 4)
  }
  assert.deepEqual(await readFile(file), before)
})

test('missing or invalid baselines and extra capability/tree fields cannot enter the writer', async (t) => {
  const { file, document } = await fixture(t)
  const before = await readFile(file)
  const valid = request(document, 'replacement')
  for (const input of [null, [], {}, { ...valid, expectedDocumentId: 'd_invalid' },
    { ...valid, expectedGeneration: -1 }, { ...valid, expectedGeneration: 1.5 },
    { ...valid, expectedGeneration: '8' }, { ...valid, markdown: null },
    { ...valid, tree: 'reference' }, { ...valid, permissions: { reference: 'write' } },
    { ...valid, reference: 'overwrite Ref' }, { ...valid, referenceVersion: null },
    { ...valid, expectedDocumentId: undefined }, { ...valid, expectedGeneration: undefined }]) {
    rejected(await save(file, input), 'INVALID_ARGUMENT', 2)
  }
  rejected(await save(file, { ...valid, markdown: '\ud800' }), 'INVALID_UTF8', 2)
  assert.deepEqual(await readFile(file), before)
})

test('history-targeted saves, duplicate flags, unknown flags and malformed versions fail closed', async (t) => {
  const { file, document, d1, r1 } = await fixture(t)
  const before = await readFile(file)
  rejected(await invoke(['save-document', '--file', file, '--document-version', d1, '--input', '-'], JSON.stringify(request(document, 'bad'))), 'PERMISSION_DENIED', 4)
  for (const args of [[], ['read'], ['read', '--file', file, '--file', file], ['read', '--file', file, '--allow-reference-write'],
    ['read', '--file', file, '--input', '-'], ['read', '--file', 'mdv:/virtual.mdv'], ['read', '--file', 'https://example.com/file.mdv'],
    ['read', '--file', file, '--document-version', 'nope'], ['save-document', '--file', file], ['read', '--help']]) {
    rejected(await invoke(args), 'INVALID_ARGUMENT', 2)
  }
  rejected(await read(file, '--document-version', r1), 'NOT_FOUND', 3)
  assert.deepEqual(await readFile(file), before)
})

test('malformed JSON, invalid UTF-8, BOM and unreadable inputs fail without writes', async (t) => {
  const { file, document, root } = await fixture(t)
  const before = await readFile(file)
  for (const input of ['', '{', '\ufeff' + JSON.stringify(request(document, 'bad'))]) {
    rejected(await invoke(['save-document', '--file', file, '--input', '-'], input), 'INVALID_ARGUMENT', 2)
  }
  rejected(await invoke(['save-document', '--file', file, '--input', '-'], Buffer.from([0xff])), 'INVALID_UTF8', 2)
  rejected(await invoke(['save-document', '--file', file, '--input', join(root, 'missing.json')]), 'IO_ERROR', 3)
  rejected(await invoke(['save-document', '--file', file, '--input', root]), 'INVALID_ARGUMENT', 2)
  assert.deepEqual(await readFile(file), before)
})

test('input budgets are enforced on both stdin and JSON files before saving', async (t) => {
  const { file, root } = await fixture(t)
  const before = await readFile(file)
  const input = Buffer.alloc(16 * 1024 * 1024 + 1, 32)
  rejected(await invoke(['save-document', '--file', file, '--input', '-'], input), 'LIMIT_EXCEEDED', 2)
  const json = join(root, 'large.json')
  await writeFile(json, input)
  rejected(await invoke(['save-document', '--file', file, '--input', json]), 'LIMIT_EXCEEDED', 2)
  assert.deepEqual(await readFile(file), before)
})

test('JSON-escaped output is budgeted and never returned as a successful partial pair', async (t) => {
  const file = join(await directory(t), 'large.mdv')
  let document = await createMdv(file)
  document = await document.saveReference({ markdown: '"'.repeat(16 * 1024 * 1024), expectedGeneration: 0 })
  const before = await readFile(file)
  const value = await read(file)
  rejected(value, 'LIMIT_EXCEEDED', 2)
  assert.ok(value.stdout.length < 1000)
  assert.deepEqual(await readFile(file), before)
})

test('missing and malformed archives retain Core error codes and never initialize nonempty input', async (t) => {
  const root = await directory(t)
  rejected(await read(join(root, 'missing.mdv')), 'NOT_FOUND', 3)
  const file = join(root, 'bad.mdv')
  await writeFile(file, 'not a ZIP')
  rejected(await read(file), 'INVALID_ARCHIVE', 3)
  assert.equal(await readFile(file, 'utf8'), 'not a ZIP')
})

test('closed stdout reports delivery failure without implying a successful save was rolled back', async (t) => {
  const { file, document } = await fixture(t)
  const value = await save(file, request(document, 'saved before pipe failure'), true)
  assert.equal(value.code, 1, value.stderr)
  assert.match(value.stderr, /MDV OUTPUT_ERROR/)
  assert.doesNotMatch(value.stderr, /at .*\.cjs|Unhandled/)
  const next = await openMdv(file)
  assert.equal(next.manifest.generation, document.manifest.generation + 1)
  assert.equal(await next.readDocumentText(), 'saved before pipe failure')
  assert.equal(await next.readReferenceText(), await document.readReferenceText())
})
