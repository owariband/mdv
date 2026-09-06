import type { Generation, DocumentId, VersionId } from './ids.js'

export type TreeKind = 'reference' | 'document'

export interface Actor {
  readonly type: 'human' | 'agent'
  readonly id?: string
  readonly name?: string
}

export interface Manifest {
  readonly format: 'mdv'
  readonly formatVersion: '0.1'
  readonly documentId: DocumentId
  readonly generation: Generation
  readonly markdownProfile: string
}

interface VersionRecordBase {
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
  readonly contentSha256: string
  readonly contentBytes: number
}

export interface ReferenceVersion extends VersionRecordBase {
  readonly kind: 'reference'
}

export interface DocumentVersion extends VersionRecordBase {
  readonly kind: 'document'
  readonly referenceVersion: VersionId | null
}

export interface MdvState {
  readonly manifest: Manifest
  readonly referenceHead: VersionId | null
  readonly documentHead: VersionId | null
  readonly references: ReadonlyMap<VersionId, ReferenceVersion>
  readonly documents: ReadonlyMap<VersionId, DocumentVersion>
  readonly referenceChildren: ReadonlyMap<VersionId, readonly VersionId[]>
  readonly documentChildren: ReadonlyMap<VersionId, readonly VersionId[]>
  readonly documentsByReference: ReadonlyMap<VersionId, readonly VersionId[]>
}

