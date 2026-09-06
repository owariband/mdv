export type MdvErrorCode =
  | 'NOT_MDV'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ARCHIVE'
  | 'INVALID_MANIFEST'
  | 'INVALID_TREE'
  | 'INVALID_VERSION'
  | 'INVALID_GRAPH'
  | 'INVALID_UTF8'
  | 'INTEGRITY_MISMATCH'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'IO_ERROR'

export type MdvErrorDetails = Readonly<Record<string, unknown>>

interface MdvErrorOptions {
  readonly details?: MdvErrorDetails
  readonly cause?: unknown
}

export class MdvError extends Error {
  readonly code: MdvErrorCode
  readonly details: MdvErrorDetails

  constructor(code: MdvErrorCode, message: string, options: MdvErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MdvError'
    this.code = code
    this.details = Object.freeze({ ...(options.details ?? {}) })
  }
}

