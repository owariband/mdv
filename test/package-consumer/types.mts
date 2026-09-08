import {
  createMdv, openMdv, parseMdv, verifyMdv, MdvError,
  type DocumentSnapshot, type LocatedDocumentSnapshot, type MdvDocument,
  type DocumentVersionSummary, type ReferenceVersionSummary, type MdvErrorCode,
} from '@mdv/core'

// Compile-only consumer: no ambient Node types or repository path aliases.
const document: MdvDocument = await createMdv('/example.mdv')
const opened: MdvDocument = await openMdv('/example.mdv')
const snapshot: DocumentSnapshot = await parseMdv(new Uint8Array())
const located: LocatedDocumentSnapshot = await parseMdv(new Uint8Array(), { baseDirectory: '/' })
const references: readonly ReferenceVersionSummary[] = opened.listVersions({ tree: 'reference' })
const documents: readonly DocumentVersionSummary[] = opened.listVersions({ tree: 'document' })
const resource = await document.importManagedResource({ bytes: new Uint8Array() })
const absolute: string = await located.resolveManagedResource(resource)
const result = await document.commitDocument({
  expectedGeneration: 0, referenceVersion: null, actor: { type: 'agent' }, summary: 'Commit',
})
if (result.created) await result.document.readVersionText(result.version)
else { const reason: 'no-changes' = result.reason; void reason }
await verifyMdv(new Uint8Array(), { mode: 'full' })
const codes: Record<MdvErrorCode, true> = {
  NOT_MDV: true, UNSUPPORTED_FORMAT: true, INVALID_ARCHIVE: true, INVALID_MANIFEST: true,
  INVALID_TREE: true, INVALID_VERSION: true, INVALID_GRAPH: true, INVALID_UTF8: true,
  INVALID_RESOURCE: true, INTEGRITY_MISMATCH: true, NOT_FOUND: true, LIMIT_EXCEEDED: true,
  CONFLICT: true, IO_ERROR: true,
}
const error: MdvError = new MdvError('CONFLICT', 'Reload before retrying')
void [references, documents, absolute, codes[error.code]]

// @ts-expect-error in-memory snapshots have no write capability
snapshot.saveDocument({ markdown: '', expectedGeneration: 0 })
// @ts-expect-error an unlocated snapshot cannot read local resources
snapshot.resolveManagedResource(resource)
// @ts-expect-error adding a base directory does not grant import/write capability
located.importManagedResource({ bytes: new Uint8Array() })
// @ts-expect-error a Document commit always states its exact bind, including null
document.commitDocument({ expectedGeneration: 0, actor: { type: 'human' }, summary: 'Missing bind' })
// @ts-expect-error writes require compare-and-swap generation
document.saveDocument({ markdown: '' })
// @ts-expect-error internal files are not public package exports
await import('@mdv/core/dist/archive/reader.js')
