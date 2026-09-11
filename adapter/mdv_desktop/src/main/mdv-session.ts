import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  MdvError,
  openMdv,
  type DocumentId,
  type MdvDocument,
  type TreeKind,
  type VersionId,
} from '@owariband/mdv'
import type {
  DesktopFailure,
  DesktopTree,
  OpenedMdvView,
  SaveTreeRequest,
  SaveTreeResult,
} from '../shared/ipc.js'

const MAX_REBASE_ATTEMPTS = 8
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024
const referencePermitAuthority = Symbol('mdv-reference-write')

interface TreeBaseline {
  readonly documentId: DocumentId
  readonly generation: number
  readonly tree: TreeKind
  readonly head: VersionId | null
  readonly contentBytes: number
  readonly contentSha256: string
}

export class MdvSessionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'INVALID_ARGUMENT' | 'PERMISSION_DENIED' | 'SESSION_INVALID',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'MdvSessionError'
  }
}

export class ReferenceWritePermit {
  #consumed = false

  constructor(authority: symbol) {
    if (authority !== referencePermitAuthority) {
      throw new MdvSessionError('PERMISSION_DENIED', 'Reference writes require confirmation in the main process')
    }
  }

  consume(): void {
    if (this.#consumed) {
      throw new MdvSessionError('PERMISSION_DENIED', 'Reference write confirmation has already been used')
    }
    this.#consumed = true
  }
}

export function issueReferenceWritePermit(): ReferenceWritePermit {
  return new ReferenceWritePermit(referencePermitAuthority)
}

export class MdvSession {
  readonly id = randomUUID()
  readonly packagePath: string
  readonly documentId: DocumentId
  readonly #baselines: Record<TreeKind, TreeBaseline>
  #tail: Promise<unknown> = Promise.resolve()
  #invalid: string | undefined

  private constructor(document: MdvDocument, baselines: Record<TreeKind, TreeBaseline>) {
    this.packagePath = document.packagePath
    this.documentId = document.manifest.documentId
    this.#baselines = baselines
  }

  static async open(packagePath: string): Promise<{ session: MdvSession; view: OpenedMdvView }> {
    const document = await openMdv(packagePath)
    const [reference, actual, status] = await Promise.all([
      document.readReference(),
      document.readDocument(),
      document.getStatus(),
    ])
    const baselines = {
      reference: baseline(document, 'reference', reference.bytes),
      document: baseline(document, 'document', actual.bytes),
    }
    const session = new MdvSession(document, baselines)
    return {
      session,
      view: {
        kind: 'mdv',
        sessionId: session.id,
        displayName: basename(document.packagePath),
        documentId: document.manifest.documentId,
        generation: document.manifest.generation,
        markdownProfile: document.manifest.markdownProfile,
        reference: {
          markdown: decodeMarkdown(reference.bytes, 'Reference'),
          head: document.referenceTree.head,
          workingCopyDirty: status.reference.dirty,
        },
        document: {
          markdown: decodeMarkdown(actual.bytes, 'Document'),
          head: document.documentTree.head,
          workingCopyDirty: status.document.dirty,
        },
        versions: {
          reference: document.listVersions({ tree: 'reference' }),
          document: document.listVersions({ tree: 'document' }),
        },
        referenceRelation: status.referenceRelation,
      },
    }
  }

  saveDocument(request: SaveTreeRequest): Promise<SaveTreeResult> {
    return this.#save('document', request)
  }

  saveReference(request: SaveTreeRequest, permit: ReferenceWritePermit): Promise<SaveTreeResult> {
    if (!(permit instanceof ReferenceWritePermit)) {
      throw new MdvSessionError('PERMISSION_DENIED', 'Reference writes require confirmation in the main process')
    }
    permit.consume()
    return this.#save('reference', request)
  }

  #save(tree: TreeKind, request: SaveTreeRequest): Promise<SaveTreeResult> {
    return this.#run(async () => {
      this.#validateRequest(request)
      if (this.#invalid) throw new MdvSessionError('SESSION_INVALID', this.#invalid)

      const expected = this.#baselines[tree]
      let lastTransactionConflict: MdvError | undefined
      for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt += 1) {
        const current = await this.#openExpected()
        const actual = await workingBaseline(current, tree)
        assertCurrentBaseline(expected, actual)

        let next: MdvDocument
        try {
          next = tree === 'reference'
            ? await current.saveReference({ markdown: request.markdown, expectedGeneration: current.manifest.generation })
            : await current.saveDocument({ markdown: request.markdown, expectedGeneration: current.manifest.generation })
        } catch (error) {
          if (isRetryableTransactionConflict(error)) {
            lastTransactionConflict = error
            if (error.details.reason === 'locked') {
              await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
            }
            continue
          }
          if (error instanceof MdvError && error.details.committed === true) {
            this.#invalid = 'The write may already be saved. Reopen the document and inspect disk state before retrying.'
          }
          throw error
        }

        try {
          const nextBaseline = await workingBaseline(next, tree)
          const otherTree: TreeKind = tree === 'reference' ? 'document' : 'reference'
          const otherBaseline = await workingBaseline(next, otherTree)
          const status = await next.getStatus()
          this.#baselines[tree] = nextBaseline
          return {
            tree,
            generation: next.manifest.generation,
            head: nextBaseline.head,
            savedRevision: request.revision,
            workingCopyDirty: status[tree].dirty,
            staleTrees: sameTreeState(this.#baselines[otherTree], otherBaseline) ? [] : [otherTree],
          }
        } catch (cause) {
          this.#invalid = 'The write completed, but its new baseline could not be read. Reopen the document before retrying.'
          throw new MdvSessionError('SESSION_INVALID', this.#invalid, {
            committed: true,
            tree,
            cause: cause instanceof Error ? cause.name : typeof cause,
          })
        }
      }

