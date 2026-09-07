import { createHash } from 'node:crypto'
import {
  close as closeFileDescriptor,
  fstat as statFileDescriptor,
  open as openFileDescriptor,
  read as readFileDescriptor,
} from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder } from 'node:util'

import * as yauzl from 'yauzl'

import {
  decodeDocumentVersionValue,
  decodeManifestValue,
  decodeReferenceVersionValue,
  FormatDecodeError,
} from './codec.js'
import type { FormatWarning } from './codec.js'
import { ArchiveError } from './errors.js'
import type {
  DocumentVersionMetaFileDto,
  LocatedVersionFileDto,
  ManifestFileDto,
  VersionMetaFileDto,
} from './format-dto.js'
import { parseJsonEntry } from './json.js'
import { resolveReadLimits } from './limits.js'
import type { ReadLimits } from './limits.js'

export type ArchiveTreeKind = 'reference' | 'document'

export interface ArchiveReadOptions {
  readonly limits?: Partial<ReadLimits>
}

export interface ArchiveWarning extends FormatWarning {
  readonly entry: string
}

export interface ArchiveVersionContent {
  readonly tree: ArchiveTreeKind
  readonly versionId: string
  readonly metadataBytes: Uint8Array
  readonly bytes: Uint8Array
}

export interface ArchiveVersionEntry {
  readonly tree: ArchiveTreeKind
  readonly versionId: string
  readonly metadataBytes: number
  readonly contentBytes: number
}

export interface ArchiveVersionContentVerification {
  readonly complete: boolean
  readonly errors: readonly ArchiveError[]
}

export interface OpenedArchive {
  readonly manifest: ManifestFileDto
  readonly referenceHead: string | null
  readonly documentHead: string | null
  readonly referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[]
  readonly versionEntries: readonly ArchiveVersionEntry[]
  readonly warnings: readonly ArchiveWarning[]

  readManifestBytes(): Promise<Uint8Array>
  readWorkingCopy(tree: ArchiveTreeKind): Promise<Uint8Array>
  readVersionContent(tree: ArchiveTreeKind, versionId: string): Promise<Uint8Array>
  readVersionContents(): AsyncIterable<ArchiveVersionContent>
  verifyVersionContents(maxIssues: number): Promise<ArchiveVersionContentVerification>
  close(): Promise<void>
}

interface BufferSource {
  readonly kind: 'buffer'
  readonly bytes: Buffer
}

interface PathSource {
  readonly kind: 'path'
  readonly path: string
}

type ArchiveSource = BufferSource | PathSource

interface ScannedEntries {
  readonly zip: yauzl.ZipFile
  readonly entries: ReadonlyMap<string, yauzl.Entry>
}

interface VersionPaths {
  readonly id: string
  meta?: yauzl.Entry
  content?: yauzl.Entry
}

interface ClassicZipContainerProfile {
  readonly centralDirectoryOffset: number
  readonly centralDirectoryBytes: number
  readonly totalEntries: number
}

type ByteRangeReader = (position: number, length: number) => Promise<Buffer>

const VERSION_PATH = /^(ref_tree|doc_tree)\/versions\/(v_[0-9a-f]{32})\/(meta\.json|content\.md)$/
const VERSION_DIRECTORY = /^(ref_tree|doc_tree)\/versions\/v_[0-9a-f]{32}\/$/
const ALLOWED_DIRECTORIES = new Set([
  'ref_tree/',
  'ref_tree/versions/',
  'doc_tree/',
  'doc_tree/versions/',
])
const ALLOWED_FIXED_FILES = new Set([
  'manifest.json',
  'ref_tree/HEAD',
  'ref_tree/current.md',
  'doc_tree/HEAD',
  'doc_tree/current.md',
])
const HEAD = /^v_[0-9a-f]{32}\n$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50
const CENTRAL_DIRECTORY_HEADER_BYTES = 46
const CENTRAL_DIRECTORY_READ_AHEAD_BYTES = 64 * 1024
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const END_OF_CENTRAL_DIRECTORY_BYTES = 22
const MAX_ZIP_COMMENT_BYTES = 0xffff
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_LOCATOR_BYTES = 20
const ZIP_TRAILER_SEARCH_BYTES = (
  ZIP64_LOCATOR_BYTES
  + END_OF_CENTRAL_DIRECTORY_BYTES
  + MAX_ZIP_COMMENT_BYTES
)

export async function openArchiveFromBytes(
  bytes: Uint8Array,
  options: ArchiveReadOptions = {},
): Promise<OpenedArchive> {
  const source: BufferSource = { kind: 'buffer', bytes: Buffer.from(bytes) }
  return openArchive(source, resolveReadLimits(options.limits))
}

export async function openArchiveFromPath(
  path: string,
  options: ArchiveReadOptions = {},
): Promise<OpenedArchive> {
  return openArchive({ kind: 'path', path: resolve(path) }, resolveReadLimits(options.limits))
}

export async function openArchiveForVerificationFromPath(
  path: string,
  options: ArchiveReadOptions = {},
): Promise<OpenedArchive> {
  return openArchive(
    { kind: 'path', path: resolve(path) },
    resolveReadLimits(options.limits),
    true,
  )
}

