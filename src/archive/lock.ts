import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { ArchiveError } from './errors.js'

export interface ArchiveLock {
  readonly lockPath: string
  release(): Promise<void>
}

export async function canonicalizeTargetPath(path: string): Promise<string> {
  const absolutePath = resolve(path)
  if (process.platform === 'win32' && /[. ]$/.test(basename(absolutePath))) {
    throw new ArchiveError('IO_ERROR', `Unsupported Windows MDV target name ${absolutePath}`, {
      details: {
        path: absolutePath,
        stage: 'resolve-target',
        committed: false,
        reason: 'windows-trailing-dot-or-space',
      },
    })
  }
  const parentPath = dirname(absolutePath)
  let canonicalPath: string
  try {
    canonicalPath = join(await realpath(parentPath), basename(absolutePath))
  } catch (cause) {
    const ioCode = fileSystemErrorCode(cause)
    throw new ArchiveError(
      ioCode === 'ENOENT' || ioCode === 'ENOTDIR' ? 'NOT_FOUND' : 'IO_ERROR',
      `Failed to resolve MDV parent directory ${parentPath}`,
      {
        details: {
          path: absolutePath,
          parentPath,
          stage: 'resolve-target',
          committed: false,
          ...(ioCode === null ? {} : { ioCode }),
        },
        cause,
      },
    )
  }

  let before
  try {
    before = await lstat(canonicalPath, { bigint: true })
  } catch (cause) {
    if (fileSystemErrorCode(cause) === 'ENOENT') {
      return canonicalPath
    }
    throw targetResolutionError(absolutePath, canonicalPath, cause)
  }
  if (before.isSymbolicLink()) {
    return canonicalPath
  }

  let finalPath: string
  let after
  try {
    finalPath = await realpath(canonicalPath)
    after = await lstat(canonicalPath, { bigint: true })
  } catch (cause) {
    throw targetResolutionError(absolutePath, canonicalPath, cause)
  }
  if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) {
    throw new ArchiveError('CONFLICT', `MDV target changed while resolving ${absolutePath}`, {
      details: {
        path: absolutePath,
        stage: 'resolve-target',
        committed: false,
        reason: 'target-changed',
      },
    })
  }
  return finalPath
}

function targetResolutionError(
  absolutePath: string,
  canonicalPath: string,
  cause: unknown,
): ArchiveError {
  const ioCode = fileSystemErrorCode(cause)
  return new ArchiveError(
    ioCode === 'ENOENT' || ioCode === 'ENOTDIR' ? 'NOT_FOUND' : 'IO_ERROR',
    `Failed to resolve MDV target ${absolutePath}`,
    {
      details: {
        path: absolutePath,
        canonicalPath,
        stage: 'resolve-target',
        committed: false,
        ...(ioCode === null ? {} : { ioCode }),
      },
      cause,
    },
  )
}

/**
 * Uses one adjacent directory as a cooperative cross-process mutex.
 * Stale locks are deliberately never reclaimed automatically.
 */
export async function acquireArchiveLock(targetPath: string): Promise<ArchiveLock> {
  const lockPath = `${targetPath}.lock`
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (cause) {
    const ioCode = fileSystemErrorCode(cause)
    if (ioCode === 'EEXIST') {
      throw new ArchiveError('CONFLICT', `MDV document is locked: ${targetPath}`, {
        details: {
          path: targetPath,
          lockPath,
          stage: 'acquire-lock',
          committed: false,
          reason: 'locked',
        },
        cause,
      })
    }
    throw new ArchiveError('IO_ERROR', `Failed to lock MDV document ${targetPath}`, {
      details: {
        path: targetPath,
        lockPath,
        stage: 'acquire-lock',
        committed: false,
        ...(ioCode === null ? {} : { ioCode }),
      },
      cause,
    })
  }

  let released = false
  return Object.freeze({
    lockPath,
    async release(): Promise<void> {
      if (released) {
        return
      }
      await rmdir(lockPath)
      released = true
    },
  })
}

export function fileSystemErrorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') {
    return null
  }
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : null
}
