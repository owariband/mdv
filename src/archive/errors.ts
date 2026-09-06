export type ArchiveErrorCode =
  | 'NOT_MDV'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ARCHIVE'
  | 'INVALID_MANIFEST'
  | 'INVALID_TREE'
  | 'INVALID_VERSION'
  | 'INVALID_UTF8'
  | 'INTEGRITY_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'IO_ERROR'

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  readonly entry: string | null

  constructor(
    code: ArchiveErrorCode,
    message: string,
    options: { readonly entry?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ArchiveError'
    this.code = code
    this.entry = options.entry ?? null
  }
}

