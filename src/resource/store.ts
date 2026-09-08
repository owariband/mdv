import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { checkResourceSize, ResourceError, validateResourceContent } from './model.js'
import type { PreparedResource, ResourceLocation } from './model.js'

// Package-private checkpoints exercise real filesystem races and publication failures.
export interface ResourceTestHooks {
  checkpoint(stage: string, context: Readonly<{
    path: string
    tempPath?: string
    committed?: boolean
  }>): void | Promise<void>
}

interface ResourceDirectory {
  readonly path: string
  readonly parents: readonly { readonly path: string; readonly stats: BigIntStats }[]
}

export async function resolveResource(
  baseDirectory: string,
  resource: ResourceLocation,
): Promise<string> {
  let path = baseDirectory
  try {
    const directory = await locateDirectory(baseDirectory, resource.documentId, false)
    path = join(directory.path, resource.fileName)
    const { file } = await openResourceFile(path)
    await file.close()
    await requireUnchangedDirectories(directory)
    return path
  } catch (cause) {
    throw resourceFailure(cause, { path, relativePath: resource.relativePath, stage: 'resolve' })
  }
}

export async function readResource(
  baseDirectory: string,
  resource: ResourceLocation,
  maxBytes: number,
  hooks?: ResourceTestHooks,
): Promise<Uint8Array> {
  let path = baseDirectory
  try {
    const directory = await locateDirectory(baseDirectory, resource.documentId, false)
    path = join(directory.path, resource.fileName)
    const bytes = await readVerifiedFile(path, resource, maxBytes, hooks)
    await requireUnchangedDirectories(directory)
    return bytes
  } catch (cause) {
    throw resourceFailure(cause, { path, relativePath: resource.relativePath, stage: 'read' })
  }
}

export async function importResource(
  baseDirectory: string,
  input: PreparedResource,
  hooks?: ResourceTestHooks,
): Promise<void> {
  const { location: resource, bytes, maxBytes } = input
  let path = baseDirectory
  let tempPath: string | undefined
  let tempFile: FileHandle | undefined
  let directory: ResourceDirectory | undefined
  let committed = false
  let stage = 'prepare-directory'
  let failure: unknown

  try {
    directory = await locateDirectory(baseDirectory, resource.documentId, true)
    path = join(directory.path, resource.fileName)
    stage = 'reuse'
    let existing: Uint8Array | undefined
    try {
      existing = await readVerifiedFile(path, resource, maxBytes)
    } catch (cause) {
      if (ioCode(cause) !== 'ENOENT') {
        throw cause
      }
    }
    if (existing !== undefined) {
      requireSameBytes(existing, bytes)
      committed = true
    } else {
      stage = 'write-temp'
      const candidate = join(directory.path, `.mdv-resource-${process.pid}-${randomBytes(12).toString('hex')}.tmp`)
      tempFile = await open(candidate, 'wx', 0o600)
      tempPath = candidate
      await tempFile.chmod(0o600)
      await tempFile.writeFile(bytes)
      await checkpoint('after-temp-write')

      stage = 'validate-temp'
      const stored = await readVerifiedFile(tempPath, resource, maxBytes)
      requireSameBytes(stored, bytes)
      stage = 'sync-temp'
      await checkpoint('before-temp-sync')
      await tempFile.sync()
      const tempIdentity = await tempFile.stat({ bigint: true })
      await tempFile.close()
      tempFile = undefined

      stage = 'publish'
      await checkpoint('before-publish')
      await requireUnchangedDirectories(directory)
      const beforePublish = await lstat(tempPath, { bigint: true })
      if (!beforePublish.isFile() || !sameIdentity(tempIdentity, beforePublish)
        || tempIdentity.size !== beforePublish.size || tempIdentity.mtimeNs !== beforePublish.mtimeNs) {
        throw new ResourceError('CONFLICT', 'Resource temporary file changed before publication', {
          reason: 'temp-changed',
        })
      }
      try {
        // A complete, synced inode becomes visible without replacing any existing name.
        await link(tempPath, path)
        committed = true
      } catch (cause) {
        if (ioCode(cause) !== 'EEXIST') {
          throw cause
        }
        requireSameBytes(await readVerifiedFile(path, resource, maxBytes), bytes)
        committed = true
      }
      await checkpoint('after-publish')
      stage = 'cleanup-temp'
      await checkpoint('before-temp-cleanup')
      await unlink(tempPath)
      tempPath = undefined
    }

    stage = 'sync-directory'
    await checkpoint('before-directory-sync')
    await requireUnchangedDirectories(directory)
    await syncDirectory(directory.path)
  } catch (cause) {
    failure = resourceFailure(cause, { path, relativePath: resource.relativePath, stage, committed })
  }

  const cleanupFailures: Readonly<Record<string, unknown>>[] = []
  if (tempFile !== undefined) {
    try {
      await tempFile.close()
    } catch (cause) {
      cleanupFailures.push(Object.freeze({ resource: 'temp-handle', path: tempPath, ioCode: ioCode(cause) }))
    }
  }
  if (tempPath !== undefined) {
    try {
      if (directory !== undefined) {
        await requireUnchangedDirectories(directory)
      }
      await unlink(tempPath)
    } catch (cause) {
      cleanupFailures.push(Object.freeze({ resource: 'temp-file', path: tempPath, ioCode: ioCode(cause) }))
    }
  }
  if (cleanupFailures.length > 0) {
    failure = resourceFailure(failure ?? new Error('Resource cleanup failed'), {
      path, relativePath: resource.relativePath, stage, committed,
      cleanupFailures: Object.freeze(cleanupFailures),
    })
  }
  if (failure !== undefined) {
    throw failure
  }

  async function checkpoint(name: string): Promise<void> {
    await hooks?.checkpoint(name, Object.freeze({ path, committed,
      ...(tempPath === undefined ? {} : { tempPath }),
    }))
  }
}

