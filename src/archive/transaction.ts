import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  link,
  lstat,
  open,
  rename,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { encodeManifestValue } from './codec.js'
import { ArchiveError } from './errors.js'
import type { ManifestFileDto } from './format-dto.js'
import { resolveReadLimits } from './limits.js'
import {
  acquireArchiveLock,
  canonicalizeTargetPath,
  fileSystemErrorCode,
} from './lock.js'
import { openArchiveFromPath } from './reader.js'
import type {
  ArchiveReadOptions,
  ArchiveTreeKind,
  OpenedArchive,
} from './reader.js'
import { createMutationEntryPlan } from './mutation.js'
import type {
  ArchiveMutationEntryPlan,
  ArchivePackageMutation,
} from './mutation.js'
import { writeArchive } from './writer.js'
import type { ArchiveWriteEntry } from './writer.js'

export type ArchiveTransactionCommand =
  | {
      readonly type: 'create'
      readonly manifest: ManifestFileDto
    }
  | {
      readonly type: 'save-working-copy'
      readonly tree: ArchiveTreeKind
      readonly markdown: Uint8Array
      readonly expectedDocumentId: string
      readonly expectedGeneration: number
    }

export interface PlannedArchiveTransactionCommand<TResult> {
  readonly type: 'planned-mutation'
  readonly expectedDocumentId: string
  readonly expectedGeneration: number
  prepare(source: OpenedArchive): Promise<{
    readonly mutation: ArchivePackageMutation
    readonly value: TResult
  }>
}

export interface ArchiveTransactionResult {
  readonly archive: OpenedArchive
  readonly targetPath: string
}

export interface PlannedArchiveTransactionResult<TResult> extends ArchiveTransactionResult {
  readonly value: TResult
}

export type TransactionCheckpoint =
  | 'after-lock'
  | 'after-reopen'
  | 'after-temp-write'
  | 'after-temp-validate'
  | 'before-temp-sync'
  | 'before-publish'
  | 'after-publish'
  | 'before-directory-sync'
  | 'after-directory-sync'

export interface TransactionCheckpointContext {
  readonly targetPath: string
  readonly tempPath?: string
  readonly previousGeneration?: number
  readonly nextGeneration?: number
  readonly committed: boolean
}

export interface TransactionTestHooks {
  checkpoint(
    stage: TransactionCheckpoint,
    context: Readonly<TransactionCheckpointContext>,
  ): void | Promise<void>
}

export interface ArchiveTransactionOptions extends ArchiveReadOptions {
  validate(archive: OpenedArchive): void | Promise<void>
  readonly hooks?: TransactionTestHooks
}

interface TargetIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly size: bigint
  readonly modifiedNanoseconds: bigint
  readonly changedNanoseconds: bigint
  readonly mode: number
}

interface CleanupFailure {
  readonly resource:
    | 'source-archive'
    | 'result-archive'
    | 'version-stream'
    | 'temp-file'
    | 'lock'
    | 'lock-directory'
  readonly path: string
  readonly cause: unknown
}

class ArchiveGraphValidationFailure extends Error {
  constructor(readonly validationCause: unknown) {
    super('Archive graph validation failed')
    this.name = 'ArchiveGraphValidationFailure'
  }
}

