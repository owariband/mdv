import type { ArchiveIndexDto, VersionMetaFileDto } from '../archive/format-dto.js'
import { buildChildrenIndex, buildDocumentsByReferenceIndex } from './indexes.js'
import { brandVersionId } from './ids.js'
import type { VersionId } from './ids.js'
import { validateArchiveIndex } from './invariants.js'
import type {
  Actor,
  DocumentVersion,
  MdvState,
  ReferenceVersion,
} from './model.js'

export function hydrateArchiveIndex(input: ArchiveIndexDto): MdvState {
  const validated = validateArchiveIndex(input)
  const references = new Map<VersionId, ReferenceVersion>()
  const documents = new Map<VersionId, DocumentVersion>()

  for (const entry of validated.referenceVersions) {
    references.set(entry.id, Object.freeze({
      kind: 'reference',
      ...hydrateVersion(entry.meta),
    }))
  }
  for (const entry of validated.documentVersions) {
    documents.set(entry.id, Object.freeze({
      kind: 'document',
      ...hydrateVersion(entry.meta),
      referenceVersion: entry.meta.referenceVersion === null
        ? null
        : brandVersionId(entry.meta.referenceVersion),
    }))
  }

  return Object.freeze({
    manifest: Object.freeze({
      format: 'mdv',
      formatVersion: '0.1',
      documentId: validated.documentId,
      generation: validated.generation,
      markdownProfile: input.manifest.markdownProfile,
    }),
    referenceHead: validated.referenceHead,
    documentHead: validated.documentHead,
    references,
    documents,
    referenceChildren: buildChildrenIndex(references),
    documentChildren: buildChildrenIndex(documents),
    documentsByReference: buildDocumentsByReferenceIndex(documents),
  })
}

function hydrateVersion(meta: VersionMetaFileDto): {
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
  readonly contentSha256: string
  readonly contentBytes: number
} {
  return {
    id: brandVersionId(meta.id),
    parent: meta.parent === null ? null : brandVersionId(meta.parent),
    createdAt: meta.createdAt,
    actor: Object.freeze({
      type: meta.actor.type,
      ...(meta.actor.id === undefined ? {} : { id: meta.actor.id }),
      ...(meta.actor.name === undefined ? {} : { name: meta.actor.name }),
    }),
    summary: meta.summary,
    contentSha256: meta.contentSha256,
    contentBytes: meta.contentBytes,
  }
}

