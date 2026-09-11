import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type {
  DesktopFailure,
  OpenedMarkdownView,
  SaveMarkdownResult,
  SaveTreeRequest,
} from '../shared/ipc.js'

const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024

export type MarkdownSaveCheckpoint = 'before-publish' | 'after-publish'

export interface MarkdownSessionOptions {
  readonly checkpoint?: (stage: MarkdownSaveCheckpoint) => void | Promise<void>
}

interface FileIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly size: bigint
  readonly modifiedNanoseconds: bigint
  readonly changedNanoseconds: bigint
  readonly mode: number
}

interface MarkdownBaseline {
  readonly identity: FileIdentity
  readonly contentBytes: number
  readonly contentSha256: string
}

interface MarkdownSnapshot extends MarkdownBaseline {
  readonly bytes: Buffer
}

type MarkdownSessionErrorCode =
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'IO_ERROR'
  | 'LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'SESSION_INVALID'

export class MarkdownSessionError extends Error {
  constructor(
    readonly code: MarkdownSessionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'MarkdownSessionError'
  }
}

export class MarkdownSession {
  readonly id = randomUUID()
  readonly filePath: string
  readonly #checkpoint: MarkdownSessionOptions['checkpoint']
  #baseline: MarkdownBaseline
  #tail: Promise<unknown> = Promise.resolve()
  #invalid: string | undefined

  private constructor(
    filePath: string,
    baseline: MarkdownBaseline,
    options: MarkdownSessionOptions,
  ) {
    this.filePath = filePath
    this.#baseline = baseline
    this.#checkpoint = options.checkpoint
  }

  static async open(
    filePath: string,
    options: MarkdownSessionOptions = {},
  ): Promise<{ session: MarkdownSession; view: OpenedMarkdownView }> {
    if (typeof filePath !== 'string'
      || !isAbsolute(filePath)
      || extname(filePath).toLowerCase() !== '.md') {
      throw new MarkdownSessionError('INVALID_ARGUMENT', 'The selected Markdown file is invalid.')
    }

    const canonicalPath = await canonicalizeMarkdownPath(filePath)
    const snapshot = await readSnapshot(canonicalPath)
    const session = new MarkdownSession(canonicalPath, snapshot, options)
    return {
      session,
      view: {
        kind: 'markdown',
        sessionId: session.id,
        displayName: basename(canonicalPath),
        markdown: decodeMarkdown(snapshot.bytes),
      },
    }
  }

  saveMarkdown(request: SaveTreeRequest): Promise<SaveMarkdownResult> {
    return this.#run(() => this.#save(request))
  }

  async #save(request: SaveTreeRequest): Promise<SaveMarkdownResult> {
    this.#validateRequest(request)
    if (this.#invalid) throw new MarkdownSessionError('SESSION_INVALID', this.#invalid)

    const nextBytes = Buffer.from(request.markdown, 'utf8')
    const nextBaseline = contentBaseline(nextBytes)
    let tempPath: string | undefined
    let committed = false
    let result: SaveMarkdownResult | undefined
    let failure: unknown

    try {
      const current = await readSnapshot(this.filePath)
      assertExpectedBaseline(this.#baseline, current)

      tempPath = uniqueTempPath(this.filePath)
      await writeSyncedTemp(tempPath, nextBytes, current.identity.mode)
      await this.#checkpoint?.('before-publish')

      const beforePublish = await readSnapshot(this.filePath)
      assertExpectedBaseline(this.#baseline, beforePublish)
      await rename(tempPath, this.filePath)
      committed = true
      tempPath = undefined
      await this.#checkpoint?.('after-publish')

      await syncDirectory(dirname(this.filePath))
      const published = await readSnapshot(this.filePath)
      if (!sameContent(nextBaseline, published)) {
        throw new MarkdownSessionError(
          'IO_ERROR',
          'The saved Markdown file could not be verified.',
          { reason: 'published-content-mismatch' },
        )
      }
      this.#baseline = published
      result = { savedRevision: request.revision }
    } catch (cause) {
      failure = cause
    }

    let cleanupFailure: unknown
    if (tempPath) {
      try {
        await unlink(tempPath)
      } catch (cause) {
        if (fileSystemErrorCode(cause) !== 'ENOENT') cleanupFailure = cause
      }
    }
    failure ??= cleanupFailure
    if (failure !== undefined) {
      const mapped = toSessionError(failure, 'save')
      if (committed) {
        this.#invalid = 'Markdown was saved, but its durable result could not be confirmed. Reopen it before retrying.'
        throw new MarkdownSessionError('SESSION_INVALID', this.#invalid, {
          committed: true,
          ...(typeof mapped.details.reason === 'string' ? { reason: mapped.details.reason } : {}),
        })
      }
      throw mapped
    }

    if (!result) {
      throw new MarkdownSessionError('IO_ERROR', 'Markdown could not be saved.')
    }
    return result
  }

  #validateRequest(request: SaveTreeRequest): void {
    if (!request || typeof request !== 'object' || request.sessionId !== this.id) {
      throw new MarkdownSessionError('INVALID_ARGUMENT', 'The save request belongs to another editor session.')
    }
    if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
      throw new MarkdownSessionError('INVALID_ARGUMENT', 'Editor revision must be a non-negative safe integer.')
    }
    if (typeof request.markdown !== 'string') {
      throw new MarkdownSessionError('INVALID_ARGUMENT', 'Markdown must be a string.')
    }
    if (Buffer.byteLength(request.markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw new MarkdownSessionError(
        'LIMIT_EXCEEDED',
        `Markdown exceeds the ${MAX_MARKDOWN_BYTES} byte desktop limit.`,
      )
    }
  }

