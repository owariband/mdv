import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import {
  mkdtemp,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { openMdv } from '../dist/index.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY_URL = pathToFileURL(join(PROJECT_ROOT, 'dist/index.js')).href

const WORKER_SOURCE = String.raw`
const [moduleUrl, serializedCommand] = process.argv.slice(2)
const command = JSON.parse(serializedCommand)
const { createMdv, openMdv } = await import(moduleUrl)
const opened = command.action === 'save-document'
  ? await openMdv(command.path)
  : null

process.send({ type: 'ready' })
process.once('message', async (message) => {
  if (message?.type !== 'start') {
    process.exitCode = 1
    process.disconnect()
    return
  }

  try {
    const document = command.action === 'create'
      ? await createMdv(command.path)
      : await opened.saveDocument({
          markdown: command.markdown,
          expectedGeneration: command.expectedGeneration,
        })
    finish({
      type: 'result',
      ok: true,
      generation: document.manifest.generation,
    })
  } catch (error) {
    finish({
      type: 'result',
      ok: false,
      error: {
        name: error?.name,
        code: error?.code,
        message: error?.message,
        details: error?.details,
        stack: error?.stack,
      },
    })
  }
})

function finish(message) {
  process.send(message, (error) => {
    if (error) {
      console.error(error)
      process.exitCode = 1
    }
    process.disconnect()
  })
}
`

test('two processes creating the same target publish exactly one archive', {
  timeout: 20_000,
}, async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'create-race.mdv')
  const workerPath = await writeWorker(directory)
  const command = { action: 'create', path: packagePath }

  const results = await runContenders(workerPath, [command, command])
  assertOneWinnerAndOneConflict(results, 0)

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 0)
  assert.equal(await reopened.readReferenceText(), '')
  assert.equal(await reopened.readDocumentText(), '')

  await unlink(workerPath)
  assert.deepEqual(await readdir(directory), ['create-race.mdv'])
})

test('two processes saving one generation commit exactly one working copy', {
  timeout: 20_000,
}, async (t) => {
  const directory = await temporaryDirectory(t)
  const packagePath = join(directory, 'save-race.mdv')
  const workerPath = await writeWorker(directory)

  await runSingleCreate(workerPath, packagePath)
  const markdownCandidates = ['# process one\n', '# process two\n']
  const results = await runContenders(workerPath, markdownCandidates.map((markdown) => ({
    action: 'save-document',
    path: packagePath,
    expectedGeneration: 0,
    markdown,
  })))
  assertOneWinnerAndOneConflict(results, 1)

  const reopened = await openMdv(packagePath)
  assert.equal(reopened.manifest.generation, 1)
  assert.ok(markdownCandidates.includes(await reopened.readDocumentText()))
  assert.equal(await reopened.readReferenceText(), '')
  assert.equal(reopened.listVersions().length, 0)

  await unlink(workerPath)
  assert.deepEqual(await readdir(directory), ['save-race.mdv'])
})

async function runSingleCreate(workerPath, packagePath) {
  const [result] = await runContenders(workerPath, [{
    action: 'create',
    path: packagePath,
  }])
  assert.deepEqual(result, { type: 'result', ok: true, generation: 0 })
}

async function runContenders(workerPath, commands) {
  const contenders = commands.map((command) => spawnContender(workerPath, command))
  try {
    await Promise.all(contenders.map(({ ready }) => ready))
    await Promise.all(contenders.map(({ start }) => start()))
    const results = await Promise.all(contenders.map(({ result }) => result))
    const exits = await Promise.all(contenders.map(({ closed }) => closed))
    for (const exit of exits) {
      assert.equal(exit.code, 0, exit.diagnostics)
      assert.equal(exit.signal, null, exit.diagnostics)
    }
    return results
  } finally {
    for (const { child } of contenders) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    }
    await Promise.all(contenders.map(({ closed }) => closed))
  }
}

function spawnContender(workerPath, command) {
  const child = fork(workerPath, [DIST_ENTRY_URL, JSON.stringify(command)], {
    cwd: PROJECT_ROOT,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  let resolveResult
  let rejectResult
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise
    rejectResult = rejectPromise
  })
  void ready.catch(() => undefined)
  void result.catch(() => undefined)

  let isReady = false
  let hasResult = false
  child.on('message', (message) => {
    if (message?.type === 'ready' && !isReady) {
      isReady = true
      resolveReady()
      return
    }
    if (message?.type === 'result' && !hasResult) {
      hasResult = true
      resolveResult(message)
    }
  })

  const closed = new Promise((resolvePromise) => {
    child.once('close', (code, signal) => {
      const diagnostics = childDiagnostics(code, signal, output)
      if (!isReady) {
        rejectReady(new Error(diagnostics))
      }
      if (!hasResult) {
        rejectResult(new Error(diagnostics))
      }
      resolvePromise({ code, signal, diagnostics })
    })
  })

  child.once('error', (error) => {
    if (!isReady) {
      rejectReady(error)
    }
    if (!hasResult) {
      rejectResult(error)
    }
  })

  return {
    child,
    ready,
    result,
    closed,
    start() {
      return new Promise((resolvePromise, rejectPromise) => {
        child.send({ type: 'start' }, (error) => {
          if (error) {
            rejectPromise(error)
            return
          }
          resolvePromise()
        })
      })
    },
  }
}

function assertOneWinnerAndOneConflict(results, generation) {
  const fulfilled = results.filter(({ ok }) => ok)
  const rejected = results.filter(({ ok }) => !ok)

  assert.equal(fulfilled.length, 1)
  assert.equal(fulfilled[0].generation, generation)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].error.code, 'CONFLICT', rejected[0].error.stack)
}

function childDiagnostics(code, signal, output) {
  const suffix = output.length === 0 ? '' : `\n${output}`
  return `worker closed with code ${code} and signal ${signal}${suffix}`
}

async function writeWorker(directory) {
  const workerPath = join(directory, 'mdv-cross-process-worker.mjs')
  await writeFile(workerPath, WORKER_SOURCE)
  return workerPath
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-cross-process-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