async function openArchive(
  source: ArchiveSource,
  limits: ReadLimits,
  retainInitialScan = false,
): Promise<OpenedArchive> {
  const scanned = await scanEntries(source, limits)
  let scanRetained = false
  try {
    const manifestEntry = requireManifestEntry(scanned.entries)
    const manifestBytes = await readEntryBytes(scanned.zip, manifestEntry, limits.maxJsonBytes)
    const manifestValue = parseJsonEntry(
      manifestBytes,
      'manifest.json',
      limits.maxJsonDepth,
    )
    rejectWrongFormat(manifestValue)

    let manifestDecoded
    try {
      manifestDecoded = decodeManifestValue(manifestValue)
    } catch (cause) {
      throw mapFormatError(cause, 'manifest.json')
    }

    validateArchiveLayout(scanned.entries)
    const referenceWorkingCopyEntry = requireEntry(scanned.entries, 'ref_tree/current.md')
    const documentWorkingCopyEntry = requireEntry(scanned.entries, 'doc_tree/current.md')
    const referenceHead = await readHead(scanned, 'ref_tree/HEAD')
    const documentHead = await readHead(scanned, 'doc_tree/HEAD')
    const referenceVersions: LocatedVersionFileDto<VersionMetaFileDto>[] = []
    const documentVersions: LocatedVersionFileDto<DocumentVersionMetaFileDto>[] = []
    const warnings = locateWarnings('manifest.json', manifestDecoded.warnings)

    const versionPaths = collectVersionPaths(scanned.entries, limits)
    for (const version of versionPaths.reference) {
      const decoded = await readReferenceMetadata(scanned, version, limits)
      referenceVersions.push({ directoryId: version.id, meta: decoded.value })
      warnings.push(...locateWarnings(
        `ref_tree/versions/${version.id}/meta.json`,
        decoded.warnings,
      ))
    }
    for (const version of versionPaths.document) {
      const decoded = await readDocumentMetadata(scanned, version, limits)
      documentVersions.push({ directoryId: version.id, meta: decoded.value })
      warnings.push(...locateWarnings(
        `doc_tree/versions/${version.id}/meta.json`,
        decoded.warnings,
      ))
    }

    const referenceWorkingCopy = await readMarkdownEntry(
      scanned,
      referenceWorkingCopyEntry,
      limits.maxEntryBytes,
    )
    const documentWorkingCopy = await readMarkdownEntry(
      scanned,
      documentWorkingCopyEntry,
      limits.maxEntryBytes,
    )

    const archive = new IndexedArchive(
      source,
      limits,
      manifestDecoded.value,
      referenceHead,
      documentHead,
      referenceVersions,
      documentVersions,
      [
        ...versionPaths.document.map((version): ArchiveVersionEntry => Object.freeze({
          tree: 'document',
          versionId: version.id,
          metadataBytes: version.meta.uncompressedSize,
          contentBytes: version.content.uncompressedSize,
        })),
        ...versionPaths.reference.map((version): ArchiveVersionEntry => Object.freeze({
          tree: 'reference',
          versionId: version.id,
          metadataBytes: version.meta.uncompressedSize,
          contentBytes: version.content.uncompressedSize,
        })),
      ],
      warnings,
      manifestBytes,
      referenceWorkingCopy,
      documentWorkingCopy,
      retainInitialScan ? scanned : null,
    )
    scanRetained = retainInitialScan
    return archive
  } finally {
    if (!scanRetained) {
      await closeZip(scanned.zip, source.kind)
    }
  }
}

class IndexedArchive implements OpenedArchive {
  readonly referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[]
  readonly versionEntries: readonly ArchiveVersionEntry[]
  readonly warnings: readonly ArchiveWarning[]
  private readonly referenceMeta: ReadonlyMap<string, VersionMetaFileDto>
  private readonly documentMeta: ReadonlyMap<string, DocumentVersionMetaFileDto>

  constructor(
    private readonly source: ArchiveSource,
    private readonly limits: ReadLimits,
    readonly manifest: ManifestFileDto,
    readonly referenceHead: string | null,
    readonly documentHead: string | null,
    referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[],
    documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[],
    versionEntries: readonly ArchiveVersionEntry[],
    warnings: readonly ArchiveWarning[],
    private readonly manifestBytes: Uint8Array,
    private readonly referenceWorkingCopy: Uint8Array,
    private readonly documentWorkingCopy: Uint8Array,
    private readonly verificationScan: ScannedEntries | null,
  ) {
    this.referenceVersions = Object.freeze([...referenceVersions])
    this.documentVersions = Object.freeze([...documentVersions])
    this.versionEntries = Object.freeze([...versionEntries])
    this.warnings = Object.freeze([...warnings])
    this.referenceMeta = new Map(referenceVersions.map((version) => [version.directoryId, version.meta]))
    this.documentMeta = new Map(documentVersions.map((version) => [version.directoryId, version.meta]))
  }

  async readManifestBytes(): Promise<Uint8Array> {
    return Uint8Array.from(this.manifestBytes)
  }

