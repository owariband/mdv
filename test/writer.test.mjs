import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as yauzl from 'yauzl'

import { writeArchive } from '../dist/archive/writer.js'

test('writes entries in UTF-8 byte order with a fixed timestamp', async (t) => {
  const directory = await temporaryDirectory(t)
  const archivePath = join(directory, 'ordered.zip')
  const entries = [
    { name: '中文/content.md', bytes: Buffer.from('four') },
    { name: 'z/content.md', bytes: Buffer.from('three') },
    { name: 'é/content.md', bytes: Buffer.from('two') },
    { name: 'a/content.md', bytes: Buffer.from('one') },
  ]

  await writeArchive(archivePath, entries)
  const metadata = await readZipMetadata(archivePath)
  const expectedNames = entries
    .map(({ name }) => name)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))

  assert.deepEqual(metadata.map(({ name }) => name), expectedNames)
  for (const { modifiedAt } of metadata) {
    assert.equal(modifiedAt.getFullYear(), 1980)
    assert.equal(modifiedAt.getMonth(), 0)
    assert.equal(modifiedAt.getDate(), 1)
    assert.equal(modifiedAt.getHours(), 0)
    assert.equal(modifiedAt.getMinutes(), 0)
    assert.equal(modifiedAt.getSeconds(), 0)
  }
})

test('emits byte-identical ZIP32 output for the same logical entries', async (t) => {
  const directory = await temporaryDirectory(t)
  const firstPath = join(directory, 'first.zip')
  const secondPath = join(directory, 'second.zip')
  const entries = [
    { name: 'manifest.json', bytes: Buffer.from('{"format":"mdv"}\n') },
    { name: 'ref_tree/current.md', bytes: Buffer.from('# reference\r\n') },
    {
      name: 'doc_tree/current.md',
      size: Buffer.byteLength('# 成品\n'),
      async read() {
        return Buffer.from('# 成品\n')
      },
    },
  ]

  await writeArchive(firstPath, entries)
  await writeArchive(secondPath, [...entries].reverse())

  const firstBytes = await readFile(firstPath)
  const secondBytes = await readFile(secondPath)
  assert.deepEqual(firstBytes, secondBytes)
  assert.equal(firstBytes.includes(Buffer.from('504b0606', 'hex')), false)
  assert.equal(firstBytes.includes(Buffer.from('504b0607', 'hex')), false)

  const metadata = await readZipMetadata(firstPath)
  for (const entry of metadata) {
    assert.ok(entry.versionNeededToExtract < 45)
    assert.equal(entry.extraFieldIds.includes(0x0001), false)
  }
})

test('keeps deterministic timestamps when the process timezone changes after import', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await temporaryDirectory(t)
  const firstPath = join(directory, 'utc.zip')
  const secondPath = join(directory, 'los-angeles.zip')
  const previousTimezone = process.env.TZ
  const entries = [{ name: 'content.md', bytes: Buffer.from('same bytes') }]

  try {
    process.env.TZ = 'UTC'
    await writeArchive(firstPath, entries)
    process.env.TZ = 'America/Los_Angeles'
    await writeArchive(secondPath, entries)
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = previousTimezone
    }
  }

  assert.deepEqual(await readFile(firstPath), await readFile(secondPath))
})

test('opens the destination exclusively and leaves an existing file untouched', async (t) => {
  const directory = await temporaryDirectory(t)
  const archivePath = join(directory, 'existing.zip')
  const original = Buffer.from('not an archive, but it belongs to the caller')
  await writeFile(archivePath, original)

  await assert.rejects(
    writeArchive(archivePath, [
      { name: 'manifest.json', bytes: Buffer.from('{}\n') },
    ]),
    (error) => error?.code === 'EEXIST',
  )
  assert.deepEqual(await readFile(archivePath), original)
})

test('rejects entry names that are not lossless UTF-8', async (t) => {
  const directory = await temporaryDirectory(t)
  const archivePath = join(directory, 'invalid-name.zip')

  await assert.rejects(
    writeArchive(archivePath, [
      { name: 'x\ud800', bytes: new Uint8Array() },
    ]),
    TypeError,
  )
  await assert.rejects(readFile(archivePath), (error) => error?.code === 'ENOENT')
})

test('routes synchronous lazy-entry failures through the returned promise', async (t) => {
  const directory = await temporaryDirectory(t)
  const archivePath = join(directory, 'lazy-failure.zip')

  await assert.rejects(
    writeArchive(archivePath, [{
      name: 'content.md',
      size: 1,
      read() {
        throw new Error('injected synchronous read failure')
      },
    }]),
    /injected synchronous read failure/,
  )
})

test('restores owner access after an unusually restrictive umask', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await temporaryDirectory(t)
  const archivePath = join(directory, 'restrictive-umask.zip')
  const previousUmask = process.umask(0o777)

  try {
    await writeArchive(archivePath, [
      { name: 'content.md', bytes: Buffer.from('private') },
    ])
  } finally {
    process.umask(previousUmask)
  }

  assert.equal((await stat(archivePath)).mode & 0o777, 0o600)
  assert.ok((await readFile(archivePath)).byteLength > 0)
  assert.equal(await readStoredEntry(archivePath, 'content.md'), 'private')
})

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdv-writer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function readZipMetadata(path) {
  const zip = await openZip(path)
  return new Promise((resolve, reject) => {
    const metadata = []
    zip.once('error', reject)
    zip.once('end', () => {
      zip.close()
      resolve(metadata)
    })
    zip.on('entry', (entry) => {
      metadata.push({
        name: entry.fileName,
        modifiedAt: entry.getLastModDate(),
        versionNeededToExtract: entry.versionNeededToExtract,
        extraFieldIds: entry.extraFields.map(({ id }) => id),
      })
      zip.readEntry()
    })
    zip.readEntry()
  })
}

function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error)
        return
      }
      resolve(zip)
    })
  })
}

function readStoredEntry(path, expectedName) {
  return openZip(path).then((zip) => new Promise((resolve, reject) => {
    zip.once('error', reject)
    zip.on('entry', (entry) => {
      if (entry.fileName !== expectedName) {
        zip.readEntry()
        return
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        const chunks = []
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.once('error', reject)
        stream.once('end', () => {
          zip.close()
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
      })
    })
    zip.readEntry()
  }))
}
