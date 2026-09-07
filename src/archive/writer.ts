import { createWriteStream } from 'node:fs'
import { chmod, open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import * as yazl from 'yazl'

const MAX_WRITE_ENTRIES = 65_534
const MAX_WRITE_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_WRITE_TOTAL_BYTES = 512 * 1024 * 1024
const END_OF_CENTRAL_DIRECTORY_BYTES = 22
const ZIP64_LOCATOR_BYTES = 20
const ZIP32_EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ENTRY_OPTIONS = Object.freeze({
  mode: 0o100644,
  compress: false,
  compressionLevel: 0,
  forceZip64Format: false,
  forceDosTimestamp: true,
})

export type ArchiveWriteEntry =
  | {
      readonly name: string
      readonly bytes: Uint8Array
    }
  | {
      readonly name: string
      readonly size: number
      read(): Promise<Uint8Array>
    }

/** Writes one complete deterministic ZIP32 archive and never replaces an existing path. */
export async function writeArchive(
  path: string,
  entries: readonly ArchiveWriteEntry[],
): Promise<void> {
  const orderedEntries = validateAndSortEntries(entries)
  const entryOptions = {
    ...ENTRY_OPTIONS,
    mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
  }
  const zip = new yazl.ZipFile()
  const zipOutput = zip.outputStream as Readable
  const fileOutput = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  const writing = pipeline(zipOutput, fileOutput)

  zip.once('error', (cause: unknown) => {
    zipOutput.destroy(asError(cause))
  })

  try {
    for (const entry of orderedEntries) {
      if ('bytes' in entry) {
        zip.addBuffer(Buffer.from(entry.bytes), entry.name, entryOptions)
        continue
      }

      zip.addReadStreamLazy(entry.name, { ...entryOptions, size: entry.size }, (callback) => {
        void Promise.resolve().then(() => entry.read()).then(
          (bytes) => {
            if (bytes.byteLength !== entry.size) {
              callback(new Error(
                `Entry ${entry.name} produced ${bytes.byteLength} bytes; expected ${entry.size}`,
              ), Readable.from([]))
              return
            }
            callback(null, Readable.from([Buffer.from(bytes)]))
          },
          (cause: unknown) => callback(asError(cause), Readable.from([])),
        )
      })
    }

    zip.end({ forceZip64Format: false, comment: '' })
    await writing
    await chmod(path, 0o600)
    await assertZip32Archive(path)
  } catch (cause) {
    zipOutput.destroy(asError(cause))
    fileOutput.destroy(asError(cause))
    await writing.catch(() => undefined)
    throw cause
  }
}

function validateAndSortEntries(
  entries: readonly ArchiveWriteEntry[],
): readonly ArchiveWriteEntry[] {
  if (entries.length === 0 || entries.length > MAX_WRITE_ENTRIES) {
    throw new RangeError(`Archive entry count must be between 1 and ${MAX_WRITE_ENTRIES}`)
  }

  const collisionNames = new Map<string, string>()
  let totalBytes = 0
  for (const entry of entries) {
    validateEntryName(entry.name)
    const collisionKey = asciiCaseFold(entry.name.normalize('NFC'))
    const collision = collisionNames.get(collisionKey)
    if (collision !== undefined) {
      throw new TypeError(`Archive entries ${collision} and ${entry.name} have conflicting names`)
    }
    collisionNames.set(collisionKey, entry.name)

    const size = 'bytes' in entry ? entry.bytes.byteLength : entry.size
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WRITE_ENTRY_BYTES) {
      throw new RangeError(`Entry ${entry.name} must be at most ${MAX_WRITE_ENTRY_BYTES} bytes`)
    }
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_WRITE_TOTAL_BYTES) {
      throw new RangeError(`Archive content must be at most ${MAX_WRITE_TOTAL_BYTES} bytes`)
    }
  }

  return [...entries].sort((left, right) => Buffer.compare(
    Buffer.from(left.name, 'utf8'),
    Buffer.from(right.name, 'utf8'),
  ))
}

function validateEntryName(name: string): void {
  const encoded = Buffer.from(name, 'utf8')
  const segments = name.split('/')
  if (
    name === ''
    || name.endsWith('/')
    || name.startsWith('/')
    || /^[A-Za-z]:\//.test(name)
    || name.includes('\\')
    || name.includes('\0')
    || encoded.toString('utf8') !== name
    || name.normalize('NFC') !== name
    || encoded.byteLength > 512
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Unsafe archive entry name ${JSON.stringify(name)}`)
  }
}

function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

async function assertZip32Archive(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const stats = await file.stat()
    if (stats.size < END_OF_CENTRAL_DIRECTORY_BYTES || stats.size >= 0xffffffff) {
      throw new Error('Writer produced an invalid ZIP32 archive size')
    }

    const tailLength = Math.min(
      stats.size,
      END_OF_CENTRAL_DIRECTORY_BYTES + ZIP64_LOCATOR_BYTES,
    )
    const tail = Buffer.alloc(tailLength)
    await file.read(tail, 0, tailLength, stats.size - tailLength)
    const eocdOffset = tailLength - END_OF_CENTRAL_DIRECTORY_BYTES

    if (tail.readUInt32LE(eocdOffset) !== ZIP32_EOCD_SIGNATURE) {
      throw new Error('Writer produced a ZIP archive with an unexpected trailer')
    }
    if (
      tail.readUInt16LE(eocdOffset + 8) === 0xffff
      || tail.readUInt16LE(eocdOffset + 10) === 0xffff
      || tail.readUInt32LE(eocdOffset + 12) === 0xffffffff
      || tail.readUInt32LE(eocdOffset + 16) === 0xffffffff
      || (
        eocdOffset >= ZIP64_LOCATOR_BYTES
        && tail.readUInt32LE(eocdOffset - ZIP64_LOCATOR_BYTES) === ZIP64_LOCATOR_SIGNATURE
      )
    ) {
      throw new Error('Writer produced forbidden ZIP64 records')
    }
  } finally {
    await file.close()
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