  async readWorkingCopy(tree: ArchiveTreeKind): Promise<Uint8Array> {
    const bytes = tree === 'reference' ? this.referenceWorkingCopy : this.documentWorkingCopy
    return Uint8Array.from(bytes)
  }

  async readVersionContent(tree: ArchiveTreeKind, versionId: string): Promise<Uint8Array> {
    const metadata = tree === 'reference'
      ? this.referenceMeta.get(versionId)
      : this.documentMeta.get(versionId)
    if (metadata === undefined) {
      throw new ArchiveError('INVALID_VERSION', `Unknown ${tree} version ${versionId}`, {
        details: { tree, versionId },
      })
    }

    const scanned = await scanEntries(this.source, this.limits)
    try {
      requireManifestEntry(scanned.entries)
      validateArchiveLayout(scanned.entries)
      requireEntry(scanned.entries, 'ref_tree/current.md')
      requireEntry(scanned.entries, 'doc_tree/current.md')
      return await readVerifiedVersionContent(scanned, this.limits, tree, versionId, metadata)
    } finally {
      await closeZip(scanned.zip, this.source.kind)
    }
  }

  async *readVersionContents(): AsyncIterable<ArchiveVersionContent> {
    const scanned = await scanEntries(this.source, this.limits)
    try {
      requireManifestEntry(scanned.entries)
      validateArchiveLayout(scanned.entries)
      requireEntry(scanned.entries, 'ref_tree/current.md')
      requireEntry(scanned.entries, 'doc_tree/current.md')

      for (const version of this.documentVersions) {
        const metadataEntry = `doc_tree/versions/${version.directoryId}/meta.json`
        yield {
          tree: 'document',
          versionId: version.directoryId,
          metadataBytes: await readEntryBytes(
            scanned.zip,
            requireEntry(scanned.entries, metadataEntry),
            this.limits.maxJsonBytes,
          ),
          bytes: await readVerifiedVersionContent(
            scanned,
            this.limits,
            'document',
            version.directoryId,
            version.meta,
          ),
        }
      }
      for (const version of this.referenceVersions) {
        const metadataEntry = `ref_tree/versions/${version.directoryId}/meta.json`
        yield {
          tree: 'reference',
          versionId: version.directoryId,
          metadataBytes: await readEntryBytes(
            scanned.zip,
            requireEntry(scanned.entries, metadataEntry),
            this.limits.maxJsonBytes,
          ),
          bytes: await readVerifiedVersionContent(
            scanned,
            this.limits,
            'reference',
            version.directoryId,
            version.meta,
          ),
        }
      }
    } finally {
      await closeZip(scanned.zip, this.source.kind)
    }
  }

  async verifyVersionContents(maxIssues: number): Promise<ArchiveVersionContentVerification> {
    if (!Number.isSafeInteger(maxIssues) || maxIssues < 0) {
      throw new RangeError('maxIssues must be a non-negative safe integer')
    }
    if (this.versionEntries.length === 0) {
      return freezeContentVerification(true, [])
    }
    if (maxIssues === 0) {
      return freezeContentVerification(false, [])
    }

    let scanned = this.verificationScan
    const closeAfterVerification = scanned === null
    if (scanned === null) {
      try {
        scanned = await scanEntries(this.source, this.limits)
      } catch (cause) {
        if (cause instanceof ArchiveError) {
          return freezeContentVerification(false, [cause])
        }
        throw cause
      }
    }

    const errors: ArchiveError[] = []
    let complete = true
    try {
      requireManifestEntry(scanned.entries)
      validateArchiveLayout(scanned.entries)
      requireEntry(scanned.entries, 'ref_tree/current.md')
      requireEntry(scanned.entries, 'doc_tree/current.md')

      const versions = [
        ...this.documentVersions.map(({ directoryId, meta }) => ({
          tree: 'document' as const,
          directoryId,
          meta,
        })),
        ...this.referenceVersions.map(({ directoryId, meta }) => ({
          tree: 'reference' as const,
          directoryId,
          meta,
        })),
      ]

      for (const version of versions) {
        if (errors.length >= maxIssues) {
          return freezeContentVerification(false, errors)
        }

        const treePath = version.tree === 'reference' ? 'ref_tree' : 'doc_tree'
        const entryName = `${treePath}/versions/${version.directoryId}/content.md`
        let bytes: Uint8Array
        try {
          bytes = await readEntryBytes(
            scanned.zip,
            requireEntry(scanned.entries, entryName),
            this.limits.maxEntryBytes,
          )
        } catch (cause) {
          if (!(cause instanceof ArchiveError)) {
            throw cause
          }
          errors.push(cause)
          complete = false
          if (cause.code === 'LIMIT_EXCEEDED') {
            return freezeContentVerification(false, errors)
          }
          continue
        }

        for (const error of inspectVersionContent(
          bytes,
          version.tree,
          version.directoryId,
          version.meta,
          entryName,
        )) {
          if (errors.length >= maxIssues) {
            return freezeContentVerification(false, errors)
          }
          errors.push(error)
        }
      }

      return freezeContentVerification(complete, errors)
    } catch (cause) {
      if (!(cause instanceof ArchiveError)) {
        throw cause
      }
      if (errors.length < maxIssues) {
        errors.push(cause)
      }
      return freezeContentVerification(false, errors)
    } finally {
      if (closeAfterVerification) {
        await closeZip(scanned.zip, this.source.kind)
      }
    }
  }

