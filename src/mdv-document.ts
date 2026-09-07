import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import { ArchiveError } from './archive/errors.js'
import type {
  ActorFileDto,
  DocumentVersionMetaFileDto,
  ManifestFileDto,
  VersionMetaFileDto,
} from './archive/format-dto.js'
import { canonicalizeTargetPath } from './archive/lock.js'
import { resolveReadLimits } from './archive/limits.js'
import {
  openArchiveFromBytes,
  openArchiveFromPath,
  validateMarkdownBytes,
} from './archive/reader.js'
import type { OpenedArchive } from './archive/reader.js'
import { compareRfc3339 } from './archive/rfc3339.js'
import { runArchiveTransaction } from './archive/transaction.js'
import type { ArchiveDiagnostic } from './archive/verify.js'
import {
  verifyArchiveMetadataFromBytes,
  verifyArchiveMetadataFromPath,
  verifyArchiveVersionContents,
} from './archive/verify.js'
import {
  planCheckout,
  planDocumentCommit,
  planReferenceCommit,
  VersionIdCollisionError,
  VersionSelectionError,
  WorkingCopyDirtyError,
} from './core/commands.js'
import type {
  AppendDocumentCommitPlan,
  AppendReferenceCommitPlan,
  DocumentCommitPlan,
  ReferenceCommitPlan,
} from './core/commands.js'
import { hydrateArchiveIndex } from './core/hydrate.js'
import { diffLines, DiffLimitExceededError } from './core/diff.js'
import { brandVersionId } from './core/ids.js'
import type { VersionId as CoreVersionId } from './core/ids.js'
import { GraphValidationError } from './core/invariants.js'
import type {
  DocumentVersion as CoreDocumentVersion,
  MdvState,
  ReferenceVersion as CoreReferenceVersion,
} from './core/model.js'
import {
  getChildren as getCoreChildren,
  getDocumentReference as getCoreDocumentReference,
  getHistory as getCoreHistory,
  listDocumentsUsingReference as listCoreDocumentsUsingReference,
} from './core/queries.js'
import { computeDocumentStatus } from './core/status.js'
import { MdvError } from './errors.js'
import type {
  Actor,
  CheckoutInput,
  CommitDocumentInput,
  CommitInput,
  CommitResult,
  ContentSpec,
  CreateOptions,
  DiffHunk,
  DiffLine,
  DiffOptions,
  DiffResult,
  DocumentId,
  DocumentSnapshot,
  DocumentStatus,
  DocumentTrace,
  DocumentVersionSummary,
  MarkdownSource,
  MdvDocument,
  MdvWarning,
  OpenOptions,
  ParseOptions,
  ReferenceTrace,
  ReferenceVersionSummary,
  SaveInput,
  TreeKind,
  VersionId,
  VersionQuery,
  VersionSummary,
  VerifyIssue,
  VerifyMode,
  VerifyOptions,
  VerifyReport,
} from './types.js'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const MARKDOWN_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const VERSION_ID = /^v_[0-9a-f]{32}$/
const DEFAULT_MAX_VERIFY_ISSUES = 100

export async function parseMdv(
  bytes: Uint8Array,
  options: ParseOptions = {},
): Promise<DocumentSnapshot> {
  const readOptions = copyOpenOptions(options)
  const baseDirectory = options.baseDirectory === undefined
    ? null
    : resolve(options.baseDirectory)
  try {
    const archive = await openArchiveFromBytes(bytes, readOptions.limits === undefined
      ? {}
      : { limits: readOptions.limits })
    return createReadonlySnapshot(archive, baseDirectory)
  } catch (cause) {
    throw toMdvError(cause, 'Failed to parse MDV document')
  }
}

export async function openMdv(
  path: string,
  options: OpenOptions = {},
): Promise<MdvDocument> {
  const packagePath = resolve(path)
  const readOptions = copyOpenOptions(options)
  try {
    const targetPath = await canonicalizeTargetPath(packagePath)
    const archive = await openArchiveFromPath(targetPath, readOptions.limits === undefined
      ? {}
      : { limits: readOptions.limits })
    return createFileDocument(archive, packagePath, targetPath, readOptions)
  } catch (cause) {
    throw toMdvError(cause, `Failed to open MDV document ${packagePath}`)
  }
}

export async function createMdv(
  path: string,
  options: CreateOptions = {},
): Promise<MdvDocument> {
  const packagePath = resolve(path)
  const readOptions = copyOpenOptions(options)
  const markdownProfile = normalizeMarkdownProfile(options.markdownProfile)
  const manifest: ManifestFileDto = Object.freeze({
    format: 'mdv',
    formatVersion: '0.1',
    documentId: `d_${randomBytes(16).toString('hex')}`,
    generation: 0,
    markdownProfile,
  })
  let committedGeneration: number | undefined

  try {
    const result = await runArchiveTransaction(
      packagePath,
      { type: 'create', manifest },
      {
        ...(readOptions.limits === undefined ? {} : { limits: readOptions.limits }),
        validate: validateArchiveGraph,
      },
    )
    committedGeneration = result.archive.manifest.generation
    return createFileDocument(result.archive, packagePath, result.targetPath, readOptions)
  } catch (cause) {
    if (committedGeneration !== undefined) {
      throw committedResultError(cause, packagePath, committedGeneration)
    }
    throw toMdvError(cause, `Failed to create MDV document ${packagePath}`)
  }
}