export function runArchiveTransaction<TResult>(
  targetPath: string,
  command: PlannedArchiveTransactionCommand<TResult>,
  options: ArchiveTransactionOptions,
): Promise<PlannedArchiveTransactionResult<TResult>>
export function runArchiveTransaction(
  targetPath: string,
  command: ArchiveTransactionCommand,
  options: ArchiveTransactionOptions,
): Promise<ArchiveTransactionResult>
export async function runArchiveTransaction<TResult>(
  targetPath: string,
  command: ArchiveTransactionCommand | PlannedArchiveTransactionCommand<TResult>,
  options: ArchiveTransactionOptions,
): Promise<ArchiveTransactionResult | PlannedArchiveTransactionResult<TResult>> {
  const readLimits = resolveReadLimits(options.limits)
  const readOptions: ArchiveReadOptions = { limits: readLimits }
  const canonicalPath = await canonicalizeTargetPath(targetPath)
  const lock = await acquireArchiveLock(canonicalPath)
  let publishedPath = canonicalPath
  let committed = false
  let previousGeneration: number | undefined
  let nextGeneration: number | undefined
  let targetIdentity: TargetIdentity | undefined
  let targetMode: number | undefined
  let tempPath: string | undefined
  let sourceArchive: OpenedArchive | undefined
  let resultArchive: OpenedArchive | undefined
  let mutationEntryPlan: ArchiveMutationEntryPlan | undefined
  let mutationValue: TResult | undefined
  let mutationCloseFailure: unknown
  let failure: unknown
  let stage = 'prepare'

  try {
    await runCheckpoint(options.hooks, 'after-lock', context())

    let entries: readonly ArchiveWriteEntry[]
    if (command.type === 'create') {
      stage = 'check-target'
      await requireMissingTarget(canonicalPath)
      if (command.manifest.generation !== 0) {
        throw new ArchiveError('INVALID_MANIFEST', 'A new MDV document must start at generation 0')
      }
      nextGeneration = 0
      entries = createInitialEntries(command.manifest)
    } else {
      stage = 'reopen'
      const stats = await requireRegularTarget(canonicalPath)
      targetIdentity = toTargetIdentity(stats)
      targetMode = targetIdentity.mode
      sourceArchive = await openArchiveFromPath(canonicalPath, readOptions)
      previousGeneration = sourceArchive.manifest.generation
      await runCheckpoint(options.hooks, 'after-reopen', context())

      stage = 'compare-and-swap'
      if (sourceArchive.manifest.documentId !== command.expectedDocumentId) {
        throw new ArchiveError(
          'CONFLICT',
          `Expected document ${command.expectedDocumentId}, found ${sourceArchive.manifest.documentId}`,
          {
            details: {
              reason: 'document-changed',
              expectedDocumentId: command.expectedDocumentId,
              actualDocumentId: sourceArchive.manifest.documentId,
            },
          },
        )
      }
      if (previousGeneration !== command.expectedGeneration) {
        throw new ArchiveError(
          'CONFLICT',
          `Expected generation ${command.expectedGeneration}, found ${previousGeneration}`,
          {
            details: {
              expectedGeneration: command.expectedGeneration,
              actualGeneration: previousGeneration,
            },
          },
        )
      }
      await validateArchiveGraph(sourceArchive, options.validate)
      if (previousGeneration === Number.MAX_SAFE_INTEGER) {
        throw new ArchiveError('LIMIT_EXCEEDED', 'MDV generation cannot be incremented safely')
      }

      nextGeneration = previousGeneration + 1
      let mutation: ArchivePackageMutation
      if (command.type === 'save-working-copy') {
        mutation = {
          type: 'replace-working-copy',
          tree: command.tree,
          markdown: command.markdown,
        }
      } else {
        stage = 'plan-mutation'
        const prepared = await command.prepare(sourceArchive)
        mutation = prepared.mutation
        mutationValue = prepared.value
      }

      stage = 'read-source'
      mutationEntryPlan = await createMutationEntryPlan(
        sourceArchive,
        mutation,
        nextGeneration,
        readLimits,
      )
      entries = mutationEntryPlan.entries
    }

    tempPath = uniqueTempPath(canonicalPath)
    stage = 'write-temp'
    let entryFailure: unknown
    try {
      await writeArchive(tempPath, entries)
      await mutationEntryPlan?.finish()
    } catch (cause) {
      entryFailure = cause
    }
    try {
      await mutationEntryPlan?.close()
    } catch (cause) {
      if (entryFailure === undefined) {
        entryFailure = cause
      } else {
        mutationCloseFailure = cause
      }
    }
    if (entryFailure !== undefined) {
      throw entryFailure
    }
    await runCheckpoint(options.hooks, 'after-temp-write', context())

    stage = 'validate-temp'
    await validateCompleteArchive(tempPath, readOptions, options.validate)
    await runCheckpoint(options.hooks, 'after-temp-validate', context())

    stage = 'sync-temp'
    const tempFile = await open(tempPath, 'r+')
    try {
      if (targetMode !== undefined) {
        await tempFile.chmod(targetMode)
      }
      await runCheckpoint(options.hooks, 'before-temp-sync', context())
      await tempFile.sync()
    } finally {
      await tempFile.close()
    }

    stage = 'publish'
    await runCheckpoint(options.hooks, 'before-publish', context())
    if (command.type === 'create') {
      try {
        await link(tempPath, canonicalPath)
      } catch (cause) {
        if (fileSystemErrorCode(cause) === 'EEXIST') {
          throw new ArchiveError('CONFLICT', `MDV target already exists: ${canonicalPath}`, {
            details: { reason: 'target-exists' },
            cause,
          })
        }
        throw cause
      }
      committed = true
      stage = 'cleanup-temp'
      await unlink(tempPath)
      tempPath = undefined
      stage = 'resolve-published-target'
      publishedPath = await canonicalizeTargetPath(canonicalPath)
    } else {
      await requireUnchangedTarget(canonicalPath, targetIdentity)
      await rename(tempPath, canonicalPath)
      committed = true
      tempPath = undefined
    }
    stage = 'publish'
    await runCheckpoint(options.hooks, 'after-publish', context())

    stage = 'sync-directory'
    await runCheckpoint(options.hooks, 'before-directory-sync', context())
    await syncDirectory(dirname(publishedPath))
    await runCheckpoint(options.hooks, 'after-directory-sync', context())

    stage = 'open-result'
    resultArchive = await openArchiveFromPath(publishedPath, readOptions)
    await validateArchiveGraph(resultArchive, options.validate)
    if (resultArchive.manifest.generation !== nextGeneration) {
      throw new ArchiveError('IO_ERROR', 'Archive transaction returned an unexpected generation')
    }
    const expectedDocumentId = command.type === 'create'
      ? command.manifest.documentId
      : command.expectedDocumentId
    if (resultArchive.manifest.documentId !== expectedDocumentId) {
      throw new ArchiveError('IO_ERROR', 'Archive transaction returned an unexpected document')
    }
  } catch (cause) {
    failure = toTransactionError(cause, {
      targetPath: canonicalPath,
      stage,
      committed,
      ...(previousGeneration === undefined ? {} : { previousGeneration }),
      ...(nextGeneration === undefined ? {} : { nextGeneration }),
    })
  }

  const cleanupFailures: CleanupFailure[] = []
  if (mutationCloseFailure !== undefined) {
    cleanupFailures.push({
      resource: 'version-stream',
      path: canonicalPath,
      cause: mutationCloseFailure,
    })
  }
  try {
    await sourceArchive?.close()
  } catch (cause) {
    cleanupFailures.push({ resource: 'source-archive', path: canonicalPath, cause })
  }
  if (tempPath !== undefined) {
    try {
      await unlink(tempPath)
    } catch (cause) {
      cleanupFailures.push({ resource: 'temp-file', path: tempPath, cause })
    }
  }

  let lockReleased = false
  try {
    await lock.release()
    lockReleased = true
  } catch (cause) {
    cleanupFailures.push({ resource: 'lock', path: lock.lockPath, cause })
  }
  if (lockReleased) {
    try {
      await syncDirectory(dirname(canonicalPath))
    } catch (cause) {
      cleanupFailures.push({
        resource: 'lock-directory',
        path: dirname(canonicalPath),
        cause,
      })
    }
  }

  if ((failure !== undefined || cleanupFailures.length > 0) && resultArchive !== undefined) {
    try {
      await resultArchive.close()
    } catch (cause) {
      cleanupFailures.push({ resource: 'result-archive', path: canonicalPath, cause })
    }
  }

  if (cleanupFailures.length > 0) {
    failure = attachCleanupFailures(failure, cleanupFailures, {
      targetPath: canonicalPath,
      stage,
      committed,
      ...(previousGeneration === undefined ? {} : { previousGeneration }),
      ...(nextGeneration === undefined ? {} : { nextGeneration }),
    })
  }
  if (failure !== undefined) {
    throw failure
  }
  if (nextGeneration === undefined || resultArchive === undefined) {
    await resultArchive?.close().catch(() => undefined)
    throw new ArchiveError('IO_ERROR', 'Archive transaction completed without a result')
  }
  const result = Object.freeze({ archive: resultArchive, targetPath: publishedPath })
  if (command.type !== 'planned-mutation') {
    return result
  }
  return Object.freeze({ ...result, value: mutationValue as TResult })

  function context(): TransactionCheckpointContext {
    return {
      targetPath: canonicalPath,
      ...(tempPath === undefined ? {} : { tempPath }),
      ...(previousGeneration === undefined ? {} : { previousGeneration }),
      ...(nextGeneration === undefined ? {} : { nextGeneration }),
      committed,
    }
  }
}