  async close(): Promise<void> {
    if (this.verificationScan !== null) {
      await closeZip(this.verificationScan.zip, this.source.kind)
    }
  }
}

async function readVerifiedVersionContent(
  scanned: ScannedEntries,
  limits: ReadLimits,
  tree: ArchiveTreeKind,
  versionId: string,
  metadata: VersionMetaFileDto,
): Promise<Uint8Array> {
  const entryName = `${tree === 'reference' ? 'ref_tree' : 'doc_tree'}/versions/${versionId}/content.md`
  const bytes = await readEntryBytes(
    scanned.zip,
    requireEntry(scanned.entries, entryName),
    limits.maxEntryBytes,
  )
  const [error] = inspectVersionContent(bytes, tree, versionId, metadata, entryName)
  if (error !== undefined) {
    throw error
  }
  return bytes
}

function inspectVersionContent(
  bytes: Uint8Array,
  tree: ArchiveTreeKind,
  versionId: string,
  metadata: VersionMetaFileDto,
  entryName: string,
): readonly ArchiveError[] {
  const errors: ArchiveError[] = []
  try {
    validateMarkdownBytes(bytes, entryName)
  } catch (cause) {
    if (!(cause instanceof ArchiveError)) {
      throw cause
    }
    errors.push(new ArchiveError(cause.code, cause.message, {
      entry: entryName,
      details: { ...cause.details, tree, versionId },
      cause,
    }))
  }

  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== metadata.contentBytes || actualHash !== metadata.contentSha256) {
    errors.push(new ArchiveError(
      'INTEGRITY_MISMATCH',
      `Version content does not match metadata for ${versionId}`,
      {
        entry: entryName,
        details: {
          tree,
          versionId,
          expectedContentBytes: metadata.contentBytes,
          actualContentBytes: bytes.byteLength,
          expectedContentSha256: metadata.contentSha256,
          actualContentSha256: actualHash,
        },
      },
    ))
  }
  return errors
}

function freezeContentVerification(
  complete: boolean,
  errors: readonly ArchiveError[],
): ArchiveVersionContentVerification {
  return Object.freeze({ complete, errors: Object.freeze([...errors]) })
}

function locateWarnings(
  entry: string,
  warnings: readonly FormatWarning[],
): ArchiveWarning[] {
  return warnings.map((warning) => Object.freeze({ ...warning, entry }))
}

async function scanEntries(source: ArchiveSource, limits: ReadLimits): Promise<ScannedEntries> {
  let zip: yauzl.ZipFile
  try {
    zip = await openZip(source, limits)
  } catch (cause) {
    if (cause instanceof ArchiveError) {
      throw cause
    }
    throw mapArchiveOpenError(source, cause)
  }

  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ArchiveError(
        'LIMIT_EXCEEDED',
        `Archive has ${zip.entryCount} entries; limit is ${limits.maxEntries}`,
      )
    }

    const entries = new Map<string, yauzl.Entry>()
    const collisionNames = new Map<string, string>()
    let totalUncompressedBytes = 0

    for await (const entry of zip.eachEntry()) {
      const name = decodeEntryName(entry)
      validateEntryPath(name)
      validateEntryKind(entry, name)
      validateCompression(entry, name, limits)

      const collisionKey = asciiCaseFold(name.normalize('NFC'))
      const collision = collisionNames.get(collisionKey)
      if (collision !== undefined) {
        throw new ArchiveError(
          'INVALID_ARCHIVE',
          `Archive entries ${collision} and ${name} have conflicting names`,
          { entry: name },
        )
      }
      collisionNames.set(collisionKey, name)

      totalUncompressedBytes += entry.uncompressedSize
      if (!Number.isSafeInteger(totalUncompressedBytes)
        || totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw new ArchiveError(
          'LIMIT_EXCEEDED',
          `Archive uncompressed size exceeds ${limits.maxTotalUncompressedBytes}`,
          { entry: name },
        )
      }

      entries.set(name, entry)
    }

    return { zip, entries }
  } catch (cause) {
    await closeZip(zip, source.kind)
    if (cause instanceof ArchiveError) {
      throw cause
    }
    throw new ArchiveError('INVALID_ARCHIVE', 'Failed while indexing ZIP entries', { cause })
  }
}

