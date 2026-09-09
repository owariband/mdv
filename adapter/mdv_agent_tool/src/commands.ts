import { MdvError, openMdv, type VersionId } from '@mdv/core'
import { jsonOutput, MAX_OUTPUT_BYTES, ToolError, type ReadPair, type SaveDocumentRequest } from './protocol.js'

export async function readPair(file: string, documentVersion?: VersionId): Promise<ReadPair> {
  const document = await openMdv(file)
  const referenceVersion = documentVersion === undefined ? undefined : document.getDocumentReference(documentVersion)
  const reference = {
    source: referenceVersion === undefined ? { tree: 'reference', kind: 'working-copy' } as const
      : referenceVersion === null ? null : { tree: 'reference', kind: 'version', version: referenceVersion } as const,
    text: referenceVersion === undefined ? await document.readReferenceText()
      : referenceVersion === null ? '' : await document.readVersionText(referenceVersion),
  }
  // Check each side before reading the next; never return a partial pair as a successful read.
  if (Buffer.byteLength(reference.text, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', 'Reference exceeds the output budget')
  }
  jsonOutput(reference)
  const text = documentVersion === undefined ? await document.readDocumentText() : await document.readVersionText(documentVersion)
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', 'Document exceeds the output budget')
  }
  const pair: ReadPair = {
    documentId: document.manifest.documentId, generation: document.manifest.generation,
    baseDirectory: document.baseDirectory, reference,
    document: { source: documentVersion === undefined ? { tree: 'document', kind: 'working-copy' }
      : { tree: 'document', kind: 'version', version: documentVersion }, text },
    permissions: { reference: 'read-only', document: documentVersion === undefined ? 'read-write' : 'read-only' },
  }
  jsonOutput(pair)
  return pair
}

export async function saveDocument(file: string, input: SaveDocumentRequest) {
  const document = await openMdv(file)
  if (document.manifest.documentId !== input.expectedDocumentId) {
    throw new MdvError('CONFLICT', 'The path now contains a different document; read it again before saving', {
      details: { expectedDocumentId: input.expectedDocumentId, actualDocumentId: document.manifest.documentId },
    })
  }
  // Preserve the caller's read baseline. Core rechecks identity and generation inside its transaction.
  const next = await document.saveDocument({ markdown: input.markdown, expectedGeneration: input.expectedGeneration })
  return { documentId: next.manifest.documentId, generation: next.manifest.generation }
}
