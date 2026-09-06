import type { VersionId } from './ids.js'
import type { DocumentVersion, ReferenceVersion } from './model.js'
import { compareRfc3339 } from '../archive/rfc3339.js'

type VersionRecord = ReferenceVersion | DocumentVersion

export function buildChildrenIndex<T extends VersionRecord>(
  versions: ReadonlyMap<VersionId, T>,
): ReadonlyMap<VersionId, readonly VersionId[]> {
  const children = new Map<VersionId, VersionId[]>()

  for (const version of versions.values()) {
    if (version.parent === null) {
      continue
    }
    const siblings = children.get(version.parent) ?? []
    siblings.push(version.id)
    children.set(version.parent, siblings)
  }

  const frozenChildren = new Map<VersionId, readonly VersionId[]>()
  for (const [parent, ids] of children) {
    ids.sort((left, right) => compareVersions(versions.get(left), versions.get(right)))
    frozenChildren.set(parent, Object.freeze([...ids]))
  }
  return frozenChildren
}

export function buildDocumentsByReferenceIndex(
  documents: ReadonlyMap<VersionId, DocumentVersion>,
): ReadonlyMap<VersionId, readonly VersionId[]> {
  const documentsByReference = new Map<VersionId, VersionId[]>()

  for (const document of documents.values()) {
    if (document.referenceVersion === null) {
      continue
    }
    const documentsForReference = documentsByReference.get(document.referenceVersion) ?? []
    documentsForReference.push(document.id)
    documentsByReference.set(document.referenceVersion, documentsForReference)
  }

  const frozenIndex = new Map<VersionId, readonly VersionId[]>()
  for (const [reference, ids] of documentsByReference) {
    ids.sort((left, right) => compareVersions(documents.get(left), documents.get(right)))
    frozenIndex.set(reference, Object.freeze([...ids]))
  }
  return frozenIndex
}

function compareVersions(
  left: VersionRecord | undefined,
  right: VersionRecord | undefined,
): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1
  }
  return compareRfc3339(left.createdAt, right.createdAt) || left.id.localeCompare(right.id)
}
