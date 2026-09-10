import { MdvError, type ContentSpec, type DocumentId, type VersionId } from '@owariband/mdv'

export const MAX_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export class ToolError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT' | 'INVALID_UTF8' | 'LIMIT_EXCEEDED' | 'PERMISSION_DENIED' | 'IO_ERROR',
    message: string,
  ) { super(message); this.name = 'ToolError' }
}

export interface SaveDocumentRequest {
  readonly expectedDocumentId: DocumentId
  readonly expectedGeneration: number
  readonly markdown: string
}

export interface ReadPair {
  readonly documentId: DocumentId
  readonly generation: number
  readonly baseDirectory: string
  readonly reference: { readonly source: ContentSpec | null; readonly text: string }
  readonly document: { readonly source: ContentSpec; readonly text: string }
  readonly permissions: { readonly reference: 'read-only'; readonly document: 'read-only' | 'read-write' }
}

export function parseSaveRequest(text: string): SaveDocumentRequest {
  let input: unknown
  try { input = JSON.parse(text) }
  catch { throw new ToolError('INVALID_ARGUMENT', 'Input must be one valid JSON object') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolError('INVALID_ARGUMENT', 'Input must be a save-document request object')
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).some((key) => !['expectedDocumentId', 'expectedGeneration', 'markdown'].includes(key))) {
    throw new ToolError('INVALID_ARGUMENT', 'Only expectedDocumentId, expectedGeneration and markdown are accepted; Ref and history are read-only')
  }
  if (typeof value.expectedDocumentId !== 'string' || !/^d_[0-9a-f]{32}$/.test(value.expectedDocumentId)
    || typeof value.expectedGeneration !== 'number' || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 0
    || typeof value.markdown !== 'string') {
    throw new ToolError('INVALID_ARGUMENT', 'A saved read baseline (expectedDocumentId, expectedGeneration) and Markdown string are required')
  }
  if (Buffer.from(value.markdown, 'utf8').toString('utf8') !== value.markdown) {
    throw new ToolError('INVALID_UTF8', 'Markdown must not contain unpaired Unicode surrogates')
  }
  return { expectedDocumentId: value.expectedDocumentId as DocumentId,
    expectedGeneration: value.expectedGeneration, markdown: value.markdown }
}

export function parseVersion(value: string): VersionId {
  if (!/^v_[0-9a-f]{32}$/.test(value)) throw new ToolError('INVALID_ARGUMENT', 'Invalid Document Version ID')
  return value as VersionId
}

export function jsonOutput(data: unknown): string {
  const output = JSON.stringify({ protocolVersion: 1, ok: true, data }) + '\n'
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', 'Response exceeds the 32 MiB output budget; no content was truncated')
  }
  return output
}

export function textOutput(pair: ReadPair): string {
  const source = (value: ContentSpec | null) => value === null ? 'unbound'
    : value.kind === 'version' ? value.version : 'working-copy'
  return 'documentId: ' + pair.documentId + '\ngeneration: ' + pair.generation
    + '\nreference source: ' + source(pair.reference.source)
    + '\ndocument source: ' + source(pair.document.source)
    + '\nreference access: ' + pair.permissions.reference + '\ndocument access: ' + pair.permissions.document
    + '\n\nreference document:\n' + pair.reference.text
    + '\n\nactual document:\n' + pair.document.text + '\n'
}

export function failure(error: unknown) {
  const core = error instanceof MdvError
  const adapter = error instanceof ToolError
  const code = core || adapter ? error.code : 'INTERNAL_ERROR'
  const exitCode = core ? 3 : code === 'PERMISSION_DENIED' ? 4
    : code === 'IO_ERROR' ? 3 : adapter ? 2 : 1
  return { exitCode, output: JSON.stringify({ protocolVersion: 1, ok: false, error: {
    origin: core ? 'core' : 'adapter', code,
    message: core || adapter ? error.message : 'Unexpected tool failure; re-read the document before retrying a write',
    ...(core ? { details: error.details } : {}),
  } }) + '\n' }
}
