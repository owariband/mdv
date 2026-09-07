import type { MdvErrorCode, MdvErrorDetails } from './errors.js'

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

export interface CreateOptions extends OpenOptions {
  readonly markdownProfile?: string
}

export interface SaveInput {
  readonly markdown: string | Uint8Array
  readonly expectedGeneration: number
}

export interface Actor {
  readonly type: 'human' | 'agent'
  readonly id?: string
  readonly name?: string
}

export interface CommitInput {
  readonly expectedGeneration: number
  readonly actor: Actor
  readonly summary: string
}

export interface CommitDocumentInput extends CommitInput {
  readonly referenceVersion: VersionId | null
}

export interface CheckoutInput {
  readonly version: VersionId
  readonly expectedGeneration: number
  readonly discardChanges?: boolean
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

export interface TreeWorkingCopyStatus {
  readonly head: VersionId | null
  readonly dirty: boolean
}

export type ReferenceRelation =
  | { readonly kind: 'no-document-head' }
  | { readonly kind: 'unbound' }
  | {
      readonly kind: 'aligned'
      readonly referenceVersion: VersionId
    }
  | {
      readonly kind: 'drifted'
      readonly boundReference: VersionId
      readonly currentReference: VersionId | null
    }

export interface DocumentStatus {
  readonly reference: TreeWorkingCopyStatus
  readonly document: TreeWorkingCopyStatus
  readonly referenceRelation: ReferenceRelation
}

export type ContentSpec =
  | {
      readonly tree: TreeKind
      readonly kind: 'working-copy'
    }
  | {
      readonly tree: TreeKind
      readonly kind: 'version'
      readonly version: VersionId
    }

export interface DiffLimits {
  readonly maxInputBytes: number
  readonly maxInputLines: number
  readonly maxEditLength: number
  readonly maxHunks: number
  readonly maxOutputBytes: number
}

export interface DiffOptions {
  readonly contextLines?: number
  readonly limits?: Partial<DiffLimits>
}

export type DiffLine =
  | {
      readonly kind: 'context'
      readonly oldLine: number
      readonly newLine: number
      readonly text: string
    }
  | {
      readonly kind: 'deletion'
      readonly oldLine: number
      readonly newLine: null
      readonly text: string
    }
  | {
      readonly kind: 'addition'
      readonly oldLine: null
      readonly newLine: number
      readonly text: string
    }

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

export interface DiffResult {
  readonly hunks: readonly DiffHunk[]
  readonly unifiedText: string
}

export type VerifyMode = 'metadata' | 'full'

export interface VerifyOptions extends OpenOptions {
  readonly mode?: VerifyMode
  readonly maxIssues?: number
}

export interface VerifyIssue {
  readonly code: MdvErrorCode
  readonly message: string
  readonly entry?: string
  readonly path?: string
  readonly details: MdvErrorDetails
}

export interface VerifyReport {
  readonly mode: VerifyMode
  readonly valid: boolean
  readonly complete: boolean
  readonly issues: readonly VerifyIssue[]
  readonly warnings: readonly MdvWarning[]
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

  getStatus(): Promise<DocumentStatus>
  readContent(source: ContentSpec): Promise<MarkdownSource>
  diff(from: ContentSpec, to: ContentSpec, options?: DiffOptions): Promise<DiffResult>
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

  saveReference(input: SaveInput): Promise<MdvDocument>
  saveDocument(input: SaveInput): Promise<MdvDocument>
  commitReference(input: CommitInput): Promise<CommitResult>
  commitDocument(input: CommitDocumentInput): Promise<CommitResult>
  checkoutReference(input: CheckoutInput): Promise<MdvDocument>
  checkoutDocument(input: CheckoutInput): Promise<MdvDocument>
}

export type CommitResult =
  | {
      readonly created: true
      readonly version: VersionId
      readonly document: MdvDocument
    }
  | {
      readonly created: false
      readonly reason: 'no-changes'
      readonly document: MdvDocument
    }