function createInitialEntries(manifest: ManifestFileDto): readonly ArchiveWriteEntry[] {
  return [
    { name: 'manifest.json', bytes: encodeManifestValue(manifest) },
    { name: 'ref_tree/current.md', bytes: new Uint8Array() },
    { name: 'doc_tree/current.md', bytes: new Uint8Array() },
  ]
}

async function validateCompleteArchive(
  path: string,
  readOptions: ArchiveReadOptions,
  validate: (archive: OpenedArchive) => void | Promise<void>,
): Promise<void> {
  const archive = await openArchiveFromPath(path, readOptions)
  try {
    await validateArchiveGraph(archive, validate)
    for await (const _content of archive.readVersionContents()) {
      // Iteration performs UTF-8, byte-length, and SHA-256 validation in one ZIP scan.
    }
  } finally {
    await archive.close()
  }
}

async function validateArchiveGraph(
  archive: OpenedArchive,
  validate: (archive: OpenedArchive) => void | Promise<void>,
): Promise<void> {
  try {
    await validate(archive)
  } catch (cause) {
    throw new ArchiveGraphValidationFailure(cause)
  }
}

async function requireMissingTarget(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (cause) {
    if (fileSystemErrorCode(cause) === 'ENOENT') {
      return
    }
    throw cause
  }
  throw new ArchiveError('CONFLICT', `MDV target already exists: ${path}`, {
    details: { reason: 'target-exists' },
  })
}