async function openZip(source: ArchiveSource, limits: ReadLimits): Promise<yauzl.ZipFile> {
  const options = {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  }
  if (source.kind === 'buffer') {
    const profile = inspectZipContainerProfile(readBufferTail(source.bytes), source.bytes.byteLength)
    await validateCentralDirectoryProfile(
      profile,
      limits,
      async (position, length) => readBufferRange(source.bytes, position, length),
    )
    return yauzl.fromBufferPromise(source.bytes, options)
  }

  const descriptor = await openDescriptor(source.path)
  let transferred = false
  try {
    const size = await descriptorSize(descriptor)
    const profile = inspectZipContainerProfile(
      await readDescriptorTail(descriptor, size),
      size,
    )
    await validateCentralDirectoryProfile(
      profile,
      limits,
      (position, length) => readDescriptorBytes(descriptor, position, length),
    )
    const zip = await yauzl.fromFdPromise(descriptor, options)
    transferred = true
    return zip
  } finally {
    if (!transferred) {
      await closeDescriptor(descriptor).catch(() => undefined)
    }
  }
}

function readBufferTail(bytes: Buffer): Buffer {
  return bytes.subarray(Math.max(0, bytes.byteLength - ZIP_TRAILER_SEARCH_BYTES))
}

function readBufferRange(bytes: Buffer, position: number, length: number): Buffer {
  if (position < 0 || length < 0 || position + length > bytes.byteLength) {
    throw new ArchiveError('INVALID_ARCHIVE', 'ZIP central directory is outside the archive')
  }
  return bytes.subarray(position, position + length)
}

async function readDescriptorTail(descriptor: number, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ArchiveError('INVALID_ARCHIVE', 'ZIP file has an invalid size')
  }
  const length = Math.min(size, ZIP_TRAILER_SEARCH_BYTES)
  return readDescriptorBytes(descriptor, size - length, length)
}

async function readDescriptorBytes(
  descriptor: number,
  position: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = await readDescriptor(
      descriptor,
      bytes,
      offset,
      length - offset,
      position + offset,
    )
    if (bytesRead === 0) {
      throw new ArchiveError('INVALID_ARCHIVE', 'ZIP file ended while reading its metadata')
    }
    offset += bytesRead
  }
  return bytes
}

function inspectZipContainerProfile(
  trailer: Buffer,
  totalSize: number,
): ClassicZipContainerProfile | null {
  const eocdOffset = findEndOfCentralDirectory(trailer)
  if (eocdOffset === null) {
    return null
  }
  if (
    eocdOffset >= ZIP64_LOCATOR_BYTES
    && trailer.readUInt32LE(eocdOffset - ZIP64_LOCATOR_BYTES) === ZIP64_LOCATOR_SIGNATURE
  ) {
    throw new ArchiveError('INVALID_ARCHIVE', 'ZIP64 archives are not allowed', {
      details: { reason: 'zip64-archive' },
    })
  }

  const diskNumber = trailer.readUInt16LE(eocdOffset + 4)
  const centralDirectoryDisk = trailer.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = trailer.readUInt16LE(eocdOffset + 8)
  const totalEntries = trailer.readUInt16LE(eocdOffset + 10)
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== totalEntries
  ) {
    throw new ArchiveError('INVALID_ARCHIVE', 'Multi-disk ZIP archives are not allowed', {
      details: {
        reason: 'multi-disk-archive',
        diskNumber,
        centralDirectoryDisk,
        entriesOnDisk,
        totalEntries,
      },
    })
  }

  const centralDirectoryBytes = trailer.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = trailer.readUInt32LE(eocdOffset + 16)
  const eocdAbsoluteOffset = totalSize - trailer.byteLength + eocdOffset
  if (
    centralDirectoryOffset + centralDirectoryBytes > eocdAbsoluteOffset
    || centralDirectoryOffset + centralDirectoryBytes > totalSize
  ) {
    throw new ArchiveError('INVALID_ARCHIVE', 'ZIP central directory is outside the archive')
  }
  return { centralDirectoryOffset, centralDirectoryBytes, totalEntries }
}

async function validateCentralDirectoryProfile(
  profile: ClassicZipContainerProfile | null,
  limits: ReadLimits,
  readRange: ByteRangeReader,
): Promise<void> {
  if (profile === null) {
    return
  }
  if (profile.totalEntries > limits.maxEntries) {
    throw new ArchiveError(
      'LIMIT_EXCEEDED',
      `Archive has ${profile.totalEntries} entries; limit is ${limits.maxEntries}`,
    )
  }

  const directoryEnd = profile.centralDirectoryOffset + profile.centralDirectoryBytes
  let cursor = profile.centralDirectoryOffset
  let windowStart = -1
  let window: Buffer = Buffer.alloc(0)

  for (let index = 0; index < profile.totalEntries; index += 1) {
    if (cursor + CENTRAL_DIRECTORY_HEADER_BYTES > directoryEnd) {
      throw new ArchiveError('INVALID_ARCHIVE', 'ZIP central directory ended early')
    }
    if (
      cursor < windowStart
      || cursor + CENTRAL_DIRECTORY_HEADER_BYTES > windowStart + window.byteLength
    ) {
      windowStart = cursor
      window = await readRange(
        windowStart,
        Math.min(CENTRAL_DIRECTORY_READ_AHEAD_BYTES, directoryEnd - windowStart),
      )
    }
    const headerOffset = cursor - windowStart
    const header = window.subarray(
      headerOffset,
      headerOffset + CENTRAL_DIRECTORY_HEADER_BYTES,
    )
    if (
      header.byteLength !== CENTRAL_DIRECTORY_HEADER_BYTES
      || header.readUInt32LE(0) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE
    ) {
      throw new ArchiveError('INVALID_ARCHIVE', 'Invalid ZIP central directory header')
    }

    const diskNumberStart = header.readUInt16LE(34)
    if (diskNumberStart !== 0) {
      throw new ArchiveError('INVALID_ARCHIVE', 'Multi-disk ZIP archives are not allowed', {
        details: {
          reason: 'multi-disk-archive',
          entryIndex: index,
          diskNumberStart,
        },
      })
    }

    const recordBytes = (
      CENTRAL_DIRECTORY_HEADER_BYTES
      + header.readUInt16LE(28)
      + header.readUInt16LE(30)
      + header.readUInt16LE(32)
    )
    cursor += recordBytes
    if (cursor > directoryEnd) {
      throw new ArchiveError('INVALID_ARCHIVE', 'ZIP central directory entry exceeds its bounds')
    }
  }
}

