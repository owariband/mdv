import yazl from 'yazl'

// Independent test encoder, not a call into the production writer.
export function emptyEntries() {
  return [
    ['manifest.json', Buffer.from(JSON.stringify({
      format: 'mdv', formatVersion: '0.1', documentId: `d_${'0'.repeat(32)}`,
      generation: 0, markdownProfile: 'gfm',
    }))],
    ['ref_tree/current.md', Buffer.alloc(0)],
    ['doc_tree/current.md', Buffer.alloc(0)],
  ]
}

export async function zipEntries(entries, options = {}) {
  const zip = new yazl.ZipFile()
  for (const [name, bytes, extra] of entries) {
    zip.addBuffer(bytes, name, {
      compress: false, mtime: new Date(2000, 0, 1), forceDosTimestamp: true, mode: 0o100600,
      ...options, ...extra,
    })
  }
  zip.end()
  const chunks = []
  for await (const chunk of zip.outputStream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
