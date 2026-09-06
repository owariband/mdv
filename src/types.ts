export const MDV_FORMAT = 'mdv' as const
export const MDV_FORMAT_VERSION = '0.1' as const

export type DocumentId = `d_${string}`
export type VersionId = `v_${string}`
export type TreeKind = 'reference' | 'document'

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

