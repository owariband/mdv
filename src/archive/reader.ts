import { createHash } from 'node:crypto'
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

export interface OpenedArchive {
  readonly manifest: ManifestFileDto
  readonly referenceHead: string | null
  readonly documentHead: string | null
  readonly referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[]
  readonly warnings: readonly FormatWarning[]

  readWorkingCopy(tree: ArchiveTreeKind): Promise<Uint8Array>
  readVersionContent(tree: ArchiveTreeKind, versionId: string): Promise<Uint8Array>
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
const REQUIRED_FILES = [
  'manifest.json',
  'ref_tree/current.md',
  'doc_tree/current.md',
] as const
const HEAD = /^v_[0-9a-f]{32}\n$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

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

async function openArchive(source: ArchiveSource, limits: ReadLimits): Promise<OpenedArchive> {
  const scanned = await scanEntries(source, limits)
  try {
    const manifestEntry = requireEntry(scanned.entries, 'manifest.json')
    const manifestValue = parseJsonEntry(
      await readEntryBytes(scanned.zip, manifestEntry, limits.maxJsonBytes),
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

    const referenceHead = await readHead(scanned, 'ref_tree/HEAD')
    const documentHead = await readHead(scanned, 'doc_tree/HEAD')
    const referenceVersions: LocatedVersionFileDto<VersionMetaFileDto>[] = []
    const documentVersions: LocatedVersionFileDto<DocumentVersionMetaFileDto>[] = []
    const warnings = [...manifestDecoded.warnings]

    const versionPaths = collectVersionPaths(scanned.entries, limits)
    for (const version of versionPaths.reference) {
      const decoded = await readReferenceMetadata(scanned, version, limits)
      referenceVersions.push({ directoryId: version.id, meta: decoded.value })
      warnings.push(...decoded.warnings)
    }
    for (const version of versionPaths.document) {
      const decoded = await readDocumentMetadata(scanned, version, limits)
      documentVersions.push({ directoryId: version.id, meta: decoded.value })
      warnings.push(...decoded.warnings)
    }

    const referenceWorkingCopy = await readMarkdownEntry(
      scanned,
      requireEntry(scanned.entries, 'ref_tree/current.md'),
      limits.maxEntryBytes,
    )
    const documentWorkingCopy = await readMarkdownEntry(
      scanned,
      requireEntry(scanned.entries, 'doc_tree/current.md'),
      limits.maxEntryBytes,
    )

    return new IndexedArchive(
      source,
      limits,
      manifestDecoded.value,
      referenceHead,
      documentHead,
      referenceVersions,
      documentVersions,
      warnings,
      referenceWorkingCopy,
      documentWorkingCopy,
    )
  } finally {
    scanned.zip.close()
  }
}

class IndexedArchive implements OpenedArchive {
  readonly referenceVersions: readonly LocatedVersionFileDto<VersionMetaFileDto>[]
  readonly documentVersions: readonly LocatedVersionFileDto<DocumentVersionMetaFileDto>[]
  readonly warnings: readonly FormatWarning[]
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
    warnings: readonly FormatWarning[],
    private readonly referenceWorkingCopy: Uint8Array,
    private readonly documentWorkingCopy: Uint8Array,
  ) {
    this.referenceVersions = Object.freeze([...referenceVersions])
    this.documentVersions = Object.freeze([...documentVersions])
    this.warnings = Object.freeze([...warnings])
    this.referenceMeta = new Map(referenceVersions.map((version) => [version.directoryId, version.meta]))
    this.documentMeta = new Map(documentVersions.map((version) => [version.directoryId, version.meta]))
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
      throw new ArchiveError('INVALID_VERSION', `Unknown ${tree} version ${versionId}`)
    }

    const entryName = `${tree === 'reference' ? 'ref_tree' : 'doc_tree'}/versions/${versionId}/content.md`
    const scanned = await scanEntries(this.source, this.limits)
    try {
      const bytes = await readMarkdownEntry(
        scanned,
        requireEntry(scanned.entries, entryName),
        this.limits.maxEntryBytes,
      )
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      if (bytes.byteLength !== metadata.contentBytes || actualHash !== metadata.contentSha256) {
        throw new ArchiveError(
          'INTEGRITY_MISMATCH',
          `Version content does not match metadata for ${versionId}`,
          { entry: entryName },
        )
      }
      return bytes
    } finally {
      scanned.zip.close()
    }
  }

  async close(): Promise<void> {
    // Readers do not retain a file descriptor after indexing.
  }
}

async function scanEntries(source: ArchiveSource, limits: ReadLimits): Promise<ScannedEntries> {
  let zip: yauzl.ZipFile
  try {
    zip = source.kind === 'path'
      ? await yauzl.openPromise(source.path, {
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        })
      : await yauzl.fromBufferPromise(source.bytes, {
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        })
  } catch (cause) {
    throw new ArchiveError('INVALID_ARCHIVE', 'Input is not a readable ZIP archive', { cause })
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
      entries.set(name, entry)
    }

    for (const required of REQUIRED_FILES) {
      requireEntry(entries, required)
    }
    return { zip, entries }
  } catch (cause) {
    zip.close()
    if (cause instanceof ArchiveError) {
      throw cause
    }
    throw new ArchiveError('INVALID_ARCHIVE', 'Failed while indexing ZIP entries', { cause })
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
  try {
    UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new ArchiveError('INVALID_UTF8', `Entry ${entry.fileName} is not valid UTF-8`, {
      entry: entry.fileName,
      cause,
    })
  }
  return bytes
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

function rejectWrongFormat(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return
  }
  const manifest = value as Record<string, unknown>
  if (manifest.format !== 'mdv') {
    throw new ArchiveError('NOT_MDV', 'manifest.json does not identify an MDV document', {
      entry: 'manifest.json',
    })
  }
  if (manifest.formatVersion !== '0.1') {
    throw new ArchiveError(
      'UNSUPPORTED_FORMAT',
      `Unsupported MDV format version ${String(manifest.formatVersion)}`,
      { entry: 'manifest.json' },
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
      { entry, cause },
    )
  }
  return new ArchiveError('INVALID_ARCHIVE', `Failed to decode ${entry}`, { entry, cause })
}

function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}