function findEndOfCentralDirectory(trailer: Buffer): number | null {
  for (
    let offset = trailer.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= 0;
    offset -= 1
  ) {
    if (trailer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue
    }
    const commentBytes = trailer.readUInt16LE(offset + 20)
    return offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentBytes === trailer.byteLength
      ? offset
      : null
  }
  return null
}

function openDescriptor(path: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    openFileDescriptor(path, 'r', (error, descriptor) => {
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise(descriptor)
    })
  })
}

function descriptorSize(descriptor: number): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    statFileDescriptor(descriptor, (error, stats) => {
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise(stats.size)
    })
  })
}

function readDescriptor(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    readFileDescriptor(
      descriptor,
      buffer,
      offset,
      length,
      position,
      (error, bytesRead) => {
        if (error) {
          rejectPromise(error)
          return
        }
        resolvePromise(bytesRead)
      },
    )
  })
}

function closeDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    closeFileDescriptor(descriptor, (error) => {
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise()
    })
  })
}

async function closeZip(zip: yauzl.ZipFile, sourceKind: ArchiveSource['kind']): Promise<void> {
  if (!zip.isOpen) {
    return
  }
  if (sourceKind === 'buffer') {
    zip.close()
    return
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onClose = (): void => {
      zip.off('error', onError)
      resolvePromise()
    }
    const onError = (cause: unknown): void => {
      zip.off('close', onClose)
      rejectPromise(cause)
    }
    zip.once('close', onClose)
    zip.once('error', onError)
    try {
      zip.close()
    } catch (cause) {
      zip.off('close', onClose)
      zip.off('error', onError)
      rejectPromise(cause)
    }
  })
}

function mapArchiveOpenError(source: ArchiveSource, cause: unknown): ArchiveError {
  if (source.kind === 'path') {
    const code = readFileSystemErrorCode(cause)
    const details = code === null ? { path: source.path } : { path: source.path, ioCode: code }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return new ArchiveError('NOT_FOUND', `MDV file not found: ${source.path}`, { details, cause })
    }
    if (code !== null) {
      return new ArchiveError('IO_ERROR', `Failed to open MDV file ${source.path}`, {
        details,
        cause,
      })
    }
    return new ArchiveError('INVALID_ARCHIVE', 'Input is not a readable ZIP archive', {
      details,
      cause,
    })
  }
  return new ArchiveError('INVALID_ARCHIVE', 'Input is not a readable ZIP archive', { cause })
}

function readFileSystemErrorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') {
    return null
  }
  const error = cause as { readonly code?: unknown; readonly syscall?: unknown }
  return typeof error.code === 'string' && typeof error.syscall === 'string'
    ? error.code
    : null
}

function validateArchiveLayout(entries: ReadonlyMap<string, yauzl.Entry>): void {
  for (const name of entries.keys()) {
    if (name.endsWith('/')) {
      if (!ALLOWED_DIRECTORIES.has(name) && !VERSION_DIRECTORY.test(name)) {
        throw new ArchiveError('INVALID_ARCHIVE', `Unexpected directory entry ${name}`, {
          entry: name,
        })
      }
      continue
    }
    if (!ALLOWED_FIXED_FILES.has(name) && !VERSION_PATH.test(name)) {
      throw new ArchiveError('INVALID_ARCHIVE', `Unexpected file entry ${name}`, { entry: name })
    }
  }
}

function decodeEntryName(entry: yauzl.Entry): string {
  if (entry.fileNameRaw.byteLength > 512) {
    throw new ArchiveError('LIMIT_EXCEEDED', 'ZIP entry name exceeds 512 bytes')
  }
  let name: string
  try {
    name = UTF8_DECODER.decode(entry.fileNameRaw)
  } catch (cause) {
    throw new ArchiveError('INVALID_ARCHIVE', 'ZIP entry name is not UTF-8', { cause })
  }
  if (name.normalize('NFC') !== name) {
    throw new ArchiveError('INVALID_ARCHIVE', `ZIP entry name is not Unicode NFC: ${name}`, {
      entry: name,
    })
  }
  return name
}