export async function verifyMdv(
  source: string | Uint8Array,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const input = snapshotVerifyInput(source, options)
  let metadata
  try {
    metadata = input.sourceKind === 'path'
      ? await verifyArchiveMetadataFromPath(input.source, input.archiveOptions)
      : await verifyArchiveMetadataFromBytes(input.source, input.archiveOptions)
  } catch (cause) {
    throw toMdvError(cause, 'Failed to read MDV document for verification')
  }

  const issues: VerifyIssue[] = []
  let complete = metadata.complete
  if (!appendArchiveDiagnostics(issues, metadata.issues, input.maxIssues)) {
    complete = false
  }

  const archive = metadata.archive
  if (archive !== null) {
    try {
      try {
        hydrateOpenedArchive(archive)
      } catch (cause) {
        if (!(cause instanceof GraphValidationError)) {
          throw cause
        }
        const remaining = input.maxIssues - issues.length
        const selected = cause.issues.slice(0, remaining)
        issues.push(...selected.map((issue): VerifyIssue => Object.freeze({
          code: 'INVALID_GRAPH',
          message: `${issue.path} ${issue.message}`,
          path: issue.path,
          details: Object.freeze({}),
        })))
        if (selected.length < cause.issues.length) {
          complete = false
        }
      }

      if (input.mode === 'full') {
        const remaining = input.maxIssues - issues.length
        if (remaining === 0 && archive.versionEntries.length > 0) {
          complete = false
        } else {
          const content = await verifyArchiveVersionContents(archive, remaining)
          const appendedAll = appendArchiveDiagnostics(issues, content.issues, input.maxIssues)
          complete = complete && content.complete && appendedAll
        }
      }
    } catch (cause) {
      throw toMdvError(cause, 'Failed while verifying MDV document')
    } finally {
      try {
        await archive.close()
      } catch (cause) {
        throw toMdvError(cause, 'Failed to close MDV document after verification')
      }
    }
  }

  const warnings = Object.freeze(metadata.warnings.map((warning): MdvWarning => Object.freeze({
    code: warning.code,
    entry: warning.entry,
    path: warning.path,
    message: warning.message,
  })))
  return Object.freeze({
    mode: input.mode,
    valid: complete && issues.length === 0,
    complete,
    issues: Object.freeze(issues),
    warnings,
  })
}

function createReadonlySnapshot(
  archive: OpenedArchive,
  baseDirectory: string | null,
): DocumentSnapshot {
  return Object.freeze(new ReadonlyDocumentSnapshot(
    archive,
    hydrateOpenedArchive(archive),
    null,
    baseDirectory,
  ))
}

function createFileDocument(
  archive: OpenedArchive,
  packagePath: string,
  targetPath: string,
  options: OpenOptions,
): MdvDocument {
  return new FileMdvDocument(
    archive,
    hydrateOpenedArchive(archive),
    packagePath,
    dirname(packagePath),
    targetPath,
    copyOpenOptions(options),
  )
}

class ReadonlyDocumentSnapshot<TPath extends string | null> implements DocumentSnapshot {
  readonly manifest
  readonly packagePath: TPath
  readonly baseDirectory: TPath
  readonly referenceTree
  readonly documentTree
  readonly warnings

  readonly #archive: OpenedArchive
  readonly #state: MdvState
  readonly #referenceVersions: readonly ReferenceVersionSummary[]
  readonly #documentVersions: readonly DocumentVersionSummary[]
  readonly #allVersions: readonly VersionSummary[]
  readonly #referenceById: ReadonlyMap<CoreVersionId, ReferenceVersionSummary>
  readonly #documentById: ReadonlyMap<CoreVersionId, DocumentVersionSummary>

