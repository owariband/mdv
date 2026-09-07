import {
  encodeDocumentVersionValue,
  encodeReferenceVersionValue,
} from './codec.js'
import { ArchiveError } from './errors.js'
import type {
  DocumentVersionMetaFileDto,
  VersionMetaFileDto,
} from './format-dto.js'
import { replaceTopLevelJsonSafeInteger } from './json.js'
import type { ReadLimits } from './limits.js'
import type {
  ArchiveTreeKind,
  ArchiveVersionContent,
  ArchiveVersionEntry,
  OpenedArchive,
} from './reader.js'
import type { ArchiveWriteEntry } from './writer.js'

export type ArchivePackageMutation =
  | {
      readonly type: 'replace-working-copy'
      readonly tree: ArchiveTreeKind
      readonly markdown: Uint8Array
    }
  | {
      readonly type: 'append-reference-version'
      readonly metadata: VersionMetaFileDto
      readonly content: Uint8Array
    }
  | {
      readonly type: 'append-document-version'
      readonly metadata: DocumentVersionMetaFileDto
      readonly content: Uint8Array
    }
  | {
      readonly type: 'checkout'
      readonly tree: ArchiveTreeKind
      readonly versionId: string
    }
  | {
      readonly type: 'preserve-state'
    }

export interface ArchiveMutationEntryPlan {
  readonly entries: readonly ArchiveWriteEntry[]
  finish(): Promise<void>
  close(): Promise<void>
}

export async function createMutationEntryPlan(
  source: OpenedArchive,
  mutation: ArchivePackageMutation,
  nextGeneration: number,
  limits: ReadLimits,
): Promise<ArchiveMutationEntryPlan> {
  const appendedVersion = mutation.type === 'append-reference-version'
    || mutation.type === 'append-document-version'
    ? mutation
    : undefined
  if (appendedVersion !== undefined) {
    if (source.versionEntries.length >= limits.maxVersions) {
      throw new ArchiveError(
        'LIMIT_EXCEEDED',
        `Archive cannot exceed ${limits.maxVersions} versions`,
      )
    }
    if (source.versionEntries.some(({ versionId }) => versionId === appendedVersion.metadata.id)) {
      throw new ArchiveError(
        'CONFLICT',
        `Version ID already exists: ${appendedVersion.metadata.id}`,
        {
          details: {
            reason: 'version-id-collision',
            versionId: appendedVersion.metadata.id,
          },
        },
      )
    }
  }

  const entries: ArchiveWriteEntry[] = [{
    name: 'manifest.json',
    bytes: replaceTopLevelJsonSafeInteger(
      await source.readManifestBytes(),
      'manifest.json',
      'generation',
      nextGeneration,
      limits.maxJsonDepth,
    ),
  }]

  let referenceHead = source.referenceHead
  let documentHead = source.documentHead
  if (mutation.type === 'append-reference-version') {
    referenceHead = mutation.metadata.id
  } else if (mutation.type === 'append-document-version') {
    documentHead = mutation.metadata.id
  } else if (mutation.type === 'checkout') {
    if (mutation.tree === 'reference') {
      referenceHead = mutation.versionId
    } else {
      documentHead = mutation.versionId
    }
  }

  if (referenceHead !== null) {
    entries.push({ name: 'ref_tree/HEAD', bytes: Buffer.from(`${referenceHead}\n`) })
  }
  if (documentHead !== null) {
    entries.push({ name: 'doc_tree/HEAD', bytes: Buffer.from(`${documentHead}\n`) })
  }

  let referenceWorkingCopy = await source.readWorkingCopy('reference')
  let documentWorkingCopy = await source.readWorkingCopy('document')
  if (mutation.type === 'replace-working-copy') {
    if (mutation.tree === 'reference') {
      referenceWorkingCopy = mutation.markdown
    } else {
      documentWorkingCopy = mutation.markdown
    }
  } else if (mutation.type === 'checkout') {
    const checkedOut = await source.readVersionContent(mutation.tree, mutation.versionId)
    if (mutation.tree === 'reference') {
      referenceWorkingCopy = checkedOut
    } else {
      documentWorkingCopy = checkedOut
    }
  }
  entries.push({ name: 'ref_tree/current.md', bytes: referenceWorkingCopy })
  entries.push({ name: 'doc_tree/current.md', bytes: documentWorkingCopy })

  const versionReader = createVersionEntryReader(source)
  for (const version of source.versionEntries) {
    const treePath = version.tree === 'reference' ? 'ref_tree' : 'doc_tree'
    const directory = `${treePath}/versions/${version.versionId}`
    entries.push({
      name: `${directory}/content.md`,
      size: version.contentBytes,
      read: () => versionReader.read(version, 'content'),
    })
    entries.push({
      name: `${directory}/meta.json`,
      size: version.metadataBytes,
      read: () => versionReader.read(version, 'metadata'),
    })
  }

  if (mutation.type === 'append-reference-version') {
    const directory = `ref_tree/versions/${mutation.metadata.id}`
    entries.push({ name: `${directory}/content.md`, bytes: mutation.content })
    entries.push({
      name: `${directory}/meta.json`,
      bytes: encodeReferenceVersionValue(mutation.metadata),
    })
  } else if (mutation.type === 'append-document-version') {
    const directory = `doc_tree/versions/${mutation.metadata.id}`
    entries.push({ name: `${directory}/content.md`, bytes: mutation.content })
    entries.push({
      name: `${directory}/meta.json`,
      bytes: encodeDocumentVersionValue(mutation.metadata),
    })
  }

  return Object.freeze({
    entries,
    finish: versionReader.finish,
    close: versionReader.close,
  })
}

function createVersionEntryReader(source: OpenedArchive): {
  read(entry: ArchiveVersionEntry, part: 'content' | 'metadata'): Promise<Uint8Array>
  finish(): Promise<void>
  close(): Promise<void>
} {
  const iterator = source.versionEntries.length === 0
    ? undefined
    : source.readVersionContents()[Symbol.asyncIterator]()
  let current: ArchiveVersionContent | undefined
  let expectedPart: 'content' | 'metadata' = 'content'
  let closed = false

  return Object.freeze({
    async read(entry, part): Promise<Uint8Array> {
      if (closed || iterator === undefined) {
        throw new ArchiveError('IO_ERROR', 'Historical entry reader is closed')
      }
      if (current === undefined) {
        const next = await iterator.next()
        if (next.done) {
          throw new ArchiveError('INVALID_ARCHIVE', 'Historical entry stream ended early')
        }
        current = next.value
      }
      if (
        current.tree !== entry.tree
        || current.versionId !== entry.versionId
        || part !== expectedPart
      ) {
        throw new ArchiveError(
          'INVALID_ARCHIVE',
          `Historical entry stream is out of order at ${entry.tree}/${entry.versionId}/${part}`,
        )
      }

      if (part === 'content') {
        expectedPart = 'metadata'
        return current.bytes
      }
      const bytes = current.metadataBytes
      current = undefined
      expectedPart = 'content'
      return bytes
    },

    async finish(): Promise<void> {
      if (closed) {
        return
      }
      if (iterator === undefined) {
        closed = true
        return
      }
      if (current !== undefined || expectedPart !== 'content') {
        throw new ArchiveError('INVALID_ARCHIVE', 'Historical entry stream was not fully consumed')
      }
      const next = await iterator.next()
      if (!next.done) {
        throw new ArchiveError('INVALID_ARCHIVE', 'Historical entry stream contains extra content')
      }
      closed = true
    },

    async close(): Promise<void> {
      if (closed) {
        return
      }
      closed = true
      await iterator?.return?.()
    },
  })
}