  #run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action)
    this.#tail = result.catch(() => undefined)
    return result
  }
}

export function toMarkdownFailure(error: unknown): DesktopFailure | undefined {
  if (!(error instanceof MarkdownSessionError)) return undefined
  return {
    code: error.code,
    message: error.message,
    ...(typeof error.details.reason === 'string' ? { reason: error.details.reason } : {}),
    ...(typeof error.details.committed === 'boolean' ? { committed: error.details.committed } : {}),
  }
}

async function canonicalizeMarkdownPath(filePath: string): Promise<string> {
  try {
    const metadata = await lstat(filePath, { bigint: true })
    requireRegularFile(metadata)
    return await realpath(filePath)
  } catch (cause) {
    throw toSessionError(cause, 'open')
  }
}

async function readSnapshot(filePath: string): Promise<MarkdownSnapshot> {
  let handle: FileHandle
  try {
    handle = await open(filePath, 'r')
  } catch (cause) {
    throw toSessionError(cause, 'read')
  }

  try {
    const before = await handle.stat({ bigint: true })
    requireRegularFile(before)
    if (before.size > BigInt(MAX_MARKDOWN_BYTES)) throw markdownLimitError()

    const bytes = await readBounded(handle)
    const after = await handle.stat({ bigint: true })
    requireRegularFile(after)
    if (!sameIdentity(toIdentity(before), toIdentity(after))) {
      throw new MarkdownSessionError(
        'CONFLICT',
        'The Markdown file changed while it was being read.',
        { reason: 'target-changed-while-reading' },
      )
    }

    const pathMetadata = await lstat(filePath, { bigint: true })
    requireRegularFile(pathMetadata)
    if (!sameIdentity(toIdentity(after), toIdentity(pathMetadata))) {
      throw new MarkdownSessionError(
        'CONFLICT',
        'The Markdown file changed while it was being read.',
        { reason: 'target-identity-changed' },
      )
    }
    return Object.freeze({
      bytes,
      identity: toIdentity(after),
      ...contentBaseline(bytes),
    })
  } catch (cause) {
    throw toSessionError(cause, 'read')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_MARKDOWN_BYTES + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null)
    if (bytesRead === 0) break
    offset += bytesRead
    if (offset > MAX_MARKDOWN_BYTES) throw markdownLimitError()
  }
  return Buffer.from(buffer.subarray(0, offset))
}

async function writeSyncedTemp(tempPath: string, bytes: Buffer, mode: number): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(tempPath, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    throw toSessionError(cause, 'write')
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: FileHandle | undefined
  try {
    handle = await open(directoryPath, 'r')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    throw toSessionError(cause, 'sync')
  }
}

function assertExpectedBaseline(expected: MarkdownBaseline, actual: MarkdownBaseline): void {
  if (!sameContent(expected, actual)) {
    throw new MarkdownSessionError(
      'CONFLICT',
      'The Markdown file changed outside this editor.',
      { reason: 'content-changed' },
    )
  }
  if (!sameIdentity(expected.identity, actual.identity)) {
    throw new MarkdownSessionError(
      'CONFLICT',
      'The Markdown file was replaced outside this editor.',
      { reason: 'target-identity-changed' },
    )
  }
}

function contentBaseline(bytes: Uint8Array): Pick<MarkdownBaseline, 'contentBytes' | 'contentSha256'> {
  return {
    contentBytes: bytes.byteLength,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function sameContent(
  left: Pick<MarkdownBaseline, 'contentBytes' | 'contentSha256'>,
  right: Pick<MarkdownBaseline, 'contentBytes' | 'contentSha256'>,
): boolean {
  return left.contentBytes === right.contentBytes && left.contentSha256 === right.contentSha256
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds
}

function toIdentity(metadata: BigIntStats): FileIdentity {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedNanoseconds: metadata.mtimeNs,
    changedNanoseconds: metadata.ctimeNs,
    mode: Number(metadata.mode & 0o777n),
  })
}

function requireRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    const reason = metadata.isSymbolicLink()
      ? 'symlink-target'
      : metadata.isFile() && metadata.nlink !== 1n
        ? 'hard-linked-target'
        : 'non-regular-target'
    throw new MarkdownSessionError(
      'IO_ERROR',
      'The Markdown target must be one regular file without aliases.',
      { reason },
    )
  }
}

function decodeMarkdown(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MarkdownSessionError(
      'INVALID_ARGUMENT',
      'The Markdown file is not valid UTF-8.',
      { reason: 'invalid-utf8' },
    )
  }
}

function markdownLimitError(): MarkdownSessionError {
  return new MarkdownSessionError(
    'LIMIT_EXCEEDED',
    `Markdown exceeds the ${MAX_MARKDOWN_BYTES} byte desktop limit.`,
    { reason: 'markdown-too-large' },
  )
}

function uniqueTempPath(filePath: string): string {
  return join(
    dirname(filePath),
    `.mdv-markdown-${process.pid}-${randomBytes(12).toString('hex')}.tmp`,
  )
}

function toSessionError(cause: unknown, action: string): MarkdownSessionError {
  if (cause instanceof MarkdownSessionError) return cause
  const ioCode = fileSystemErrorCode(cause)
  if (ioCode === 'ENOENT' || ioCode === 'ENOTDIR') {
    return new MarkdownSessionError(
      'NOT_FOUND',
      'The Markdown file no longer exists.',
      { reason: `${action}-target-missing` },
    )
  }
  return new MarkdownSessionError(
    'IO_ERROR',
    'The Markdown file could not be read or written.',
    { reason: `${action}-failed` },
  )
}

function fileSystemErrorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined
  const code = (cause as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
