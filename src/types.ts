export const MDV_FORMAT = 'mdv' as const
export const MDV_FORMAT_VERSION = '0.1' as const

export type DocumentId = `d_${string}`
export type VersionId = `v_${string}`
export type TreeKind = 'reference' | 'document'

export interface ReadLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxCompressionRatio: number
  readonly maxVersions: number
  readonly maxJsonBytes: number
  readonly maxJsonDepth: number
}

export interface OpenOptions {
  readonly limits?: Partial<ReadLimits>
}

export interface ParseOptions extends OpenOptions {
  readonly baseDirectory?: string
}

export interface Actor {
  readonly type: 'human' | 'agent'
  readonly id?: string
  readonly name?: string
}

export interface ManifestSummary {
  readonly format: typeof MDV_FORMAT
  readonly formatVersion: typeof MDV_FORMAT_VERSION
  readonly documentId: DocumentId
  readonly generation: number
  readonly markdownProfile: string
}

export interface TreeSummary {
  readonly head: VersionId | null
}

export interface MdvWarning {
  readonly code: 'UNKNOWN_FIELD' | 'UNKNOWN_MARKDOWN_PROFILE'
  readonly entry: string
  readonly path: string
  readonly message: string
}

export interface VersionQuery {
  readonly tree?: TreeKind
}

interface VersionSummaryBase {
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
}

export interface ReferenceVersionSummary extends VersionSummaryBase {
  readonly tree: 'reference'
}

export interface DocumentVersionSummary extends VersionSummaryBase {
  readonly tree: 'document'
  readonly referenceVersion: VersionId | null
}

export type VersionSummary = ReferenceVersionSummary | DocumentVersionSummary

export interface MarkdownSource {
  readonly bytes: Uint8Array
  readonly markdownProfile: string
  readonly baseDirectory: string | null
  readonly origin: {
    readonly tree: TreeKind
    readonly kind: 'working-copy' | 'version'
    readonly version: VersionId | null
  }
}

export interface DocumentTrace {
  readonly document: DocumentVersionSummary
  readonly ancestry: readonly DocumentVersionSummary[]
  readonly reference: ReferenceVersionSummary | null
}

export interface ReferenceTrace {
  readonly reference: ReferenceVersionSummary
  readonly ancestry: readonly ReferenceVersionSummary[]
  readonly usedByDocuments: readonly DocumentVersionSummary[]
}

export interface DocumentSnapshot {
  readonly manifest: ManifestSummary
  readonly packagePath: string | null
  readonly baseDirectory: string | null
  readonly referenceTree: TreeSummary
  readonly documentTree: TreeSummary
  readonly warnings: readonly MdvWarning[]

  listVersions(query: { readonly tree: 'reference' }): readonly ReferenceVersionSummary[]
  listVersions(query: { readonly tree: 'document' }): readonly DocumentVersionSummary[]
  listVersions(query?: VersionQuery): readonly VersionSummary[]
  getHistory(tree: 'reference', from?: VersionId): readonly ReferenceVersionSummary[]
  getHistory(tree: 'document', from?: VersionId): readonly DocumentVersionSummary[]
  getHistory(tree: TreeKind, from?: VersionId): readonly VersionSummary[]
  getChildren(tree: 'reference', version: VersionId): readonly ReferenceVersionSummary[]
  getChildren(tree: 'document', version: VersionId): readonly DocumentVersionSummary[]
  getChildren(tree: TreeKind, version: VersionId): readonly VersionSummary[]
  getDocumentReference(document: VersionId): VersionId | null
  listDocumentsUsingReference(reference: VersionId): readonly DocumentVersionSummary[]
  traceDocument(document: VersionId): DocumentTrace
  traceReference(reference: VersionId): ReferenceTrace

  readReference(): Promise<MarkdownSource>
  readDocument(): Promise<MarkdownSource>
  readReferenceText(): Promise<string>
  readDocumentText(): Promise<string>
  readVersionBytes(id: VersionId): Promise<Uint8Array>
  readVersionText(id: VersionId): Promise<string>
}

export interface MdvDocument extends DocumentSnapshot {
  readonly packagePath: string
  readonly baseDirectory: string
}
