#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { parseArgs, TextDecoder } from 'node:util'
import { readPair, saveDocument } from './commands.js'
import { failure, jsonOutput, MAX_INPUT_BYTES, parseSaveRequest, parseVersion, textOutput, ToolError } from './protocol.js'

declare const MDV_AGENT_TOOL_VERSION: string

const HELP = 'MDV Agent Tool ' + MDV_AGENT_TOOL_VERSION + '\n\n'
  + 'mdv read --file <path.mdv> [--json] [--document-version <version-id>]\n'
  + 'mdv save-document --file <path.mdv> --input <request.json|->\n\n'
  + 'Read returns reference document + actual document from one saved snapshot.\n'
  + 'Historical reads return the exact bound Ref (or unbound), never today\'s Ref.\n'
  + 'Only the current Document is writable. Ref and committed history are read-only.\n'
  + 'Save input: {expectedDocumentId, expectedGeneration, markdown}. Use the baseline from read.\n'
  + 'Save never commits, changes Ref, or retries conflicts. --json reads preserve exact strings.\n'
  + 'Read defaults to text; save and errors return JSON. Limits: input 16 MiB, output 32 MiB.\n'
  + 'Exit codes: 0 success, 2 invalid input/budget, 3 Core or input I/O error, 4 permission, 1 internal/output error.\n'
  + 'This tool does not grant filesystem access or sandbox other Agent commands.\n'

async function readInput(path: string): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (path !== '-') {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      if (!(await handle.stat()).isFile()) throw new ToolError('INVALID_ARGUMENT', 'Input must be a regular JSON file or stdin')
    } else if (process.stdin.isTTY) {
      throw new ToolError('INVALID_ARGUMENT', 'Pipe one JSON request to stdin or pass a JSON file')
    }
    const stream = handle ? handle.createReadStream({ autoClose: false }) : process.stdin
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_INPUT_BYTES) throw new ToolError('LIMIT_EXCEEDED', 'Request exceeds the 16 MiB input budget')
      chunks.push(buffer)
    }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)) }
    catch { throw new ToolError('INVALID_UTF8', 'Request is not valid UTF-8') }
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw new ToolError('IO_ERROR', 'Could not read the JSON input')
  } finally { await handle?.close() }
}

async function run(): Promise<string> {
  let args
  try {
    args = parseArgs({ allowPositionals: true, strict: true, tokens: true, options: {
      file: { type: 'string' }, input: { type: 'string' }, json: { type: 'boolean' },
      'document-version': { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    } })
  } catch { throw new ToolError('INVALID_ARGUMENT', 'Invalid arguments; use --help') }
  const options = args.tokens.filter((token) => token.kind === 'option')
  if (new Set(options.map((token) => token.name)).size !== options.length) {
    throw new ToolError('INVALID_ARGUMENT', 'Duplicate command-line options are not allowed')
  }
  const { values, positionals } = args
  if (values.help || values.version) {
    if (positionals.length || options.length !== 1) throw new ToolError('INVALID_ARGUMENT', '--help and --version must be used alone')
    return values.help ? HELP : MDV_AGENT_TOOL_VERSION + '\n'
  }
  const command = positionals[0]
  if (command && ['save-reference', 'commit-reference', 'commit-document', 'checkout-reference', 'checkout-document', 'import-resource', 'create'].includes(command)) {
    throw new ToolError('PERMISSION_DENIED', 'Default tools permit paired reads and save-document only; Ref and history mutations are not exposed')
  }
  if (positionals.length !== 1 || !['read', 'save-document'].includes(command ?? '')) {
    throw new ToolError('INVALID_ARGUMENT', 'Choose read or save-document; use --help')
  }
  if (!values.file || extname(values.file).toLowerCase() !== '.mdv' || /^(?:[a-z][a-z0-9+.-]*:\/\/|mdv:)/i.test(values.file)) {
    throw new ToolError('INVALID_ARGUMENT', '--file must name a local .mdv file, not a virtual URI')
  }
  const file = resolve(values.file)
  if (command === 'read') {
    if (values.input !== undefined) throw new ToolError('INVALID_ARGUMENT', 'read does not accept --input')
    const version = values['document-version'] === undefined ? undefined : parseVersion(values['document-version'])
    const pair = await readPair(file, version)
    return values.json ? jsonOutput(pair) : textOutput(pair)
  }
  if (values['document-version'] !== undefined) throw new ToolError('PERMISSION_DENIED', 'History is read-only; save-document targets the current working copy')
  if (!values.input) throw new ToolError('INVALID_ARGUMENT', 'save-document requires --input <request.json|->')
  const input = parseSaveRequest(await readInput(values.input))
  return jsonOutput(await saveDocument(file, input))
}

function writeOutput(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.once('error', fail)
    process.stdout.write(text, (error) => {
      if (error) fail(error)
      else { process.stdout.off('error', fail); done() }
    })
  })
}

async function main(): Promise<void> {
  let output: string
  try { output = await run() }
  catch (error) {
    const result = failure(error)
    process.exitCode = result.exitCode
    output = result.output
  }
  try { await writeOutput(output) }
  catch {
    process.exitCode = 1
    process.stderr.write('MDV OUTPUT_ERROR: result delivery failed; a write may already be saved. Re-read before retrying.\n')
  }
}

void main()
