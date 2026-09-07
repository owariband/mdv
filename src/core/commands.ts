import { createHash } from 'node:crypto'

import type { VersionId } from './ids.js'
import type {
  Actor,
  DocumentVersion,
  MdvState,
  ReferenceVersion,
  TreeKind,
} from './model.js'

interface CommitPlanInput {
  readonly state: MdvState
  readonly workingCopy: Uint8Array
  readonly actor: Actor
  readonly summary: string
  readonly versionId: VersionId
  readonly createdAt: string
}

export type ReferenceCommitPlanInput = CommitPlanInput

export interface DocumentCommitPlanInput extends CommitPlanInput {
  readonly referenceVersion: VersionId | null
}

export interface CheckoutPlanInput {
  readonly state: MdvState
  readonly tree: TreeKind
  readonly version: VersionId
  readonly workingCopy: Uint8Array
  readonly discardChanges?: boolean
}

interface NoChangesCommitPlan {
  readonly kind: 'no-changes'
  readonly tree: TreeKind
}

export interface AppendReferenceCommitPlan {
  readonly kind: 'append'
  readonly tree: 'reference'
  readonly version: ReferenceVersion
  readonly content: Uint8Array
}

export interface AppendDocumentCommitPlan {
  readonly kind: 'append'
  readonly tree: 'document'
  readonly version: DocumentVersion
  readonly content: Uint8Array
}

export type ReferenceCommitPlan =
  | NoChangesCommitPlan & { readonly tree: 'reference' }
  | AppendReferenceCommitPlan

export type DocumentCommitPlan =
  | NoChangesCommitPlan & { readonly tree: 'document' }
  | AppendDocumentCommitPlan

export interface CheckoutPlan {
  readonly kind: 'checkout'
  readonly tree: TreeKind
  readonly version: VersionId
  readonly discardedChanges: boolean
}

export type VersionSelectionReason = 'missing' | 'wrong-tree'

export class VersionSelectionError extends Error {
  readonly reason: VersionSelectionReason
  readonly tree: TreeKind
  readonly version: VersionId

  constructor(tree: TreeKind, version: VersionId, reason: VersionSelectionReason) {
    super(reason === 'wrong-tree'
      ? `Version ${version} belongs to the other tree, not ${tree}`
      : `Unknown ${tree} version: ${version}`)
    this.name = 'VersionSelectionError'
    this.reason = reason
    this.tree = tree
    this.version = version
  }
}

export class VersionIdCollisionError extends Error {
  readonly reason = 'version-id-collision' as const
  readonly version: VersionId

  constructor(version: VersionId) {
    super(`Version ID already exists: ${version}`)
    this.name = 'VersionIdCollisionError'
    this.version = version
  }
}

export class WorkingCopyDirtyError extends Error {
  readonly reason = 'working-copy-dirty' as const
  readonly tree: TreeKind

  constructor(tree: TreeKind) {
    super(`Cannot checkout ${tree} while its working copy has uncommitted changes`)
    this.name = 'WorkingCopyDirtyError'
    this.tree = tree
  }
}

export function planReferenceCommit(input: ReferenceCommitPlanInput): ReferenceCommitPlan {
  const contentSha256 = sha256(input.workingCopy)
  const head = input.state.referenceHead === null
    ? null
    : requireVersion(input.state, 'reference', input.state.referenceHead)

  if (head !== null && head.contentSha256 === contentSha256) {
    return Object.freeze({ kind: 'no-changes', tree: 'reference' })
  }

  requireUnusedVersionId(input.state, input.versionId)
  return Object.freeze({
    kind: 'append',
    tree: 'reference',
    version: Object.freeze({
      kind: 'reference',
      id: input.versionId,
      parent: input.state.referenceHead,
      createdAt: input.createdAt,
      actor: freezeActor(input.actor),
      summary: input.summary,
      contentSha256,
      contentBytes: input.workingCopy.byteLength,
    }),
    content: input.workingCopy,
  })
}

export function planDocumentCommit(input: DocumentCommitPlanInput): DocumentCommitPlan {
  if (input.referenceVersion !== null) {
    requireVersion(input.state, 'reference', input.referenceVersion)
  }

  const contentSha256 = sha256(input.workingCopy)
  const head = input.state.documentHead === null
    ? null
    : requireVersion(input.state, 'document', input.state.documentHead)

  if (
    head !== null
    && head.contentSha256 === contentSha256
    && head.referenceVersion === input.referenceVersion
  ) {
    return Object.freeze({ kind: 'no-changes', tree: 'document' })
  }

  requireUnusedVersionId(input.state, input.versionId)
  return Object.freeze({
    kind: 'append',
    tree: 'document',
    version: Object.freeze({
      kind: 'document',
      id: input.versionId,
      parent: input.state.documentHead,
      createdAt: input.createdAt,
      actor: freezeActor(input.actor),
      summary: input.summary,
      contentSha256,
      contentBytes: input.workingCopy.byteLength,
      referenceVersion: input.referenceVersion,
    }),
    content: input.workingCopy,
  })
}

export function planCheckout(input: CheckoutPlanInput): CheckoutPlan {
  requireVersion(input.state, input.tree, input.version)

  const headId = input.tree === 'reference'
    ? input.state.referenceHead
    : input.state.documentHead
  const head = headId === null ? null : requireVersion(input.state, input.tree, headId)
  const workingCopySha256 = sha256(input.workingCopy)
  const dirty = head === null
    ? input.workingCopy.byteLength !== 0
    : head.contentBytes !== input.workingCopy.byteLength
      || head.contentSha256 !== workingCopySha256

  if (dirty && input.discardChanges !== true) {
    throw new WorkingCopyDirtyError(input.tree)
  }

  return Object.freeze({
    kind: 'checkout',
    tree: input.tree,
    version: input.version,
    discardedChanges: dirty,
  })
}

function requireVersion(
  state: MdvState,
  tree: 'reference',
  version: VersionId,
): ReferenceVersion
function requireVersion(
  state: MdvState,
  tree: 'document',
  version: VersionId,
): DocumentVersion
function requireVersion(
  state: MdvState,
  tree: TreeKind,
  version: VersionId,
): ReferenceVersion | DocumentVersion
function requireVersion(
  state: MdvState,
  tree: TreeKind,
  version: VersionId,
): ReferenceVersion | DocumentVersion {
  const ownVersions = tree === 'reference' ? state.references : state.documents
  const otherVersions = tree === 'reference' ? state.documents : state.references
  const selected = ownVersions.get(version)
  if (selected !== undefined) {
    return selected
  }
  throw new VersionSelectionError(
    tree,
    version,
    otherVersions.has(version) ? 'wrong-tree' : 'missing',
  )
}

function requireUnusedVersionId(state: MdvState, version: VersionId): void {
  if (state.references.has(version) || state.documents.has(version)) {
    throw new VersionIdCollisionError(version)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function freezeActor(actor: Actor): Actor {
  return Object.freeze({
    type: actor.type,
    ...(actor.id === undefined ? {} : { id: actor.id }),
    ...(actor.name === undefined ? {} : { name: actor.name }),
  })
}
