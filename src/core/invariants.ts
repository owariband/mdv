import type {
  ArchiveIndexDto,
  DocumentVersionMetaFileDto,
  LocatedVersionFileDto,
  VersionMetaFileDto,
} from '../archive/format-dto.js'
import {
  brandDocumentId,
  brandGeneration,
  brandVersionId,
  isDocumentId,
  isGeneration,
  isVersionId,
} from './ids.js'
import type { DocumentId, Generation, VersionId } from './ids.js'

export interface GraphIssue {
  readonly path: string
  readonly message: string
}

export class GraphValidationError extends Error {
  readonly issues: readonly GraphIssue[]

  constructor(issues: readonly GraphIssue[]) {
    super(`Invalid MDV version graph: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'GraphValidationError'
    this.issues = Object.freeze([...issues])
  }
}

export interface ValidatedVersionFileDto<T extends VersionMetaFileDto> {
  readonly id: VersionId
  readonly meta: T
}

export interface ValidatedArchiveIndex {
  readonly documentId: DocumentId
  readonly generation: Generation
  readonly referenceHead: VersionId | null
  readonly documentHead: VersionId | null
  readonly referenceVersions: readonly ValidatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly ValidatedVersionFileDto<DocumentVersionMetaFileDto>[]
}

export function validateArchiveIndex(input: ArchiveIndexDto): ValidatedArchiveIndex {
  const issues: GraphIssue[] = []
  const documentId = validateDocumentId(input.manifest.documentId, issues)
  const generation = validateGeneration(input.manifest.generation, issues)
  const seenIds = new Map<string, string>()

  const referenceVersions = validateVersionEntries(
    input.referenceVersions,
    'ref_tree',
    seenIds,
    issues,
  )
  const documentVersions = validateVersionEntries(
    input.documentVersions,
    'doc_tree',
    seenIds,
    issues,
  )
  const referenceIds = new Set(referenceVersions.map((version) => version.id))
  const documentIds = new Set(documentVersions.map((version) => version.id))

  const referenceHead = validateHead(input.referenceHead, 'ref_tree/HEAD', referenceIds, issues)
  const documentHead = validateHead(input.documentHead, 'doc_tree/HEAD', documentIds, issues)

  validateParents(referenceVersions, 'ref_tree', referenceIds, documentIds, issues)
  validateParents(documentVersions, 'doc_tree', documentIds, referenceIds, issues)
  validateDocumentReferences(documentVersions, referenceIds, documentIds, issues)
  detectParentCycles(referenceVersions, 'ref_tree', issues)
  detectParentCycles(documentVersions, 'doc_tree', issues)

  if (issues.length > 0) {
    throw new GraphValidationError(issues)
  }

  return Object.freeze({
    documentId,
    generation,
    referenceHead,
    documentHead,
    referenceVersions: Object.freeze(referenceVersions),
    documentVersions: Object.freeze(documentVersions),
  })
}

function validateDocumentId(value: string, issues: GraphIssue[]): DocumentId {
  if (!isDocumentId(value)) {
    issues.push({ path: 'manifest.json/documentId', message: 'is not a valid Document ID' })
  }
  return brandDocumentId(value)
}

function validateGeneration(value: number, issues: GraphIssue[]): Generation {
  if (!isGeneration(value)) {
    issues.push({ path: 'manifest.json/generation', message: 'is not a non-negative safe integer' })
  }
  return brandGeneration(value)
}

function validateVersionEntries<T extends VersionMetaFileDto>(
  entries: readonly LocatedVersionFileDto<T>[],
  treePath: 'ref_tree' | 'doc_tree',
  seenIds: Map<string, string>,
  issues: GraphIssue[],
): ValidatedVersionFileDto<T>[] {
  const validated: ValidatedVersionFileDto<T>[] = []

  for (const entry of entries) {
    const path = `${treePath}/versions/${entry.directoryId}`
    if (!isVersionId(entry.directoryId)) {
      issues.push({ path, message: 'directory name is not a valid Version ID' })
      continue
    }
    if (entry.meta.id !== entry.directoryId) {
      issues.push({ path: `${path}/meta.json/id`, message: 'must equal its version directory name' })
    }

    const previousPath = seenIds.get(entry.directoryId)
    if (previousPath !== undefined) {
      issues.push({ path, message: `duplicates Version ID already used at ${previousPath}` })
    } else {
      seenIds.set(entry.directoryId, path)
    }

    validated.push(Object.freeze({
      id: brandVersionId(entry.directoryId),
      meta: entry.meta,
    }))
  }

  return validated
}

function validateHead(
  value: string | null,
  path: string,
  ownIds: ReadonlySet<VersionId>,
  issues: GraphIssue[],
): VersionId | null {
  if (value === null) {
    return null
  }
  if (!isVersionId(value)) {
    issues.push({ path, message: 'is not a valid Version ID' })
    return brandVersionId(value)
  }

  const id = brandVersionId(value)
  if (!ownIds.has(id)) {
    issues.push({ path, message: 'does not point to a version in the same tree' })
  }
  return id
}

function validateParents<T extends VersionMetaFileDto>(
  entries: readonly ValidatedVersionFileDto<T>[],
  treePath: 'ref_tree' | 'doc_tree',
  ownIds: ReadonlySet<VersionId>,
  otherIds: ReadonlySet<VersionId>,
  issues: GraphIssue[],
): void {
  for (const entry of entries) {
    if (entry.meta.parent === null) {
      continue
    }
    const parent = brandVersionId(entry.meta.parent)
    const path = `${treePath}/versions/${entry.id}/meta.json/parent`
    if (ownIds.has(parent)) {
      continue
    }
    issues.push({
      path,
      message: otherIds.has(parent)
        ? 'points to a version in the other tree'
        : 'points to a missing version',
    })
  }
}

function validateDocumentReferences(
  entries: readonly ValidatedVersionFileDto<DocumentVersionMetaFileDto>[],
  referenceIds: ReadonlySet<VersionId>,
  documentIds: ReadonlySet<VersionId>,
  issues: GraphIssue[],
): void {
  for (const entry of entries) {
    if (entry.meta.referenceVersion === null) {
      continue
    }
    const reference = brandVersionId(entry.meta.referenceVersion)
    if (referenceIds.has(reference)) {
      continue
    }
    issues.push({
      path: `doc_tree/versions/${entry.id}/meta.json/referenceVersion`,
      message: documentIds.has(reference)
        ? 'points to a Document Version instead of a Reference Version'
        : 'points to a missing Reference Version',
    })
  }
}

function detectParentCycles<T extends VersionMetaFileDto>(
  entries: readonly ValidatedVersionFileDto<T>[],
  treePath: 'ref_tree' | 'doc_tree',
  issues: GraphIssue[],
): void {
  const parents = new Map(entries.map((entry) => [
    entry.id,
    entry.meta.parent === null ? null : brandVersionId(entry.meta.parent),
  ] as const))
  const complete = new Set<VersionId>()

  for (const start of parents.keys()) {
    if (complete.has(start)) {
      continue
    }

    const path: VersionId[] = []
    const positions = new Map<VersionId, number>()
    let current: VersionId | null = start

    while (current !== null && parents.has(current) && !complete.has(current)) {
      const cycleStart = positions.get(current)
      if (cycleStart !== undefined) {
        const cycle = [...path.slice(cycleStart), current].join(' -> ')
        issues.push({ path: `${treePath}/versions`, message: `contains parent cycle ${cycle}` })
        break
      }
      positions.set(current, path.length)
      path.push(current)
      current = parents.get(current) ?? null
    }

    for (const id of path) {
      complete.add(id)
    }
  }
}