function validateEntryPath(name: string): void {
  const directory = name.endsWith('/')
  const path = directory ? name.slice(0, -1) : name
  const segments = path.split('/')

  if (
    path === ''
    || path.startsWith('/')
    || /^[A-Za-z]:\//.test(path)
    || path.includes('\\')
    || path.includes('\0')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ArchiveError('INVALID_ARCHIVE', `Unsafe ZIP entry path ${JSON.stringify(name)}`, {
      entry: name,
    })
  }
}

function validateEntryKind(entry: yauzl.Entry, name: string): void {
  if (entry.isEncrypted()) {
    throw new ArchiveError('INVALID_ARCHIVE', `Encrypted ZIP entry is not allowed: ${name}`, {
      entry: name,
    })
  }
  if (entry.extraFields.some((field) => field.id === 0x0001)) {
    throw new ArchiveError('INVALID_ARCHIVE', `ZIP64 entry is not allowed: ${name}`, { entry: name })
  }

  const hostSystem = entry.versionMadeBy >>> 8
  if (hostSystem !== 3) {
    return
  }
  const unixMode = entry.externalFileAttributes >>> 16
  const fileType = unixMode & 0xf000
  const expectedType = name.endsWith('/') ? 0x4000 : 0x8000
  if (fileType !== 0 && fileType !== expectedType) {
    throw new ArchiveError('INVALID_ARCHIVE', `Non-regular ZIP entry is not allowed: ${name}`, {
      entry: name,
    })
  }
}

function validateCompression(entry: yauzl.Entry, name: string, limits: ReadLimits): void {
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new ArchiveError(
      'INVALID_ARCHIVE',
      `Unsupported compression method ${entry.compressionMethod} for ${name}`,
      { entry: name },
    )
  }
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new ArchiveError('INVALID_ARCHIVE', `Invalid uncompressed size for ${name}`, { entry: name })
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ArchiveError(
      'LIMIT_EXCEEDED',
      `Entry ${name} exceeds ${limits.maxEntryBytes} uncompressed bytes`,
      { entry: name },
    )
  }
  const ratio = entry.compressedSize === 0
    ? entry.uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY
    : entry.uncompressedSize / entry.compressedSize
  if (ratio > limits.maxCompressionRatio) {
    throw new ArchiveError(
      'LIMIT_EXCEEDED',
      `Entry ${name} compression ratio exceeds ${limits.maxCompressionRatio}`,
      { entry: name },
    )
  }
}

function collectVersionPaths(
  entries: ReadonlyMap<string, yauzl.Entry>,
  limits: ReadLimits,
): {
  readonly reference: readonly Required<VersionPaths>[]
  readonly document: readonly Required<VersionPaths>[]
} {
  const trees = {
    reference: new Map<string, VersionPaths>(),
    document: new Map<string, VersionPaths>(),
  }

  for (const [name, entry] of entries) {
    const match = VERSION_PATH.exec(name)
    if (match === null) {
      continue
    }
    const [, treePath, id, file] = match
    if (id === undefined || file === undefined) {
      throw new ArchiveError('INVALID_TREE', `Invalid version path ${name}`, { entry: name })
    }
    const tree = treePath === 'ref_tree' ? trees.reference : trees.document
    const version = tree.get(id) ?? { id }
    if (file === 'meta.json') {
      version.meta = entry
    } else {
      version.content = entry
    }
    tree.set(id, version)
  }

  const totalVersions = trees.reference.size + trees.document.size
  if (totalVersions > limits.maxVersions) {
    throw new ArchiveError(
      'LIMIT_EXCEEDED',
      `Archive has ${totalVersions} versions; limit is ${limits.maxVersions}`,
    )
  }

  return {
    reference: completeVersionPaths(trees.reference, 'ref_tree'),
    document: completeVersionPaths(trees.document, 'doc_tree'),
  }
}

function completeVersionPaths(
  versions: ReadonlyMap<string, VersionPaths>,
  treePath: 'ref_tree' | 'doc_tree',
): readonly Required<VersionPaths>[] {
  const completed: Required<VersionPaths>[] = []
  for (const version of versions.values()) {
    if (version.meta === undefined || version.content === undefined) {
      throw new ArchiveError(
        'INVALID_TREE',
        `Version ${treePath}/versions/${version.id} must contain meta.json and content.md`,
      )
    }
    completed.push({ id: version.id, meta: version.meta, content: version.content })
  }
  completed.sort((left, right) => left.id.localeCompare(right.id))
  return Object.freeze(completed)
}

async function readReferenceMetadata(
  scanned: ScannedEntries,
  version: Required<VersionPaths>,
  limits: ReadLimits,
) {
  const entryName = `ref_tree/versions/${version.id}/meta.json`
  const value = parseJsonEntry(
    await readEntryBytes(scanned.zip, version.meta, limits.maxJsonBytes),
    entryName,
    limits.maxJsonDepth,
    'INVALID_VERSION',
  )
  try {
    return decodeReferenceVersionValue(value)
  } catch (cause) {
    throw mapFormatError(cause, entryName)
  }
}

