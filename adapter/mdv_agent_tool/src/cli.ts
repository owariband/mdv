#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { parseArgs, TextDecoder } from 'node:util'
import {
  checkout,
  commit,
  create,
  diff,
  importResource,
  readPair,
  resolveResource,
  save,
  status,
  trace,
  verify,
  verifyResource,
  versions,
} from './commands.js'
import {
  failure,
  jsonOutput,
  MAX_INPUT_BYTES,
  parseCheckoutRequest,
  parseCommitRequest,
  parseDiffRequest,
  parseImportResourceRequest,
  parseResourceRequest,
  parseSaveRequest,
  parseTree,
  parseVerifyResourceRequest,
  parseVersion,
  textOutput,
  ToolError,
} from './protocol.js'

declare const MDV_AGENT_TOOL_VERSION: string

const COMMANDS = [
  'create', 'read', 'status', 'versions', 'trace', 'diff', 'verify',
  'save-document', 'commit-document', 'checkout-document',
  'save-reference', 'commit-reference', 'checkout-reference',
  'import-resource', 'resolve-resource', 'verify-resource',
] as const

const HELP = 'MDV Agent Tool ' + MDV_AGENT_TOOL_VERSION + '\n\n'
  + 'Read and diagnose:\n'
  + '  mdv read --file <path.mdv> [--json] [--document-version <version-id>]\n'
  + '  mdv status|versions|verify --file <path.mdv> [command options]\n'
  + '  mdv trace --file <path.mdv> --tree <reference|document> --version-id <id>\n'
  + '  mdv diff --file <path.mdv> --input <request.json|->\n\n'
  + 'Write Document:\n'
  + '  mdv save-document|commit-document|checkout-document --file <path.mdv> --input <request.json|->\n\n'
  + 'Write Reference (visible user approval is required before adding the flag):\n'
  + '  mdv save-reference|commit-reference|checkout-reference --file <path.mdv> --input <request.json|-> --user-approved-reference-write\n\n'
  + 'Create and managed images:\n'
  + '  mdv create --file <path.mdv> [--markdown-profile <profile>]\n'
  + '  mdv import-resource|resolve-resource|verify-resource --file <path.mdv> --input <request.json|->\n\n'
  + 'Current writes require a tree baseline copied from read/status. The package lock remains document-wide;\n'
  + 'stale generations are rebased only while the target tree content (and, for history operations, HEAD) is unchanged.\n'
  + 'Document commits require an explicit Reference Version or null and actor.type=agent. Nothing auto-commits.\n'
  + 'Discarding dirty working-copy content additionally requires --user-approved-discard.\n'
  + 'Limits: JSON input 16 MiB, JSON output 32 MiB, managed image 32 MiB. Use --help alone.\n'

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
      'document-version': { type: 'string' }, tree: { type: 'string' }, 'version-id': { type: 'string' },
      mode: { type: 'string' }, 'markdown-profile': { type: 'string' },
      'user-approved-reference-write': { type: 'boolean' }, 'user-approved-discard': { type: 'boolean' },
      help: { type: 'boolean' }, version: { type: 'boolean' },
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
  if (positionals.length !== 1 || !COMMANDS.includes(command as typeof COMMANDS[number])) {
    throw new ToolError('INVALID_ARGUMENT', 'Choose one MDV command; use --help')
  }
  if (!values.file || extname(values.file).toLowerCase() !== '.mdv'
    || /^(?:[a-z][a-z0-9+.-]*:\/\/|mdv:)/i.test(values.file)) {
    throw new ToolError('INVALID_ARGUMENT', '--file must name a local .mdv file, not a virtual URI')
  }
  const file = resolve(values.file)

  switch (command) {
    case 'create': {
      allowOnly(options, ['file', 'markdown-profile'])
      const profile = values['markdown-profile']
      if (profile !== undefined && !/^[a-z][a-z0-9._-]{0,63}$/.test(profile)) {
        throw new ToolError('INVALID_ARGUMENT', '--markdown-profile must be a lowercase profile token up to 64 characters')
      }
      return jsonOutput(await create(file, profile))
    }
    case 'read': {
      allowOnly(options, ['file', 'json', 'document-version'])
      const version = values['document-version'] === undefined ? undefined : parseVersion(values['document-version'])
      const pair = await readPair(file, version)
      return values.json ? jsonOutput(pair) : textOutput(pair)
    }
    case 'status':
      allowOnly(options, ['file'])
      return jsonOutput(await status(file))
    case 'versions':
      allowOnly(options, ['file', 'tree'])
      return jsonOutput(await versions(file, parseTree(values.tree)))
    case 'trace': {
      allowOnly(options, ['file', 'tree', 'version-id'])
      const tree = parseTree(values.tree)
      if (tree === undefined || values['version-id'] === undefined) {
        throw new ToolError('INVALID_ARGUMENT', 'trace requires --tree and --version-id')
      }
      return jsonOutput(await trace(file, tree, parseVersion(values['version-id'])))
    }
    case 'diff':
      allowOnly(options, ['file', 'input'])
      return jsonOutput(await diff(file, parseDiffRequest(await requiredInput(values.input, command))))
    case 'verify': {
      allowOnly(options, ['file', 'mode'])
      const mode = values.mode ?? 'full'
      if (mode !== 'metadata' && mode !== 'full') throw new ToolError('INVALID_ARGUMENT', '--mode must equal metadata or full')
      return jsonOutput(await verify(file, mode))
    }
    case 'save-document':
    case 'save-reference': {
      const tree = command === 'save-reference' ? 'reference' : 'document'
      allowOnly(options, tree === 'reference'
        ? ['file', 'input', 'user-approved-reference-write'] : ['file', 'input'])
      if (tree === 'reference' && !values['user-approved-reference-write']) requireReferenceApproval(command, file)
      return jsonOutput(await save(file, tree, parseSaveRequest(await requiredInput(values.input, command), tree)))
    }
    case 'commit-document':
    case 'commit-reference': {
      const tree = command === 'commit-reference' ? 'reference' : 'document'
      allowOnly(options, tree === 'reference'
        ? ['file', 'input', 'user-approved-reference-write'] : ['file', 'input'])
      if (tree === 'reference' && !values['user-approved-reference-write']) requireReferenceApproval(command, file)
      return jsonOutput(await commit(file, tree, parseCommitRequest(await requiredInput(values.input, command), tree)))
    }
    case 'checkout-document':
    case 'checkout-reference': {
      const tree = command === 'checkout-reference' ? 'reference' : 'document'
      allowOnly(options, tree === 'reference'
        ? ['file', 'input', 'user-approved-reference-write', 'user-approved-discard']
        : ['file', 'input', 'user-approved-discard'])
      if (tree === 'reference' && !values['user-approved-reference-write']) requireReferenceApproval(command, file)
      const request = parseCheckoutRequest(await requiredInput(values.input, command), tree)
      if (request.discardChanges && !values['user-approved-discard']) requireDiscardApproval(command, file, tree)
      if (!request.discardChanges && values['user-approved-discard']) {
        throw new ToolError('INVALID_ARGUMENT', '--user-approved-discard is only valid when discardChanges is true')
      }
      return jsonOutput(await checkout(file, tree, request))
    }
    case 'import-resource':
      allowOnly(options, ['file', 'input'])
      return jsonOutput(await importResource(file,
        parseImportResourceRequest(await requiredInput(values.input, command))))
    case 'resolve-resource':
      allowOnly(options, ['file', 'input'])
      return jsonOutput(await resolveResource(file,
        parseResourceRequest(await requiredInput(values.input, command))))
    case 'verify-resource':
      allowOnly(options, ['file', 'input'])
      return jsonOutput(await verifyResource(file,
        parseVerifyResourceRequest(await requiredInput(values.input, command))))
    default:
      throw new ToolError('INVALID_ARGUMENT', 'Unsupported command; use --help')
  }
}

function allowOnly(options: readonly { readonly name: string }[], allowed: readonly string[]): void {
  const unexpected = options.find((option) => !allowed.includes(option.name))
  if (unexpected) throw new ToolError('INVALID_ARGUMENT', `--${unexpected.name} is not valid for this command`)
}

async function requiredInput(path: string | undefined, command: string): Promise<string> {
  if (!path) throw new ToolError('INVALID_ARGUMENT', `${command} requires --input <request.json|->`)
  return readInput(path)
}

function requireReferenceApproval(action: string, file: string): never {
  throw new ToolError('USER_APPROVAL_REQUIRED',
    `Ask the user visibly before ${action}; rerun with --user-approved-reference-write only after approval`, {
      requiredApproval: { scope: 'reference-write', action, file },
    })
}

function requireDiscardApproval(action: string, file: string, tree: string): never {
  throw new ToolError('USER_APPROVAL_REQUIRED',
    `Ask the user visibly before discarding saved ${tree} working-copy changes`, {
      requiredApproval: { scope: 'discard-working-copy', action, file, tree },
    })
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
