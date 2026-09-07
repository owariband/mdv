export type ArchiveErrorCode =
  | 'NOT_MDV'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ARCHIVE'
  | 'INVALID_MANIFEST'
  | 'INVALID_TREE'
  | 'INVALID_VERSION'
  | 'INVALID_UTF8'
  | 'INTEGRITY_MISMATCH'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'IO_ERROR'

export type ArchiveErrorDetails = Readonly<Record<string, unknown>>

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  readonly entry: string | null
  readonly details: ArchiveErrorDetails

  constructor(
    code: ArchiveErrorCode,
    message: string,
    options: {
      readonly entry?: string
      readonly details?: ArchiveErrorDetails
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ArchiveError'
    this.code = code
    this.entry = options.entry ?? null
    this.details = Object.freeze({
      ...(options.details ?? {}),
      ...(this.entry === null ? {} : { entry: this.entry }),
    })
  }
}