      throw lastTransactionConflict ?? new MdvSessionError(
        'CONFLICT',
        'The MDV document changed repeatedly while saving; reopen it before retrying.',
        { tree },
      )
    })
  }

  #validateRequest(request: SaveTreeRequest): void {
    if (request.sessionId !== this.id) {
      throw new MdvSessionError('INVALID_ARGUMENT', 'The save request belongs to another editor session')
    }
    if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
      throw new MdvSessionError('INVALID_ARGUMENT', 'Editor revision must be a non-negative safe integer')
    }
    if (typeof request.markdown !== 'string') {
      throw new MdvSessionError('INVALID_ARGUMENT', 'Markdown must be a string')
    }
    const bytes = Buffer.byteLength(request.markdown, 'utf8')
    if (bytes > MAX_MARKDOWN_BYTES) {
      throw new MdvSessionError('INVALID_ARGUMENT', `Markdown exceeds the ${MAX_MARKDOWN_BYTES} byte desktop limit`)
    }
  }

  async #openExpected(): Promise<MdvDocument> {
    const document = await openMdv(this.packagePath)
    if (document.manifest.documentId !== this.documentId) {
      this.#invalid = 'The .mdv path now contains a different document. Reopen it before saving.'
      throw new MdvSessionError('CONFLICT', this.#invalid, {
        reason: 'document-changed',
      })
    }
    return document
  }

  #run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action)
    this.#tail = result.catch(() => undefined)
    return result
  }
}

export function toDesktopFailure(error: unknown): DesktopFailure {
  if (error instanceof MdvSessionError) {
    return {
      code: error.code,
      message: error.message,
      ...pickPublicDetails(error.details),
    }
  }
  if (error instanceof MdvError) {
    return {
      code: error.code,
      message: publicMdvMessage(error.code),
      ...pickPublicDetails(error.details),
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'MDV Desktop could not complete the operation.',
  }
}

function publicMdvMessage(code: MdvError['code']): string {
  switch (code) {
    case 'NOT_MDV':
      return 'The selected file is not an MDV document.'
    case 'UNSUPPORTED_FORMAT':
      return 'This MDV format version is not supported.'
    case 'INVALID_ARCHIVE':
    case 'INVALID_MANIFEST':
    case 'INVALID_TREE':
    case 'INVALID_VERSION':
    case 'INVALID_GRAPH':
    case 'INVALID_UTF8':
    case 'INVALID_RESOURCE':
      return 'The MDV document is invalid and could not be opened.'
    case 'INTEGRITY_MISMATCH':
      return 'The MDV document failed its integrity check.'
    case 'NOT_FOUND':
      return 'The requested MDV content no longer exists.'
    case 'LIMIT_EXCEEDED':
      return 'The MDV document exceeds a configured safety limit.'
    case 'CONFLICT':
      return 'The MDV document changed outside this editor. Reopen it before retrying.'
    case 'IO_ERROR':
      return 'The MDV document could not be read or written.'
  }
}

function baseline(document: MdvDocument, tree: TreeKind, bytes: Uint8Array): TreeBaseline {
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    tree,
    head: tree === 'reference' ? document.referenceTree.head : document.documentTree.head,
    contentBytes: bytes.byteLength,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function workingBaseline(document: MdvDocument, tree: TreeKind): Promise<TreeBaseline> {
  const source = tree === 'reference' ? await document.readReference() : await document.readDocument()
  return baseline(document, tree, source.bytes)
}

function assertCurrentBaseline(expected: TreeBaseline, actual: TreeBaseline): void {
  if (actual.generation < expected.generation) {
    throw new MdvSessionError('CONFLICT', 'MDV generation moved backwards; reopen before saving.', {
      reason: 'generation-regressed',
      tree: expected.tree,
    })
  }
  if (!sameContent(expected, actual)) {
    throw new MdvSessionError('CONFLICT', `The MDV ${expected.tree} working copy changed outside this editor.`, {
      reason: 'working-copy-changed',
      tree: expected.tree,
    })
  }
}

function sameContent(left: TreeBaseline, right: TreeBaseline): boolean {
  return left.contentBytes === right.contentBytes && left.contentSha256 === right.contentSha256
}

function sameTreeState(left: TreeBaseline, right: TreeBaseline): boolean {
  return sameContent(left, right) && left.head === right.head
}

function decodeMarkdown(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new MdvSessionError('INVALID_ARGUMENT', `${label} is not valid UTF-8`, {
      cause: cause instanceof Error ? cause.name : typeof cause,
    })
  }
}

function isRetryableTransactionConflict(error: unknown): error is MdvError {
  return error instanceof MdvError
    && error.code === 'CONFLICT'
    && error.details.committed !== true
    && (error.details.reason === 'locked'
      || (Number.isSafeInteger(error.details.expectedGeneration)
        && Number.isSafeInteger(error.details.actualGeneration)))
}

function pickPublicDetails(details: Readonly<Record<string, unknown>>): Partial<DesktopFailure> {
  const result: {
    reason?: string
    tree?: DesktopTree
    committed?: boolean
  } = {}
  if (typeof details.reason === 'string') result.reason = details.reason
  if (details.tree === 'reference' || details.tree === 'document') result.tree = details.tree
  if (typeof details.committed === 'boolean') result.committed = details.committed
  return result
}
