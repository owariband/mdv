import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import { ArchiveError } from './archive/errors.js'
import type { ManifestFileDto } from './archive/format-dto.js'
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
import { hydrateArchiveIndex } from './core/hydrate.js'
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
import { MdvError } from './errors.js'
import type {
  Actor,
  CreateOptions,
  DocumentId,
  DocumentSnapshot,
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
} from './types.js'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const MARKDOWN_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/

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
    const exists = tree === 'reference'
      ? this.#referenceById.has(id)
      : this.#documentById.has(id)
    if (!exists) {
      throw versionNotFound(version, tree)
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

  let committedGeneration: number | undefined
  try {
    const result = await runArchiveTransaction(
      targetPath,
      {
        type: 'save-working-copy',
        tree,
        markdown,
        expectedDocumentId,
        expectedGeneration: input.expectedGeneration,
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
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
    throw new RangeError('expectedGeneration must be a non-negative safe integer')
  }
  if (typeof input.markdown !== 'string' && !(input.markdown instanceof Uint8Array)) {
    throw new TypeError('markdown must be a string or Uint8Array')
  }
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

function versionNotFound(versionId: VersionId, tree?: TreeKind): MdvError {
  return new MdvError('NOT_FOUND', `Unknown${tree === undefined ? '' : ` ${tree}`} version ${versionId}`, {
    details: {
      versionId,
      ...(tree === undefined ? {} : { tree }),
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
