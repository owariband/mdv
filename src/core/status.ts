import { createHash } from 'node:crypto'

import type { VersionId } from './ids.js'
import type { MdvState, TreeKind } from './model.js'

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

export function computeDocumentStatus(
  state: MdvState,
  referenceWorkingCopy: Uint8Array,
  documentWorkingCopy: Uint8Array,
): DocumentStatus {
  const reference = computeWorkingCopyStatus(state, 'reference', referenceWorkingCopy)
  const document = computeWorkingCopyStatus(state, 'document', documentWorkingCopy)

  if (state.documentHead === null) {
    return Object.freeze({
      reference,
      document,
      referenceRelation: Object.freeze({ kind: 'no-document-head' }),
    })
  }

  const documentVersion = state.documents.get(state.documentHead)
  if (documentVersion === undefined) {
    throw new Error(`Corrupt document HEAD index: ${state.documentHead}`)
  }
  if (documentVersion.referenceVersion === null) {
    return Object.freeze({
      reference,
      document,
      referenceRelation: Object.freeze({ kind: 'unbound' }),
    })
  }
  if (documentVersion.referenceVersion === state.referenceHead) {
    return Object.freeze({
      reference,
      document,
      referenceRelation: Object.freeze({
        kind: 'aligned',
        referenceVersion: documentVersion.referenceVersion,
      }),
    })
  }
  return Object.freeze({
    reference,
    document,
    referenceRelation: Object.freeze({
      kind: 'drifted',
      boundReference: documentVersion.referenceVersion,
      currentReference: state.referenceHead,
    }),
  })
}

function computeWorkingCopyStatus(
  state: MdvState,
  tree: TreeKind,
  workingCopy: Uint8Array,
): TreeWorkingCopyStatus {
  const head = tree === 'reference' ? state.referenceHead : state.documentHead
  if (head === null) {
    return Object.freeze({ head, dirty: workingCopy.byteLength !== 0 })
  }

  const versions = tree === 'reference' ? state.references : state.documents
  const version = versions.get(head)
  if (version === undefined) {
    throw new Error(`Corrupt ${tree} HEAD index: ${head}`)
  }

  return Object.freeze({
    head,
    dirty: version.contentBytes !== workingCopy.byteLength
      || version.contentSha256 !== sha256(workingCopy),
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