async function requireRegularTarget(path: string): Promise<BigIntStats> {
  let stats: BigIntStats
  try {
    stats = await lstat(path, { bigint: true })
  } catch (cause) {
    const ioCode = fileSystemErrorCode(cause)
    if (ioCode === 'ENOENT' || ioCode === 'ENOTDIR') {
      throw new ArchiveError('NOT_FOUND', `MDV file not found: ${path}`, {
        details: { ioCode },
        cause,
      })
    }
    throw cause
  }

  if (!stats.isFile()) {
    throw new ArchiveError('IO_ERROR', `MDV write target must be a regular file: ${path}`, {
      details: {
        reason: stats.isSymbolicLink() ? 'symlink-target' : 'non-regular-target',
      },
    })
  }
  if (stats.nlink !== 1n) {
    throw new ArchiveError('IO_ERROR', `MDV write target must not have hard-link aliases: ${path}`, {
      details: { reason: 'hard-linked-target', links: stats.nlink.toString() },
    })
  }
  return stats
}

async function requireUnchangedTarget(
  path: string,
  expected: TargetIdentity | undefined,
): Promise<void> {
  if (expected === undefined) {
    throw new ArchiveError('IO_ERROR', 'Missing target identity before publish')
  }
  const actual = toTargetIdentity(await requireRegularTarget(path))
  if (
    actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.size !== expected.size
    || actual.modifiedNanoseconds !== expected.modifiedNanoseconds
    || actual.changedNanoseconds !== expected.changedNanoseconds
  ) {
    throw new ArchiveError('CONFLICT', `MDV target changed during save: ${path}`, {
      details: { reason: 'target-changed' },
    })
  }
}

