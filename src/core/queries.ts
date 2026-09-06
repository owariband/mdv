import type { VersionId } from './ids.js'
import type {
  DocumentVersion,
  MdvState,
  ReferenceVersion,
  TreeKind,
} from './model.js'

export function getHistory(
  state: MdvState,
  tree: TreeKind,
  from?: VersionId,
): readonly (ReferenceVersion | DocumentVersion)[] {
  const versions = tree === 'reference' ? state.references : state.documents
  const head = tree === 'reference' ? state.referenceHead : state.documentHead
  let current = from ?? head
  const history: (ReferenceVersion | DocumentVersion)[] = []

  while (current !== null) {
    const version = versions.get(current)
    if (version === undefined) {
      throw new RangeError(`Unknown ${tree} version: ${current}`)
    }
    history.push(version)
    current = version.parent
  }
  return Object.freeze(history)
}

export function getChildren(
  state: MdvState,
  tree: TreeKind,
  version: VersionId,
): readonly (ReferenceVersion | DocumentVersion)[] {
  const versions = tree === 'reference' ? state.references : state.documents
  if (!versions.has(version)) {
    throw new RangeError(`Unknown ${tree} version: ${version}`)
  }
  const index = tree === 'reference' ? state.referenceChildren : state.documentChildren
  return Object.freeze((index.get(version) ?? []).map((id) => {
    const child = versions.get(id)
    if (child === undefined) {
      throw new Error(`Corrupt ${tree} children index: ${id}`)
    }
    return child
  }))
}

export function getDocumentReference(
  state: MdvState,
  document: VersionId,
): ReferenceVersion | null {
  const version = state.documents.get(document)
  if (version === undefined) {
    throw new RangeError(`Unknown document version: ${document}`)
  }
  if (version.referenceVersion === null) {
    return null
  }
  const reference = state.references.get(version.referenceVersion)
  if (reference === undefined) {
    throw new Error(`Corrupt Document -> Reference index: ${version.referenceVersion}`)
  }
  return reference
}

export function listDocumentsUsingReference(
  state: MdvState,
  reference: VersionId,
): readonly DocumentVersion[] {
  if (!state.references.has(reference)) {
    throw new RangeError(`Unknown reference version: ${reference}`)
  }
  return Object.freeze((state.documentsByReference.get(reference) ?? []).map((id) => {
    const document = state.documents.get(id)
    if (document === undefined) {
      throw new Error(`Corrupt reverse Reference index: ${id}`)
    }
    return document
  }))
}