async function readDocumentMetadata(
  scanned: ScannedEntries,
  version: Required<VersionPaths>,
  limits: ReadLimits,
) {
  const entryName = `doc_tree/versions/${version.id}/meta.json`
  const value = parseJsonEntry(
    await readEntryBytes(scanned.zip, version.meta, limits.maxJsonBytes),
    entryName,
    limits.maxJsonDepth,
    'INVALID_VERSION',
  )
  try {
    return decodeDocumentVersionValue(value)
  } catch (cause) {
    throw mapFormatError(cause, entryName)
  }
}

async function readHead(scanned: ScannedEntries, entryName: string): Promise<string | null> {
  const entry = scanned.entries.get(entryName)
  if (entry === undefined) {
    return null
  }
  const bytes = await readEntryBytes(scanned.zip, entry, 35)
  let value: string
  try {
    value = UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new ArchiveError('INVALID_UTF8', `Entry ${entryName} is not valid UTF-8`, {
      entry: entryName,
      cause,
    })
  }
  if (!HEAD.test(value)) {
    throw new ArchiveError('INVALID_TREE', `Entry ${entryName} is not a Version ID plus LF`, {
      entry: entryName,
    })
  }
  return value.slice(0, -1)
}

async function readMarkdownEntry(
  scanned: ScannedEntries,
  entry: yauzl.Entry,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = await readEntryBytes(scanned.zip, entry, maxBytes)
  validateMarkdownBytes(bytes, entry.fileName)
  return bytes
}

export function validateMarkdownBytes(bytes: Uint8Array, entryName: string): void {
  let text: string
  try {
    text = UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new ArchiveError('INVALID_UTF8', `Entry ${entryName} is not valid UTF-8`, {
      entry: entryName,
      cause,
    })
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new ArchiveError('INVALID_UTF8', `Entry ${entryName} must not contain a UTF-8 BOM`, {
      entry: entryName,
    })
  }
}

async function readEntryBytes(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number,
): Promise<Uint8Array> {
  if (entry.uncompressedSize > maxBytes) {
    throw new ArchiveError('LIMIT_EXCEEDED', `Entry ${entry.fileName} exceeds ${maxBytes} bytes`, {
      entry: entry.fileName,
    })
  }

  try {
    const stream = await zip.openReadStreamPromise(entry)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.byteLength
      if (total > maxBytes || total > entry.uncompressedSize) {
        stream.destroy()
        throw new ArchiveError(
          'LIMIT_EXCEEDED',
          `Entry ${entry.fileName} produced more bytes than declared or allowed`,
          { entry: entry.fileName },
        )
      }
      chunks.push(buffer)
    }
    if (total !== entry.uncompressedSize) {
      throw new ArchiveError('INVALID_ARCHIVE', `Entry ${entry.fileName} length does not match ZIP metadata`, {
        entry: entry.fileName,
      })
    }
    return Uint8Array.from(Buffer.concat(chunks, total))
  } catch (cause) {
    if (cause instanceof ArchiveError) {
      throw cause
    }
    throw new ArchiveError('INVALID_ARCHIVE', `Failed to read ZIP entry ${entry.fileName}`, {
      entry: entry.fileName,
      cause,
    })
  }
}

function requireEntry(
  entries: ReadonlyMap<string, yauzl.Entry>,
  name: string,
): yauzl.Entry {
  const entry = entries.get(name)
  if (entry === undefined) {
    throw new ArchiveError('INVALID_TREE', `Required entry ${name} is missing`, { entry: name })
  }
  return entry
}

function requireManifestEntry(entries: ReadonlyMap<string, yauzl.Entry>): yauzl.Entry {
  const entry = entries.get('manifest.json')
  if (entry === undefined) {
    throw new ArchiveError('NOT_MDV', 'ZIP archive does not contain manifest.json', {
      entry: 'manifest.json',
    })
  }
  return entry
}

function rejectWrongFormat(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return
  }
  const manifest = value as Record<string, unknown>
  if (manifest.format !== 'mdv') {
    if (typeof manifest.format === 'string') {
      throw new ArchiveError('NOT_MDV', 'manifest.json does not identify an MDV document', {
        entry: 'manifest.json',
      })
    }
    return
  }
  if (typeof manifest.formatVersion === 'string' && manifest.formatVersion !== '0.1') {
    throw new ArchiveError(
      'UNSUPPORTED_FORMAT',
      `Unsupported MDV format version ${String(manifest.formatVersion)}`,
      {
        entry: 'manifest.json',
        details: { formatVersion: manifest.formatVersion },
      },
    )
  }
}

function mapFormatError(cause: unknown, entry: string): ArchiveError {
  if (cause instanceof ArchiveError) {
    return cause
  }
  if (cause instanceof FormatDecodeError) {
    return new ArchiveError(
      cause.kind === 'manifest' ? 'INVALID_MANIFEST' : 'INVALID_VERSION',
      cause.message,
      {
        entry,
        details: { kind: cause.kind, issues: cause.issues },
        cause,
      },
    )
  }
  return new ArchiveError('INVALID_ARCHIVE', `Failed to decode ${entry}`, { entry, cause })
}

function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}
