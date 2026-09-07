import type { ArchiveErrorCode, ArchiveErrorDetails } from './errors.js'
import { ArchiveError } from './errors.js'
import type {
  ArchiveReadOptions,
  ArchiveWarning,
  OpenedArchive,
} from './reader.js'
import {
  openArchiveFromBytes,
  openArchiveForVerificationFromPath,
} from './reader.js'

export interface ArchiveDiagnostic {
  readonly code: ArchiveErrorCode
  readonly message: string
  readonly entry?: string
  readonly details: ArchiveErrorDetails
}

export interface ArchiveMetadataVerification {
  readonly archive: OpenedArchive | null
  readonly complete: boolean
  readonly issues: readonly ArchiveDiagnostic[]
  readonly warnings: readonly ArchiveWarning[]
}

export interface ArchiveContentVerification {
  readonly complete: boolean
  readonly issues: readonly ArchiveDiagnostic[]
}

export async function verifyArchiveMetadataFromPath(
  path: string,
  options: ArchiveReadOptions = {},
): Promise<ArchiveMetadataVerification> {
  return verifyArchiveMetadata(() => openArchiveForVerificationFromPath(path, options))
}

export async function verifyArchiveMetadataFromBytes(
  bytes: Uint8Array,
  options: ArchiveReadOptions = {},
): Promise<ArchiveMetadataVerification> {
  return verifyArchiveMetadata(() => openArchiveFromBytes(bytes, options))
}

export async function verifyArchiveVersionContents(
  archive: OpenedArchive,
  maxIssues: number,
): Promise<ArchiveContentVerification> {
  const verification = await archive.verifyVersionContents(maxIssues)
  return Object.freeze({
    complete: verification.complete,
    issues: Object.freeze(verification.errors.map(toDiagnostic)),
  })
}

async function verifyArchiveMetadata(
  open: () => Promise<OpenedArchive>,
): Promise<ArchiveMetadataVerification> {
  try {
    const archive = await open()
    return Object.freeze({
      archive,
      complete: true,
      issues: Object.freeze([]),
      warnings: Object.freeze([...archive.warnings]),
    })
  } catch (cause) {
    if (!(cause instanceof ArchiveError)) {
      throw cause
    }
    if (cause.code === 'NOT_FOUND' || cause.code === 'IO_ERROR') {
      throw cause
    }
    return Object.freeze({
      archive: null,
      complete: false,
      issues: Object.freeze([toDiagnostic(cause)]),
      warnings: Object.freeze([]),
    })
  }
}

function toDiagnostic(error: ArchiveError): ArchiveDiagnostic {
  return Object.freeze({
    code: error.code,
    message: error.message,
    ...(error.entry === null ? {} : { entry: error.entry }),
    details: Object.freeze({ ...error.details }),
  })
}