function toTargetIdentity(stats: BigIntStats): TargetIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedNanoseconds: stats.mtimeNs,
    changedNanoseconds: stats.ctimeNs,
    mode: Number(stats.mode & 0o777n),
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function uniqueTempPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.mdv-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  )
}

async function runCheckpoint(
  hooks: TransactionTestHooks | undefined,
  stage: TransactionCheckpoint,
  context: TransactionCheckpointContext,
): Promise<void> {
  await hooks?.checkpoint(stage, Object.freeze(context))
}

function toTransactionError(
  cause: unknown,
  context: {
    readonly targetPath: string
    readonly stage: string
    readonly committed: boolean
    readonly previousGeneration?: number
    readonly nextGeneration?: number
  },
): unknown {
  const details = {
    ...(cause instanceof ArchiveError ? cause.details : {}),
    path: context.targetPath,
    stage: context.stage,
    committed: context.committed,
    ...(context.previousGeneration === undefined
      ? {}
      : { previousGeneration: context.previousGeneration }),
    ...(context.nextGeneration === undefined
      ? {}
      : { generation: context.nextGeneration }),
  }

  if (cause instanceof ArchiveError) {
    return new ArchiveError(cause.code, cause.message, { details, cause })
  }
  if (cause instanceof ArchiveGraphValidationFailure) {
    return cause.validationCause
  }
  if (cause instanceof RangeError) {
    return new ArchiveError('LIMIT_EXCEEDED', cause.message, { details, cause })
  }

  const ioCode = fileSystemErrorCode(cause)
  if (ioCode !== null) {
    return new ArchiveError('IO_ERROR', `MDV transaction failed during ${context.stage}`, {
      details: { ...details, ioCode },
      cause,
    })
  }

  return new ArchiveError('IO_ERROR', `MDV transaction failed during ${context.stage}`, {
    details,
    cause,
  })
}

function attachCleanupFailures(
  primaryFailure: unknown,
  failures: readonly CleanupFailure[],
  context: {
    readonly targetPath: string
    readonly stage: string
    readonly committed: boolean
    readonly previousGeneration?: number
    readonly nextGeneration?: number
  },
): ArchiveError {
  const cleanupFailures = failures.map(({ resource, path, cause }) => {
    const ioCode = fileSystemErrorCode(cause)
    return Object.freeze({
      resource,
      path,
      ...(ioCode === null ? {} : { ioCode }),
      message: cause instanceof Error ? cause.message : String(cause),
    })
  })
  const details = {
    ...(primaryFailure instanceof ArchiveError ? primaryFailure.details : {}),
    path: context.targetPath,
    stage: primaryFailure === undefined
      ? 'cleanup'
      : primaryFailure instanceof ArchiveError
        && typeof primaryFailure.details.stage === 'string'
        ? primaryFailure.details.stage
        : context.stage,
    committed: context.committed,
    ...(context.previousGeneration === undefined
      ? {}
      : { previousGeneration: context.previousGeneration }),
    ...(context.nextGeneration === undefined ? {} : { generation: context.nextGeneration }),
    cleanupIncomplete: true,
    cleanupFailures: Object.freeze(cleanupFailures),
  }

  if (primaryFailure instanceof ArchiveError) {
    return new ArchiveError(primaryFailure.code, primaryFailure.message, {
      details,
      cause: primaryFailure,
    })
  }
  return new ArchiveError(
    'IO_ERROR',
    primaryFailure === undefined
      ? 'MDV transaction cleanup failed'
      : 'MDV transaction failed and cleanup was incomplete',
    { details, cause: primaryFailure ?? failures[0]?.cause },
  )
}
