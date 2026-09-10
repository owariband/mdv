import { MdvError, type Actor, type ContentSpec, type DocumentId, type TreeKind, type VersionId } from '@owariband/mdv'

export const PROTOCOL_VERSION = 2
export const MAX_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024

type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_UTF8'
  | 'LIMIT_EXCEEDED'
  | 'PERMISSION_DENIED'
  | 'USER_APPROVAL_REQUIRED'
  | 'CONFLICT'
  | 'IO_ERROR'

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) { super(message); this.name = 'ToolError' }
}

export interface TreeBaseline {
  readonly documentId: DocumentId
  readonly generation: number
  readonly tree: TreeKind
  readonly head: VersionId | null
  readonly contentBytes: number
  readonly contentSha256: string
}

export interface ReadPair {
  readonly documentId: DocumentId
  readonly generation: number
  readonly baseDirectory: string
  readonly reference: {
    readonly source: ContentSpec | null
    readonly text: string
    readonly baseline?: TreeBaseline
  }
  readonly document: {
    readonly source: ContentSpec
    readonly text: string
    readonly baseline?: TreeBaseline
  }
  readonly permissions: {
    readonly reference: 'read-only' | 'approval-required'
    readonly document: 'read-only' | 'read-write'
  }
}

export interface SaveRequest {
  readonly baseline: TreeBaseline
  readonly markdown: string
}

export interface CommitRequest {
  readonly baseline: TreeBaseline
  readonly summary: string
  readonly actor: Actor & { readonly type: 'agent' }
  readonly referenceVersion?: VersionId | null
}

export interface CheckoutRequest {
  readonly baseline: TreeBaseline
  readonly version: VersionId
  readonly discardChanges: boolean
}

export interface DiffRequest {
  readonly from: ContentSpec
  readonly to: ContentSpec
  readonly contextLines?: number
}

export interface ImportResourceRequest {
  readonly expectedDocumentId: DocumentId
  readonly sourceFile: string
  readonly mediaType?: string
  readonly maxBytes: number
}

export interface ResourceRequest {
  readonly expectedDocumentId: DocumentId
  readonly relativePath: string
}

export interface VerifyResourceRequest extends ResourceRequest {
  readonly maxBytes: number
}

export function parseSaveRequest(text: string, tree: TreeKind): SaveRequest {
  const value = requestObject(text, 'save request', ['baseline', 'markdown'])
  const baseline = parseBaseline(value.baseline, tree)
  if (typeof value.markdown !== 'string') throw invalid('markdown must be a string')
  validateUtf8(value.markdown, 'Markdown')
  return { baseline, markdown: value.markdown }
}

export function parseCommitRequest(text: string, tree: TreeKind): CommitRequest {
  const keys = tree === 'document'
    ? ['baseline', 'summary', 'actor', 'referenceVersion']
    : ['baseline', 'summary', 'actor']
  const value = requestObject(text, `${tree} commit request`, keys)
  const baseline = parseBaseline(value.baseline, tree)
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0 || value.summary.length > 4096) {
    throw invalid('summary must be a non-blank string up to 4096 characters')
  }
  const actor = parseAgentActor(value.actor)
  if (tree === 'reference') return { baseline, summary: value.summary, actor }
  if (!Object.hasOwn(value, 'referenceVersion')) {
    throw invalid('commit-document requires an explicit referenceVersion or null; latest Ref is never selected implicitly')
  }
  const referenceVersion = value.referenceVersion === null ? null : parseVersionValue(value.referenceVersion, 'referenceVersion')
  return { baseline, summary: value.summary, actor, referenceVersion }
}

export function parseCheckoutRequest(text: string, tree: TreeKind): CheckoutRequest {
  const value = requestObject(text, `${tree} checkout request`, ['baseline', 'version', 'discardChanges'])
  const baseline = parseBaseline(value.baseline, tree)
  const version = parseVersionValue(value.version, 'version')
  if (value.discardChanges !== undefined && typeof value.discardChanges !== 'boolean') {
    throw invalid('discardChanges must be a boolean when provided')
  }
  return { baseline, version, discardChanges: value.discardChanges === true }
}

export function parseDiffRequest(text: string): DiffRequest {
  const value = requestObject(text, 'diff request', ['from', 'to', 'contextLines'])
  const from = parseContentSpec(value.from, 'from')
  const to = parseContentSpec(value.to, 'to')
  if (value.contextLines !== undefined
    && (!Number.isSafeInteger(value.contextLines) || (value.contextLines as number) < 0)) {
    throw invalid('contextLines must be a non-negative safe integer when provided')
  }
  return {
    from, to,
    ...(value.contextLines === undefined ? {} : { contextLines: value.contextLines as number }),
  }
}