  constructor(
    archive: OpenedArchive,
    state: MdvState,
    packagePath: TPath,
    baseDirectory: TPath,
  ) {
    this.#archive = archive
    this.#state = state
    this.packagePath = packagePath
    this.baseDirectory = baseDirectory
    this.manifest = Object.freeze({
      format: state.manifest.format,
      formatVersion: state.manifest.formatVersion,
      documentId: state.manifest.documentId as DocumentId,
      generation: state.manifest.generation as number,
      markdownProfile: state.manifest.markdownProfile,
    })
    this.referenceTree = Object.freeze({
      head: toPublicVersionId(state.referenceHead),
    })
    this.documentTree = Object.freeze({
      head: toPublicVersionId(state.documentHead),
    })
    this.warnings = Object.freeze(archive.warnings.map((warning): MdvWarning => Object.freeze({
      code: warning.code,
      entry: warning.entry,
      path: warning.path,
      message: warning.message,
    })))

    const referenceById = new Map<CoreVersionId, ReferenceVersionSummary>()
    for (const version of state.references.values()) {
      referenceById.set(version.id, toReferenceSummary(version))
    }
    const documentById = new Map<CoreVersionId, DocumentVersionSummary>()
    for (const version of state.documents.values()) {
      documentById.set(version.id, toDocumentSummary(version))
    }
    this.#referenceById = referenceById
    this.#documentById = documentById
    this.#referenceVersions = sortVersions(referenceById.values())
    this.#documentVersions = sortVersions(documentById.values())
    this.#allVersions = sortVersions([
      ...this.#referenceVersions,
      ...this.#documentVersions,
    ])
  }

  listVersions(query: { readonly tree: 'reference' }): readonly ReferenceVersionSummary[]
  listVersions(query: { readonly tree: 'document' }): readonly DocumentVersionSummary[]
  listVersions(query?: VersionQuery): readonly VersionSummary[]
  listVersions(query: VersionQuery = {}): readonly VersionSummary[] {
    if (query.tree === 'reference') {
      return this.#referenceVersions
    }
    if (query.tree === 'document') {
      return this.#documentVersions
    }
    return this.#allVersions
  }

  getHistory(tree: 'reference', from?: VersionId): readonly ReferenceVersionSummary[]
  getHistory(tree: 'document', from?: VersionId): readonly DocumentVersionSummary[]
  getHistory(tree: TreeKind, from?: VersionId): readonly VersionSummary[]
  getHistory(tree: TreeKind, from?: VersionId): readonly VersionSummary[] {
    if (from !== undefined) {
      this.#requireVersion(tree, from)
    }
    const versions = getCoreHistory(
      this.#state,
      tree,
      from === undefined ? undefined : toCoreVersionId(from),
    )
    return Object.freeze(versions.map((version) => this.#getSummary(version.id)))
  }

  getChildren(tree: 'reference', version: VersionId): readonly ReferenceVersionSummary[]
  getChildren(tree: 'document', version: VersionId): readonly DocumentVersionSummary[]
  getChildren(tree: TreeKind, version: VersionId): readonly VersionSummary[]
  getChildren(tree: TreeKind, version: VersionId): readonly VersionSummary[] {
    const id = this.#requireVersion(tree, version)
    const children = getCoreChildren(this.#state, tree, id)
    return Object.freeze(children.map((child) => this.#getSummary(child.id)))
  }

  getDocumentReference(document: VersionId): VersionId | null {
    const id = this.#requireVersion('document', document)
    return toPublicVersionId(getCoreDocumentReference(this.#state, id)?.id ?? null)
  }

  listDocumentsUsingReference(reference: VersionId): readonly DocumentVersionSummary[] {
    const id = this.#requireVersion('reference', reference)
    return Object.freeze(listCoreDocumentsUsingReference(this.#state, id).map((document) => {
      const summary = this.#documentById.get(document.id)
      if (summary === undefined) {
        throw corruptSnapshot(`Document summary is missing for ${document.id}`)
      }
      return summary
    }))
  }

  traceDocument(document: VersionId): DocumentTrace {
    const id = this.#requireVersion('document', document)
    const summary = this.#documentById.get(id)
    if (summary === undefined) {
      throw corruptSnapshot(`Document summary is missing for ${document}`)
    }
    const ancestry = Object.freeze(getCoreHistory(this.#state, 'document', id).map((version) => {
      const ancestor = this.#documentById.get(version.id)
      if (ancestor === undefined) {
        throw corruptSnapshot(`Document summary is missing for ${version.id}`)
      }
      return ancestor
    }))
    const referenceVersion = getCoreDocumentReference(this.#state, id)
    const reference = referenceVersion === null
      ? null
      : this.#referenceById.get(referenceVersion.id)
    if (reference === undefined) {
      throw corruptSnapshot(`Reference summary is missing for ${referenceVersion?.id}`)
    }
    return Object.freeze({ document: summary, ancestry, reference })
  }

  traceReference(reference: VersionId): ReferenceTrace {
    const id = this.#requireVersion('reference', reference)
    const summary = this.#referenceById.get(id)
    if (summary === undefined) {
      throw corruptSnapshot(`Reference summary is missing for ${reference}`)
    }
    const ancestry = Object.freeze(getCoreHistory(this.#state, 'reference', id).map((version) => {
      const ancestor = this.#referenceById.get(version.id)
      if (ancestor === undefined) {
        throw corruptSnapshot(`Reference summary is missing for ${version.id}`)
      }
      return ancestor
    }))
    const usedByDocuments = this.listDocumentsUsingReference(reference)
    return Object.freeze({ reference: summary, ancestry, usedByDocuments })
  }

  async getStatus(): Promise<DocumentStatus> {
    let referenceWorkingCopy: Uint8Array
    let documentWorkingCopy: Uint8Array
    try {
      [referenceWorkingCopy, documentWorkingCopy] = await Promise.all([
        this.#archive.readWorkingCopy('reference'),
        this.#archive.readWorkingCopy('document'),
      ])
    } catch (cause) {
      throw toMdvError(cause, 'Failed to read MDV working-copy status')
    }

    return toPublicDocumentStatus(computeDocumentStatus(
      this.#state,
      referenceWorkingCopy,
      documentWorkingCopy,
    ))
  }

  async readContent(source: ContentSpec): Promise<MarkdownSource> {
    const selection = snapshotContentSpec(source, 'source')
    if (selection.kind === 'working-copy') {
      return this.#readWorkingCopy(selection.tree)
    }

    const id = this.#requireVersion(selection.tree, selection.version)
    try {
      const bytes = Uint8Array.from(await this.#archive.readVersionContent(
        selection.tree,
        selection.version,
      ))
      return Object.freeze({
        bytes,
        markdownProfile: this.manifest.markdownProfile,
        baseDirectory: this.baseDirectory,
        origin: Object.freeze({
          tree: selection.tree,
          kind: 'version' as const,
          version: toPublicVersionId(id),
        }),
      })
    } catch (cause) {
      throw toMdvError(cause, `Failed to read ${selection.tree} version ${selection.version}`)
    }
  }

  async diff(
    from: ContentSpec,
    to: ContentSpec,
    options: DiffOptions = {},
  ): Promise<DiffResult> {
    const fromSelection = snapshotContentSpec(from, 'from')
    const toSelection = snapshotContentSpec(to, 'to')
    const diffOptions = copyDiffOptions(options)
    const [oldSource, newSource] = await Promise.all([
      this.readContent(fromSelection),
      this.readContent(toSelection),
    ])
    const oldText = decodeUtf8(oldSource.bytes, { source: fromSelection })
    const newText = decodeUtf8(newSource.bytes, { source: toSelection })

    try {
      return toPublicDiffResult(diffLines(oldText, newText, {
        ...diffOptions,
        oldLabel: contentSpecLabel(fromSelection),
        newLabel: contentSpecLabel(toSelection),
      }))
    } catch (cause) {
      if (cause instanceof DiffLimitExceededError) {
        throw new MdvError('LIMIT_EXCEEDED', cause.message, {
          details: {
            reason: cause.reason,
            limit: cause.limit,
            maximum: cause.maximum,
            observed: cause.observed,
          },
          cause,
        })
      }
      throw cause
    }
  }

  async readReference(): Promise<MarkdownSource> {
    return this.#readWorkingCopy('reference')
  }

  async readDocument(): Promise<MarkdownSource> {
    return this.#readWorkingCopy('document')
  }

  async readReferenceText(): Promise<string> {
    const source = await this.readReference()
    return decodeUtf8(source.bytes, { tree: 'reference', kind: 'working-copy' })
  }

  async readDocumentText(): Promise<string> {
    const source = await this.readDocument()
    return decodeUtf8(source.bytes, { tree: 'document', kind: 'working-copy' })
  }

  async readVersionBytes(id: VersionId): Promise<Uint8Array> {
    const coreId = toCoreVersionId(id)
    const tree = this.#referenceById.has(coreId)
      ? 'reference'
      : this.#documentById.has(coreId)
        ? 'document'
        : null
    if (tree === null) {
      throw versionNotFound(id)
    }
    try {
      return Uint8Array.from(await this.#archive.readVersionContent(tree, id))
    } catch (cause) {
      throw toMdvError(cause, `Failed to read version ${id}`)
    }
  }

  async readVersionText(id: VersionId): Promise<string> {
    const bytes = await this.readVersionBytes(id)
    return decodeUtf8(bytes, { versionId: id })
  }

  async #readWorkingCopy(tree: TreeKind): Promise<MarkdownSource> {
    try {
      const bytes = Uint8Array.from(await this.#archive.readWorkingCopy(tree))
      return Object.freeze({
        bytes,
        markdownProfile: this.manifest.markdownProfile,
        baseDirectory: this.baseDirectory,
        origin: Object.freeze({
          tree,
          kind: 'working-copy' as const,
          version: null,
        }),
      })
    } catch (cause) {
      throw toMdvError(cause, `Failed to read ${tree} working copy`)
    }
  }

  #requireVersion(tree: TreeKind, version: VersionId): CoreVersionId {
    const id = toCoreVersionId(version)
    const ownVersions = tree === 'reference' ? this.#referenceById : this.#documentById
    if (!ownVersions.has(id)) {
      const otherVersions = tree === 'reference' ? this.#documentById : this.#referenceById
      throw versionNotFound(
        version,
        tree,
        otherVersions.has(id) ? 'wrong-tree' : 'missing',
      )
    }
    return id
  }

  #getSummary(id: CoreVersionId): VersionSummary {
    const summary = this.#referenceById.get(id) ?? this.#documentById.get(id)
    if (summary === undefined) {
      throw corruptSnapshot(`Version summary is missing for ${id}`)
    }
    return summary
  }
}

class FileMdvDocument extends ReadonlyDocumentSnapshot<string> implements MdvDocument {
  readonly #openOptions: OpenOptions
  readonly #targetPath: string

  constructor(
    archive: OpenedArchive,
    state: MdvState,
    packagePath: string,
    baseDirectory: string,
    targetPath: string,
    openOptions: OpenOptions,
  ) {
    super(archive, state, packagePath, baseDirectory)
    this.#openOptions = openOptions
    this.#targetPath = targetPath
    Object.freeze(this)
  }

  async saveReference(input: SaveInput): Promise<MdvDocument> {
    return saveWorkingCopy(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'reference',
      input,
      this.#openOptions,
    )
  }

  async saveDocument(input: SaveInput): Promise<MdvDocument> {
    return saveWorkingCopy(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'document',
      input,
      this.#openOptions,
    )
  }

  async commitReference(input: CommitInput): Promise<CommitResult> {
    return commitWorkingCopy(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'reference',
      input,
      this.#openOptions,
    )
  }

  async commitDocument(input: CommitDocumentInput): Promise<CommitResult> {
    return commitWorkingCopy(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'document',
      input,
      this.#openOptions,
    )
  }

  async checkoutReference(input: CheckoutInput): Promise<MdvDocument> {
    return checkoutVersion(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'reference',
      input,
      this.#openOptions,
    )
  }

  async checkoutDocument(input: CheckoutInput): Promise<MdvDocument> {
    return checkoutVersion(
      this.packagePath,
      this.#targetPath,
      this.manifest.documentId,
      'document',
      input,
      this.#openOptions,
    )
  }
}

async function saveWorkingCopy(
  packagePath: string,
  targetPath: string,
  expectedDocumentId: DocumentId,
  tree: TreeKind,
  input: SaveInput,
  options: OpenOptions,
): Promise<MdvDocument> {
  validateSaveInput(input)
  const expectedGeneration = input.expectedGeneration
  const maxEntryBytes = resolveReadLimits(options.limits).maxEntryBytes
  const markdownBytes = typeof input.markdown === 'string'
    ? Buffer.byteLength(input.markdown, 'utf8')
    : input.markdown.byteLength
  if (markdownBytes > maxEntryBytes) {
    throw new MdvError(
      'LIMIT_EXCEEDED',
      `Markdown content exceeds ${maxEntryBytes} bytes`,
      { details: { tree, actualBytes: markdownBytes, maxEntryBytes } },
    )
  }
  const markdown = typeof input.markdown === 'string'
    ? Buffer.from(input.markdown, 'utf8')
    : Uint8Array.from(input.markdown)
  try {
    validateMarkdownBytes(markdown, `${tree === 'reference' ? 'ref_tree' : 'doc_tree'}/current.md`)
  } catch (cause) {
    throw toMdvError(cause, `Invalid ${tree} Markdown`)
  }

  await requireBoundTarget(packagePath, targetPath)

  let committedGeneration: number | undefined
  try {
    const result = await runArchiveTransaction(
      targetPath,
      {
        type: 'save-working-copy',
        tree,
        markdown,
        expectedDocumentId,
        expectedGeneration,
      },
      {
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        validate: validateArchiveGraph,
      },
    )
    committedGeneration = result.archive.manifest.generation
    return createFileDocument(result.archive, packagePath, result.targetPath, options)
  } catch (cause) {
    if (committedGeneration !== undefined) {
      throw committedResultError(cause, packagePath, committedGeneration)
    }
    throw toMdvError(cause, `Failed to save ${tree} working copy`)
  }
}

type CommitTransactionValue =
  | { readonly created: true; readonly version: VersionId }
  | { readonly created: false }

async function commitWorkingCopy(
  packagePath: string,
  targetPath: string,
  expectedDocumentId: DocumentId,
  tree: TreeKind,
  input: CommitInput | CommitDocumentInput,
  options: OpenOptions,
): Promise<CommitResult> {
  validateCommitInput(input, tree)
  const commitInput = snapshotCommitInput(input, tree)
  await requireBoundTarget(packagePath, targetPath)

  let committedGeneration: number | undefined
  try {
    const result = await runArchiveTransaction<CommitTransactionValue>(
      targetPath,
      {
        type: 'planned-mutation',
        expectedDocumentId,
        expectedGeneration: commitInput.expectedGeneration,
        prepare: async (source) => {
          const state = hydrateOpenedArchive(source)
          const workingCopy = await source.readWorkingCopy(tree)
          const createdAt = new Date().toISOString()
          let plan: ReferenceCommitPlan | DocumentCommitPlan | undefined

          for (let attempt = 0; attempt < 8; attempt += 1) {
            const versionId = brandVersionId(`v_${randomBytes(16).toString('hex')}`)
            try {
              plan = tree === 'reference'
                ? planReferenceCommit({
                    state,
                    workingCopy,
                    actor: commitInput.actor,
                    summary: commitInput.summary,
                    versionId,
                    createdAt,
                  })
                : planDocumentCommit({
                    state,
                    workingCopy,
                    actor: commitInput.actor,
                    summary: commitInput.summary,
                    versionId,
                    createdAt,
                    referenceVersion: toNullableCoreVersionId(
                      commitInput.referenceVersion,
                    ),
                  })
              break
            } catch (cause) {
              if (cause instanceof VersionIdCollisionError) {
                continue
              }
              throw mapCommandError(cause)
            }
          }

          if (plan === undefined) {
            throw new ArchiveError('CONFLICT', 'Could not allocate a unique Version ID', {
              details: { reason: 'version-id-collision' },
            })
          }
          if (plan.kind === 'no-changes') {
            return Object.freeze({
              mutation: Object.freeze({ type: 'preserve-state' as const }),
              value: Object.freeze({ created: false as const }),
            })
          }

          return plan.tree === 'reference'
            ? preparedReferenceCommit(plan)
            : preparedDocumentCommit(plan)
        },
      },
      {
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        validate: validateArchiveGraph,
      },
    )
    committedGeneration = result.archive.manifest.generation
    const document = createFileDocument(result.archive, packagePath, result.targetPath, options)
    return result.value.created
      ? Object.freeze({
          created: true,
          version: result.value.version,
          document,
        })
      : Object.freeze({
          created: false,
          reason: 'no-changes',
          document,
        })
  } catch (cause) {
    if (committedGeneration !== undefined) {
      throw committedResultError(cause, packagePath, committedGeneration)
    }
    throw toMdvError(cause, `Failed to commit ${tree} working copy`)
  }
}

async function checkoutVersion(
  packagePath: string,
  targetPath: string,
  expectedDocumentId: DocumentId,
  tree: TreeKind,
  input: CheckoutInput,
  options: OpenOptions,
): Promise<MdvDocument> {
  validateCheckoutInput(input)
  const checkoutInput = snapshotCheckoutInput(input)
  await requireBoundTarget(packagePath, targetPath)

  let committedGeneration: number | undefined
  try {
    const result = await runArchiveTransaction(
      targetPath,
      {
        type: 'planned-mutation',
        expectedDocumentId,
        expectedGeneration: checkoutInput.expectedGeneration,
        prepare: async (source) => {
          let plan
          try {
            plan = planCheckout({
              state: hydrateOpenedArchive(source),
              tree,
              version: toCoreVersionId(checkoutInput.version),
              workingCopy: await source.readWorkingCopy(tree),
              ...(checkoutInput.discardChanges === undefined
                ? {}
                : { discardChanges: checkoutInput.discardChanges }),
            })
          } catch (cause) {
            throw mapCommandError(cause)
          }
          return Object.freeze({
            mutation: Object.freeze({
              type: 'checkout' as const,
              tree: plan.tree,
              versionId: plan.version,
            }),
            value: plan.discardedChanges,
          })
        },
      },
      {
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        validate: validateArchiveGraph,
      },
    )
    committedGeneration = result.archive.manifest.generation
    return createFileDocument(result.archive, packagePath, result.targetPath, options)
  } catch (cause) {
    if (committedGeneration !== undefined) {
      throw committedResultError(cause, packagePath, committedGeneration)
    }
    throw toMdvError(mapCommandError(cause), `Failed to checkout ${tree} version`)
  }
}

function preparedReferenceCommit(plan: AppendReferenceCommitPlan): {
  readonly mutation: {
    readonly type: 'append-reference-version'
    readonly metadata: VersionMetaFileDto
    readonly content: Uint8Array
  }
  readonly value: CommitTransactionValue
} {
  return Object.freeze({
    mutation: Object.freeze({
      type: 'append-reference-version' as const,
      metadata: toReferenceVersionMetadata(plan),
      content: plan.content,
    }),
    value: Object.freeze({ created: true as const, version: plan.version.id as VersionId }),
  })
}

function preparedDocumentCommit(plan: AppendDocumentCommitPlan): {
  readonly mutation: {
    readonly type: 'append-document-version'
    readonly metadata: DocumentVersionMetaFileDto
    readonly content: Uint8Array
  }
  readonly value: CommitTransactionValue
} {
  return Object.freeze({
    mutation: Object.freeze({
      type: 'append-document-version' as const,
      metadata: toDocumentVersionMetadata(plan),
      content: plan.content,
    }),
    value: Object.freeze({ created: true as const, version: plan.version.id as VersionId }),
  })
}

function toReferenceVersionMetadata(plan: AppendReferenceCommitPlan): VersionMetaFileDto {
  return toVersionMetadata(plan.version)
}

function toVersionMetadata(
  version: CoreReferenceVersion | CoreDocumentVersion,
): VersionMetaFileDto {
  return Object.freeze({
    schemaVersion: 1,
    id: version.id,
    parent: version.parent,
    createdAt: version.createdAt,
    actor: toActorFileDto(version.actor),
    summary: version.summary,
    contentSha256: version.contentSha256,
    contentBytes: version.contentBytes,
  })
}

function toDocumentVersionMetadata(plan: AppendDocumentCommitPlan): DocumentVersionMetaFileDto {
  return Object.freeze({
    ...toVersionMetadata(plan.version),
    referenceVersion: plan.version.referenceVersion,
  })
}

function toActorFileDto(actor: Actor): ActorFileDto {
  return Object.freeze({
    type: actor.type,
    ...(actor.id === undefined ? {} : { id: actor.id }),
    ...(actor.name === undefined ? {} : { name: actor.name }),
  })
}

async function requireBoundTarget(packagePath: string, targetPath: string): Promise<void> {
  let currentTargetPath: string
  try {
    currentTargetPath = await canonicalizeTargetPath(packagePath)
  } catch (cause) {
    throw toMdvError(cause, `Failed to resolve MDV document ${packagePath}`)
  }
  if (currentTargetPath !== targetPath) {
    throw new MdvError('CONFLICT', `MDV path now resolves to a different target: ${packagePath}`, {
      details: {
        reason: 'target-path-changed',
        expectedTargetPath: targetPath,
        actualTargetPath: currentTargetPath,
      },
    })
  }
}

function hydrateOpenedArchive(archive: OpenedArchive): MdvState {
  return hydrateArchiveIndex({
    manifest: archive.manifest,
    referenceHead: archive.referenceHead,
    documentHead: archive.documentHead,
    referenceVersions: archive.referenceVersions,
    documentVersions: archive.documentVersions,
  })
}

function validateArchiveGraph(archive: OpenedArchive): void {
  hydrateOpenedArchive(archive)
}

function copyOpenOptions(options: OpenOptions): OpenOptions {
  return Object.freeze(options.limits === undefined
    ? {}
    : { limits: Object.freeze({ ...options.limits }) })
}

type VerifyInput =
  | {
      readonly sourceKind: 'path'
      readonly source: string
      readonly mode: VerifyMode
      readonly maxIssues: number
      readonly archiveOptions: OpenOptions
    }
  | {
      readonly sourceKind: 'bytes'
      readonly source: Uint8Array
      readonly mode: VerifyMode
      readonly maxIssues: number
      readonly archiveOptions: OpenOptions
    }

function snapshotVerifyInput(
  source: string | Uint8Array,
  options: VerifyOptions,
): VerifyInput {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Verify options must be an object')
  }
  const requestedMode = options.mode
  const requestedMaxIssues = options.maxIssues
  const requestedLimits = options.limits
  const mode = requestedMode ?? 'metadata'
  if (mode !== 'metadata' && mode !== 'full') {
    throw new TypeError('mode must equal "metadata" or "full"')
  }
  const maxIssues = requestedMaxIssues ?? DEFAULT_MAX_VERIFY_ISSUES
  if (!Number.isSafeInteger(maxIssues) || maxIssues <= 0) {
    throw new RangeError('maxIssues must be a positive safe integer')
  }
  if (
    requestedLimits !== undefined
    && (requestedLimits === null
      || typeof requestedLimits !== 'object'
      || Array.isArray(requestedLimits))
  ) {
    throw new TypeError('Verify read limits must be an object')
  }
  if (requestedLimits !== undefined) {
    resolveReadLimits(requestedLimits)
  }
  const archiveOptions = Object.freeze(requestedLimits === undefined
    ? {}
    : { limits: Object.freeze({ ...requestedLimits }) })

  if (typeof source === 'string') {
    return Object.freeze({ sourceKind: 'path', source, mode, maxIssues, archiveOptions })
  }
  if (source instanceof Uint8Array) {
    return Object.freeze({
      sourceKind: 'bytes',
      source: Uint8Array.from(source),
      mode,
      maxIssues,
      archiveOptions,
    })
  }
  throw new TypeError('source must be a file path or Uint8Array')
}

function appendArchiveDiagnostics(
  target: VerifyIssue[],
  diagnostics: readonly ArchiveDiagnostic[],
  maxIssues: number,
): boolean {
  for (const diagnostic of diagnostics) {
    const nestedIssues = readNestedDiagnosticIssues(diagnostic.details)
    if (nestedIssues.length === 0) {
      if (target.length >= maxIssues) {
        return false
      }
      target.push(toVerifyIssue(diagnostic))
      continue
    }
    for (const nested of nestedIssues) {
      if (target.length >= maxIssues) {
        return false
      }
      target.push(toVerifyIssue(diagnostic, nested))
    }
  }
  return true
}

function toVerifyIssue(
  diagnostic: ArchiveDiagnostic,
  nested?: { readonly path: string; readonly message: string },
): VerifyIssue {
  return Object.freeze({
    code: diagnostic.code,
    message: nested?.message ?? diagnostic.message,
    ...(diagnostic.entry === undefined ? {} : { entry: diagnostic.entry }),
    ...(nested === undefined ? {} : { path: nested.path }),
    details: freezeDetails(diagnostic.details),
  })
}

function readNestedDiagnosticIssues(
  details: Readonly<Record<string, unknown>>,
): readonly { readonly path: string; readonly message: string }[] {
  if (!Array.isArray(details.issues)) {
    return Object.freeze([])
  }
  const issues: { readonly path: string; readonly message: string }[] = []
  for (const candidate of details.issues) {
    if (
      candidate === null
      || typeof candidate !== 'object'
      || typeof (candidate as { readonly path?: unknown }).path !== 'string'
      || typeof (candidate as { readonly message?: unknown }).message !== 'string'
    ) {
      return Object.freeze([])
    }
    const issue = candidate as { readonly path: string; readonly message: string }
    issues.push(Object.freeze({ path: issue.path, message: issue.message }))
  }
  return Object.freeze(issues)
}

function freezeDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(details).map(([name, value]) => [name, freezeDetailValue(value)]),
  ))
}

function freezeDetailValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeDetailValue))
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) {
      return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([name, nested]) => [name, freezeDetailValue(nested)]),
      ))
    }
  }
  return value
}

function snapshotContentSpec(source: ContentSpec, name: string): ContentSpec {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${name} must be a ContentSpec object`)
  }
  const tree = source.tree
  const kind = source.kind
  if (tree !== 'reference' && tree !== 'document') {
    throw new TypeError(`${name}.tree must equal "reference" or "document"`)
  }
  if (kind === 'working-copy') {
    return Object.freeze({ tree, kind: 'working-copy' })
  }
  if (kind !== 'version') {
    throw new TypeError(`${name}.kind must equal "working-copy" or "version"`)
  }
  const version = source.version
  if (!isVersionId(version)) {
    throw new TypeError(`${name}.version must be a valid Version ID`)
  }
  return Object.freeze({
    tree,
    kind: 'version',
    version,
  })
}

function copyDiffOptions(options: DiffOptions): DiffOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Diff options must be an object')
  }
  const contextLines = options.contextLines
  const limits = options.limits
  if (
    limits !== undefined
    && (limits === null
      || typeof limits !== 'object'
      || Array.isArray(limits))
  ) {
    throw new TypeError('Diff limits must be an object')
  }
  if (contextLines !== undefined) {
    validateNonNegativeSafeInteger(contextLines, 'contextLines')
  }
  if (limits !== undefined) {
    for (const name of [
      'maxInputBytes',
      'maxInputLines',
      'maxEditLength',
      'maxHunks',
      'maxOutputBytes',
    ] as const) {
      const value = limits[name]
      if (value !== undefined) {
        validateNonNegativeSafeInteger(value, `limits.${name}`)
      }
    }
  }
  return Object.freeze({
    ...(contextLines === undefined ? {} : { contextLines }),
    ...(limits === undefined
      ? {}
      : { limits: Object.freeze({ ...limits }) }),
  })
}

function validateNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

function contentSpecLabel(source: ContentSpec): string {
  return source.kind === 'working-copy'
    ? `${source.tree}:working-copy`
    : `${source.tree}:${source.version}`
}

function toPublicDocumentStatus(
  status: ReturnType<typeof computeDocumentStatus>,
): DocumentStatus {
  const referenceRelation = status.referenceRelation.kind === 'no-document-head'
    ? Object.freeze({ kind: 'no-document-head' as const })
    : status.referenceRelation.kind === 'unbound'
      ? Object.freeze({ kind: 'unbound' as const })
      : status.referenceRelation.kind === 'aligned'
        ? Object.freeze({
            kind: 'aligned' as const,
            referenceVersion: status.referenceRelation.referenceVersion as VersionId,
          })
        : Object.freeze({
            kind: 'drifted' as const,
            boundReference: status.referenceRelation.boundReference as VersionId,
            currentReference: toPublicVersionId(status.referenceRelation.currentReference),
          })

  return Object.freeze({
    reference: Object.freeze({
      head: toPublicVersionId(status.reference.head),
      dirty: status.reference.dirty,
    }),
    document: Object.freeze({
      head: toPublicVersionId(status.document.head),
      dirty: status.document.dirty,
    }),
    referenceRelation,
  })
}

function toPublicDiffResult(result: ReturnType<typeof diffLines>): DiffResult {
  const hunks = result.hunks.map((hunk): DiffHunk => Object.freeze({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: Object.freeze(hunk.lines.map((line): DiffLine => {
      if (line.kind === 'context') {
        return Object.freeze({
          kind: 'context',
          oldLine: line.oldLine,
          newLine: line.newLine,
          text: line.text,
        })
      }
      if (line.kind === 'deletion') {
        return Object.freeze({
          kind: 'deletion',
          oldLine: line.oldLine,
          newLine: null,
          text: line.text,
        })
      }
      return Object.freeze({
        kind: 'addition',
        oldLine: null,
        newLine: line.newLine,
        text: line.text,
      })
    })),
  }))
  return Object.freeze({ hunks: Object.freeze(hunks), unifiedText: result.unifiedText })
}

function normalizeMarkdownProfile(value: string | undefined): string {
  if (value === undefined) {
    return 'gfm'
  }
  if (typeof value !== 'string' || !MARKDOWN_PROFILE.test(value)) {
    throw new TypeError('markdownProfile must be a lowercase profile token up to 64 characters')
  }
  return value
}

function validateSaveInput(input: SaveInput): void {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Save input must be an object')
  }
  validateExpectedGeneration(input.expectedGeneration)
  if (typeof input.markdown !== 'string' && !(input.markdown instanceof Uint8Array)) {
    throw new TypeError('markdown must be a string or Uint8Array')
  }
}

function validateCommitInput(
  input: CommitInput | CommitDocumentInput,
  tree: TreeKind,
): void {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Commit input must be an object')
  }
  validateExpectedGeneration(input.expectedGeneration)
  validateActor(input.actor)
  if (
    typeof input.summary !== 'string'
    || input.summary.trim().length === 0
    || input.summary.length > 4096
  ) {
    throw new TypeError('summary must be a non-blank string up to 4096 characters')
  }
  if (tree === 'document') {
    const referenceVersion = (input as CommitDocumentInput).referenceVersion
    if (referenceVersion !== null && !isVersionId(referenceVersion)) {
      throw new TypeError('referenceVersion must be a valid Version ID or null')
    }
  }
}

interface CommitInputSnapshot {
  readonly expectedGeneration: number
  readonly actor: Actor
  readonly summary: string
  readonly referenceVersion: VersionId | null
}

function snapshotCommitInput(
  input: CommitInput | CommitDocumentInput,
  tree: TreeKind,
): CommitInputSnapshot {
  return Object.freeze({
    expectedGeneration: input.expectedGeneration,
    actor: Object.freeze({
      type: input.actor.type,
      ...(input.actor.id === undefined ? {} : { id: input.actor.id }),
      ...(input.actor.name === undefined ? {} : { name: input.actor.name }),
    }),
    summary: input.summary,
    referenceVersion: tree === 'document'
      ? (input as CommitDocumentInput).referenceVersion
      : null,
  })
}

function validateCheckoutInput(input: CheckoutInput): void {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Checkout input must be an object')
  }
  validateExpectedGeneration(input.expectedGeneration)
  if (!isVersionId(input.version)) {
    throw new TypeError('version must be a valid Version ID')
  }
  if (input.discardChanges !== undefined && typeof input.discardChanges !== 'boolean') {
    throw new TypeError('discardChanges must be a boolean when provided')
  }
}

function snapshotCheckoutInput(input: CheckoutInput): CheckoutInput {
  return Object.freeze({
    version: input.version,
    expectedGeneration: input.expectedGeneration,
    ...(input.discardChanges === undefined ? {} : { discardChanges: input.discardChanges }),
  })
}

function validateExpectedGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('expectedGeneration must be a non-negative safe integer')
  }
}

function validateActor(actor: Actor): void {
  if (actor === null || typeof actor !== 'object') {
    throw new TypeError('actor must be an object')
  }
  if (actor.type !== 'human' && actor.type !== 'agent') {
    throw new TypeError('actor.type must equal "human" or "agent"')
  }
  for (const [name, value] of [['id', actor.id], ['name', actor.name]] as const) {
    if (
      value !== undefined
      && (typeof value !== 'string' || value.length === 0 || value.length > 256)
    ) {
      throw new TypeError(`actor.${name} must be a non-empty string up to 256 characters`)
    }
  }
}

function isVersionId(value: unknown): value is VersionId {
  return typeof value === 'string' && VERSION_ID.test(value)
}

function mapCommandError(cause: unknown): unknown {
  if (cause instanceof VersionSelectionError) {
    return new ArchiveError('NOT_FOUND', cause.message, {
      details: {
        reason: cause.reason,
        tree: cause.tree,
        versionId: cause.version,
      },
      cause,
    })
  }
  if (cause instanceof WorkingCopyDirtyError) {
    return new ArchiveError('CONFLICT', cause.message, {
      details: { reason: cause.reason, tree: cause.tree },
      cause,
    })
  }
  if (cause instanceof VersionIdCollisionError) {
    return new ArchiveError('CONFLICT', cause.message, {
      details: { reason: cause.reason, versionId: cause.version },
      cause,
    })
  }
  return cause
}

function committedResultError(
  cause: unknown,
  packagePath: string,
  generation: number,
): MdvError {
  const mapped = toMdvError(cause, `Failed to build committed MDV document ${packagePath}`)
  return new MdvError(mapped.code, mapped.message, {
    details: {
      ...mapped.details,
      path: packagePath,
      stage: 'build-result',
      committed: true,
      generation,
    },
    cause: mapped,
  })
}

function toReferenceSummary(version: CoreReferenceVersion): ReferenceVersionSummary {
  return Object.freeze({
    tree: 'reference',
    id: version.id as VersionId,
    parent: toPublicVersionId(version.parent),
    createdAt: version.createdAt,
    actor: toPublicActor(version.actor),
    summary: version.summary,
  })
}

function toDocumentSummary(version: CoreDocumentVersion): DocumentVersionSummary {
  return Object.freeze({
    tree: 'document',
    id: version.id as VersionId,
    parent: toPublicVersionId(version.parent),
    createdAt: version.createdAt,
    actor: toPublicActor(version.actor),
    summary: version.summary,
    referenceVersion: toPublicVersionId(version.referenceVersion),
  })
}

function toPublicActor(actor: Actor): Actor {
  return Object.freeze({
    type: actor.type,
    ...(actor.id === undefined ? {} : { id: actor.id }),
    ...(actor.name === undefined ? {} : { name: actor.name }),
  })
}

function sortVersions<T extends VersionSummary>(versions: Iterable<T>): readonly T[] {
  return Object.freeze([...versions].sort((left, right) => (
    compareRfc3339(left.createdAt, right.createdAt) || left.id.localeCompare(right.id)
  )))
}

function toCoreVersionId(id: VersionId): CoreVersionId {
  return id as unknown as CoreVersionId
}

function toNullableCoreVersionId(id: VersionId | null): CoreVersionId | null {
  return id === null ? null : toCoreVersionId(id)
}

function toPublicVersionId(id: CoreVersionId | null): VersionId | null {
  return id as VersionId | null
}

function decodeUtf8(bytes: Uint8Array, details: Readonly<Record<string, unknown>>): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new MdvError('INVALID_UTF8', 'Markdown content is not valid UTF-8', { details, cause })
  }
}

function versionNotFound(
  versionId: VersionId,
  tree?: TreeKind,
  reason?: 'missing' | 'wrong-tree',
): MdvError {
  return new MdvError('NOT_FOUND', `Unknown${tree === undefined ? '' : ` ${tree}`} version ${versionId}`, {
    details: {
      versionId,
      ...(tree === undefined ? {} : { tree }),
      ...(reason === undefined ? {} : { reason }),
    },
  })
}

function corruptSnapshot(message: string): MdvError {
  return new MdvError('INVALID_GRAPH', message)
}

function toMdvError(cause: unknown, fallbackMessage: string): MdvError {
  if (cause instanceof MdvError) {
    return cause
  }
  if (cause instanceof ArchiveError) {
    return new MdvError(cause.code, cause.message, {
      details: cause.details,
      cause,
    })
  }
  if (cause instanceof GraphValidationError) {
    return new MdvError('INVALID_GRAPH', cause.message, {
      details: { issues: cause.issues },
      cause,
    })
  }
  if (cause instanceof RangeError) {
    return new MdvError('LIMIT_EXCEEDED', cause.message, { cause })
  }
  return new MdvError('IO_ERROR', fallbackMessage, { cause })
}