async function locateDirectory(
  baseDirectory: string,
  documentId: string,
  create: boolean,
): Promise<ResourceDirectory> {
  // The caller's base may be a legitimate alias (for example /tmp on macOS).
  const base = await realpath(baseDirectory)
  const rootStats = await lstat(base, { bigint: true })
  requireFileKind(rootStats, base, 'directory')
  const parents = [{ path: base, stats: rootStats }]
  let path = base
  for (const segment of ['.mdv-assets', documentId]) {
    path = join(path, segment)
    if (create) {
      let created = false
      try {
        await mkdir(path, { mode: 0o700 })
        created = true
      } catch (cause) {
        if (ioCode(cause) !== 'EEXIST') {
          throw cause
        }
      }
      if (created) {
        await chmod(path, 0o700)
      }
    }
    const stats = await lstat(path, { bigint: true })
    requireFileKind(stats, path, 'directory')
    if (await realpath(path) !== path) {
      throw new ResourceError('INVALID_RESOURCE', 'Resource directory is not canonical', {
        path, reason: 'non-canonical-path',
      })
    }
    parents.push({ path, stats })
    if (create) {
      // Flush each ancestor even when another importer created it concurrently.
      await syncDirectory(dirname(path))
    }
  }
  const directory = { path, parents }
  await requireUnchangedDirectories(directory)
  return directory
}

async function requireUnchangedDirectories(directory: ResourceDirectory): Promise<void> {
  for (const parent of directory.parents) {
    const stats = await lstat(parent.path, { bigint: true })
    if (!stats.isDirectory() || !sameIdentity(parent.stats, stats)) {
      throw new ResourceError('CONFLICT', 'Resource directory changed during the operation', {
        path: parent.path, reason: 'directory-changed',
      })
    }
  }
}

async function openResourceFile(path: string): Promise<{ file: FileHandle; stats: BigIntStats }> {
  const before = await lstat(path, { bigint: true })
  requireFileKind(before, path, 'file')
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const file = await open(path, flags)
  try {
    const stats = await file.stat({ bigint: true })
    requireFileKind(stats, path, 'file')
    const after = await lstat(path, { bigint: true })
    if (!after.isFile() || !sameIdentity(before, stats) || !sameIdentity(stats, after)) {
      throw new ResourceError('CONFLICT', 'Resource changed while opening', {
        path, reason: 'target-changed',
      })
    }
    if (await realpath(path) !== path) {
      throw new ResourceError('INVALID_RESOURCE', 'Resource file is not canonical', {
        path, reason: 'non-canonical-path',
      })
    }
    return { file, stats }
  } catch (cause) {
    try {
      await file.close()
    } catch (cleanupCause) {
      throw resourceFailure(cause, { path, cleanupIoCode: ioCode(cleanupCause) })
    }
    throw cause
  }
}

async function readVerifiedFile(
  path: string,
  resource: ResourceLocation,
  maxBytes: number,
  hooks?: ResourceTestHooks,
): Promise<Uint8Array> {
  const { file, stats } = await openResourceFile(path)
  let failure: unknown
  try {
    checkResourceSize(Number(stats.size), maxBytes)
    await hooks?.checkpoint('after-open', Object.freeze({ path }))
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) {
        break
      }
      total += bytesRead
      checkResourceSize(total, maxBytes)
      chunks.push(chunk.subarray(0, bytesRead))
      await hooks?.checkpoint('after-read-chunk', Object.freeze({ path }))
    }
    const after = await file.stat({ bigint: true })
    // Link-count/ctime changes during another importer's publish are harmless.
    if (stats.size !== after.size || stats.mtimeNs !== after.mtimeNs) {
      throw new ResourceError('CONFLICT', 'Resource changed while reading', {
        path, reason: 'content-changed',
      })
    }
    const bytes = Buffer.concat(chunks, total)
    validateResourceContent(bytes, resource)
    return bytes
  } catch (cause) {
    failure = cause
    throw cause
  } finally {
    try {
      await file.close()
    } catch (cause) {
      throw resourceFailure(failure ?? cause, { path, cleanupIoCode: ioCode(cause) })
    }
  }
}

function requireFileKind(stats: BigIntStats, path: string, kind: 'file' | 'directory'): void {
  if (stats.isSymbolicLink() || !(kind === 'file' ? stats.isFile() : stats.isDirectory())) {
    throw new ResourceError('INVALID_RESOURCE', `Managed resource ${kind} is unsafe`, {
      path, reason: stats.isSymbolicLink() ? 'symlink' : `non-regular-${kind}`,
    })
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function requireSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  if (!Buffer.from(actual).equals(expected)) {
    throw new ResourceError('INTEGRITY_MISMATCH', 'Existing resource bytes differ from the import', {
      reason: 'content-collision',
    })
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

function ioCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') {
    return null
  }
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function resourceFailure(cause: unknown, details: Readonly<Record<string, unknown>>): ResourceError {
  if (cause instanceof ResourceError) {
    return new ResourceError(cause.code, cause.message, { ...cause.details, ...details }, cause)
  }
  const code = ioCode(cause)
  return new ResourceError(
    code === 'ENOENT' || code === 'ENOTDIR' ? 'NOT_FOUND'
      : code === 'ELOOP' ? 'INVALID_RESOURCE' : 'IO_ERROR',
    'Managed resource filesystem operation failed',
    { ...details, ...(code === null ? {} : { ioCode: code }),
      ...(code === 'ELOOP' ? { reason: 'symlink' } : {}),
    },
    cause,
  )
}