export function parseImportResourceRequest(text: string): ImportResourceRequest {
  const value = requestObject(text, 'resource import request',
    ['expectedDocumentId', 'sourceFile', 'mediaType', 'maxBytes'])
  const expectedDocumentId = parseDocumentId(value.expectedDocumentId)
  if (typeof value.sourceFile !== 'string' || value.sourceFile.length === 0
    || /^(?:[a-z][a-z0-9+.-]*:\/\/|mdv:)/i.test(value.sourceFile)) {
    throw invalid('sourceFile must name an explicit local image file')
  }
  if (value.mediaType !== undefined && typeof value.mediaType !== 'string') {
    throw invalid('mediaType must be a string when provided')
  }
  return {
    expectedDocumentId,
    sourceFile: value.sourceFile,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    maxBytes: parseMaxBytes(value.maxBytes),
  }
}

export function parseResourceRequest(text: string): ResourceRequest {
  const value = requestObject(text, 'managed resource request',
    ['expectedDocumentId', 'relativePath'])
  return parseResourceLocator(value)
}

export function parseVerifyResourceRequest(text: string): VerifyResourceRequest {
  const value = requestObject(text, 'managed resource verification request',
    ['expectedDocumentId', 'relativePath', 'maxBytes'])
  return { ...parseResourceLocator(value), maxBytes: parseMaxBytes(value.maxBytes) }
}

function parseResourceLocator(value: Record<string, unknown>): ResourceRequest {
  const expectedDocumentId = parseDocumentId(value.expectedDocumentId)
  if (typeof value.relativePath !== 'string' || value.relativePath.length === 0) {
    throw invalid('relativePath must be a non-empty string')
  }
  return { expectedDocumentId, relativePath: value.relativePath }
}

export function parseTree(value: string | undefined): TreeKind | undefined {
  if (value === undefined) return undefined
  if (value !== 'reference' && value !== 'document') throw invalid('tree must equal reference or document')
  return value
}

export function parseVersion(value: string): VersionId {
  return parseVersionValue(value, 'Version ID')
}

export function jsonOutput(data: unknown): string {
  const output = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ok: true, data }) + '\n'
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', 'Response exceeds the 32 MiB output budget; no content was truncated')
  }
  return output
}

export function textOutput(pair: ReadPair): string {
  const source = (value: ContentSpec | null) => value === null ? 'unbound'
    : value.kind === 'version' ? value.version : 'working-copy'
  const baselines = pair.reference.baseline && pair.document.baseline
    ? '\nreference baseline: ' + JSON.stringify(pair.reference.baseline)
      + '\ndocument baseline: ' + JSON.stringify(pair.document.baseline)
    : ''
  const output = 'documentId: ' + pair.documentId + '\ngeneration: ' + pair.generation
    + '\nreference source: ' + source(pair.reference.source)
    + '\ndocument source: ' + source(pair.document.source)
    + '\nreference access: ' + pair.permissions.reference + '\ndocument access: ' + pair.permissions.document
    + baselines
    + '\n\nreference document:\n' + pair.reference.text
    + '\n\nactual document:\n' + pair.document.text + '\n'
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', 'Response exceeds the 32 MiB output budget; no content was truncated')
  }
  return output
}

export function failure(error: unknown) {
  const core = error instanceof MdvError
  const adapter = error instanceof ToolError
  const code = core || adapter ? error.code : 'INTERNAL_ERROR'
  const exitCode = core ? 3
    : code === 'PERMISSION_DENIED' || code === 'USER_APPROVAL_REQUIRED' ? 4
      : code === 'CONFLICT' || code === 'IO_ERROR' ? 3 : adapter ? 2 : 1
  const details = adapter ? error.details : undefined
  const requiredApproval = code === 'USER_APPROVAL_REQUIRED' ? details?.requiredApproval : undefined
  return { exitCode, output: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ok: false, error: {
    origin: core ? 'core' : 'adapter', code,
    message: core || adapter ? error.message : 'Unexpected tool failure; re-read the document before retrying a write',
    ...(core ? { details: error.details }
      : requiredApproval !== undefined ? { requiredApproval }
        : details && Object.keys(details).length ? { details } : {}),
  } }) + '\n' }
}

function requestObject(text: string, name: string, allowedKeys: readonly string[]): Record<string, unknown> {
  let input: unknown
  try { input = JSON.parse(text) }
  catch { throw invalid('Input must be one valid JSON object') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid(`Input must be a ${name} object`)
  }
  const value = input as Record<string, unknown>
  const unknown = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknown !== undefined) throw invalid(`Unknown ${name} field: ${unknown}`)
  return value
}

function parseBaseline(value: unknown, tree: TreeKind): TreeBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('baseline must be an object copied from read or status')
  const baseline = value as Record<string, unknown>
  const allowed = ['documentId', 'generation', 'tree', 'head', 'contentBytes', 'contentSha256']
  const unknown = Object.keys(baseline).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw invalid(`Unknown baseline field: ${unknown}`)
  const documentId = parseDocumentId(baseline.documentId)
  if (!Number.isSafeInteger(baseline.generation) || (baseline.generation as number) < 0) {
    throw invalid('baseline.generation must be a non-negative safe integer')
  }
  if (baseline.tree !== tree) throw invalid(`baseline.tree must equal ${tree} for this command`)
  const head = baseline.head === null ? null : parseVersionValue(baseline.head, 'baseline.head')
  if (!Number.isSafeInteger(baseline.contentBytes) || (baseline.contentBytes as number) < 0) {
    throw invalid('baseline.contentBytes must be a non-negative safe integer')
  }
  if (typeof baseline.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(baseline.contentSha256)) {
    throw invalid('baseline.contentSha256 must be a lowercase SHA-256 digest')
  }
  return {
    documentId, generation: baseline.generation as number, tree, head,
    contentBytes: baseline.contentBytes as number, contentSha256: baseline.contentSha256,
  }
}

function parseContentSpec(value: unknown, name: string): ContentSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be a ContentSpec object`)
  const source = value as Record<string, unknown>
  if (source.tree !== 'reference' && source.tree !== 'document') throw invalid(`${name}.tree must equal reference or document`)
  if (source.kind === 'working-copy') {
    if (Object.keys(source).some((key) => !['tree', 'kind'].includes(key))) throw invalid(`${name} working-copy has unknown fields`)
    return { tree: source.tree, kind: 'working-copy' }
  }
  if (source.kind !== 'version'
    || Object.keys(source).some((key) => !['tree', 'kind', 'version'].includes(key))) {
    throw invalid(`${name}.kind must equal working-copy or version`)
  }
  return { tree: source.tree, kind: 'version', version: parseVersionValue(source.version, `${name}.version`) }
}

function parseAgentActor(value: unknown): Actor & { readonly type: 'agent' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('actor must be an object')
  const actor = value as Record<string, unknown>
  if (Object.keys(actor).some((key) => !['type', 'id', 'name'].includes(key))) throw invalid('actor has unknown fields')
  if (actor.type !== 'agent') throw invalid('Agent Tool commits must declare actor.type as agent')
  for (const key of ['id', 'name'] as const) {
    const field = actor[key]
    if (field !== undefined && (typeof field !== 'string' || field.length === 0 || field.length > 256)) {
      throw invalid(`actor.${key} must be a non-empty string up to 256 characters`)
    }
  }
  return {
    type: 'agent',
    ...(actor.id === undefined ? {} : { id: actor.id as string }),
    ...(actor.name === undefined ? {} : { name: actor.name as string }),
  }
}

function parseDocumentId(value: unknown): DocumentId {
  if (typeof value !== 'string' || !/^d_[0-9a-f]{32}$/.test(value)) throw invalid('expectedDocumentId must be a valid Document ID')
  return value as DocumentId
}

function parseVersionValue(value: unknown, name: string): VersionId {
  if (typeof value !== 'string' || !/^v_[0-9a-f]{32}$/.test(value)) throw invalid(`${name} must be a valid Version ID`)
  return value as VersionId
}

function parseMaxBytes(value: unknown): number {
  if (value === undefined) return MAX_RESOURCE_BYTES
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_RESOURCE_BYTES) {
    throw invalid('maxBytes must be a positive safe integer no greater than 32 MiB')
  }
  return value as number
}

function validateUtf8(value: string, name: string): void {
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new ToolError('INVALID_UTF8', `${name} must not contain unpaired Unicode surrogates`)
  }
}

function invalid(message: string): ToolError {
  return new ToolError('INVALID_ARGUMENT', message)
}
