import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  createMdv,
  MdvError,
  openMdv,
  verifyMdv,
  type MdvDocument,
  type TreeKind,
  type VerifyMode,
  type VersionId,
} from '@owariband/mdv'
import {
  MAX_OUTPUT_BYTES,
  ToolError,
  type CheckoutRequest,
  type CommitRequest,
  type DiffRequest,
  type ImportResourceRequest,
  type ReadPair,
  type ResourceRequest,
  type SaveRequest,
  type TreeBaseline,
  type VerifyResourceRequest,
} from './protocol.js'

const MAX_REBASE_ATTEMPTS = 8

export async function readPair(file: string, documentVersion?: VersionId): Promise<ReadPair> {
  const document = await openMdv(file)
  if (documentVersion !== undefined) {
    const referenceVersion = document.getDocumentReference(documentVersion)
    const [referenceText, documentText] = await Promise.all([
      referenceVersion === null ? Promise.resolve('') : document.readVersionText(referenceVersion),
      document.readVersionText(documentVersion),
    ])
    checkTextBudget(referenceText, 'Reference')
    checkTextBudget(documentText, 'Document')
    return {
      documentId: document.manifest.documentId,
      generation: document.manifest.generation,
      baseDirectory: document.baseDirectory,
      reference: {
        source: referenceVersion === null ? null
          : { tree: 'reference', kind: 'version', version: referenceVersion },
        text: referenceText,
      },
      document: {
        source: { tree: 'document', kind: 'version', version: documentVersion },
        text: documentText,
      },
      permissions: { reference: 'read-only', document: 'read-only' },
    }
  }

  const [reference, actual] = await Promise.all([document.readReference(), document.readDocument()])
  const referenceText = decodeMarkdown(reference.bytes, 'Reference')
  const documentText = decodeMarkdown(actual.bytes, 'Document')
  checkTextBudget(referenceText, 'Reference')
  checkTextBudget(documentText, 'Document')
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    baseDirectory: document.baseDirectory,
    reference: {
      source: { tree: 'reference', kind: 'working-copy' },
      text: referenceText,
      baseline: baseline(document, 'reference', reference.bytes),
    },
    document: {
      source: { tree: 'document', kind: 'working-copy' },
      text: documentText,
      baseline: baseline(document, 'document', actual.bytes),
    },
    permissions: { reference: 'approval-required', document: 'read-write' },
  }
}

export async function status(file: string) {
  const document = await openMdv(file)
  return inspect(document)
}

export async function versions(file: string, tree?: TreeKind) {
  const document = await openMdv(file)
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    versions: tree === undefined ? document.listVersions() : document.listVersions({ tree }),
  }
}

export async function trace(file: string, tree: TreeKind, version: VersionId) {
  const document = await openMdv(file)
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    trace: tree === 'reference' ? document.traceReference(version) : document.traceDocument(version),
  }
}

export async function diff(file: string, request: DiffRequest) {
  const document = await openMdv(file)
  const result = request.contextLines === undefined
    ? await document.diff(request.from, request.to)
    : await document.diff(request.from, request.to, { contextLines: request.contextLines })
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    from: request.from,
    to: request.to,
    result,
  }
}

export async function verify(file: string, mode: VerifyMode) {
  return { file, report: await verifyMdv(file, { mode }) }
}

export async function create(file: string, markdownProfile?: string) {
  const document = markdownProfile === undefined
    ? await createMdv(file) : await createMdv(file, { markdownProfile })
  return inspect(document)
}

export async function save(file: string, tree: TreeKind, request: SaveRequest) {
  return mutateTree(file, request.baseline, false, async (document, generation) => {
    const next = tree === 'reference'
      ? await document.saveReference({ markdown: request.markdown, expectedGeneration: generation })
      : await document.saveDocument({ markdown: request.markdown, expectedGeneration: generation })
    return { document: next, data: {} }
  })
}

export async function commit(file: string, tree: TreeKind, request: CommitRequest) {
  return mutateTree(file, request.baseline, true, async (document, generation) => {
    const input = { expectedGeneration: generation, actor: request.actor, summary: request.summary }
    const result = tree === 'reference'
      ? await document.commitReference(input)
      : await document.commitDocument({ ...input, referenceVersion: request.referenceVersion! })
    return {
      document: result.document,
      data: result.created
        ? { created: true as const, version: result.version }
        : { created: false as const, reason: result.reason },
    }
  })
}

export async function checkout(file: string, tree: TreeKind, request: CheckoutRequest) {
  return mutateTree(file, request.baseline, true, async (document, generation) => {
    const input = {
      version: request.version,
      expectedGeneration: generation,
      ...(request.discardChanges ? { discardChanges: true } : {}),
    }
    const next = tree === 'reference'
      ? await document.checkoutReference(input) : await document.checkoutDocument(input)
    return { document: next, data: { restoredVersion: request.version } }
  })
}

export async function importResource(file: string, request: ImportResourceRequest) {
  const document = await openExpected(file, request.expectedDocumentId)
  const sourceFile = resolve(request.sourceFile)
  const bytes = await readExplicitFile(sourceFile, request.maxBytes)
  const relativePath = await document.importManagedResource({
    bytes,
    ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
  }, { maxBytes: request.maxBytes })
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    sourceFile,
    relativePath,
  }
}

export async function resolveResource(file: string, request: ResourceRequest) {
  const document = await openExpected(file, request.expectedDocumentId)
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    relativePath: request.relativePath,
    path: await document.resolveManagedResource(request.relativePath),
  }
}

export async function verifyResource(file: string, request: VerifyResourceRequest) {
  const document = await openExpected(file, request.expectedDocumentId)
  await document.verifyManagedResource(request.relativePath, { maxBytes: request.maxBytes })
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    relativePath: request.relativePath,
    verified: true,
  }
}

async function inspect(document: MdvDocument) {
  const [reference, actual, documentStatus] = await Promise.all([
    document.readReference(),
    document.readDocument(),
    document.getStatus(),
  ])
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    manifest: document.manifest,
    referenceTree: document.referenceTree,
    documentTree: document.documentTree,
    warnings: document.warnings,
    status: documentStatus,
    baselines: {
      reference: baseline(document, 'reference', reference.bytes),
      document: baseline(document, 'document', actual.bytes),
    },
  }
}

async function mutateTree<T extends Record<string, unknown>>(
  file: string,
  expected: TreeBaseline,
  compareHead: boolean,
  operation: (document: MdvDocument, generation: number) => Promise<{
    readonly document: MdvDocument
    readonly data: T
  }>,
) {
  let lastTransactionConflict: MdvError | undefined
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt += 1) {
    const document = await openExpected(file, expected.documentId)
    const actual = await workingBaseline(document, expected.tree)
    assertCurrentBaseline(expected, actual, compareHead)
    let result: Awaited<ReturnType<typeof operation>>
    try {
      result = await operation(document, document.manifest.generation)
    } catch (error) {
      if (!isRetryableTransactionConflict(error)) throw error
      lastTransactionConflict = error
      if (error.details.reason === 'locked') {
        await new Promise((done) => setTimeout(done, 5 * (attempt + 1)))
      }
      continue
    }

    let current: TreeBaseline
    try { current = await workingBaseline(result.document, expected.tree) }
    catch (cause) {
      throw new ToolError('IO_ERROR', 'The MDV operation completed, but its new baseline could not be read; re-read before retrying', {
        committed: true,
        committedGeneration: result.document.manifest.generation,
        tree: expected.tree,
        ...(cause instanceof MdvError ? { causeCode: cause.code } : {}),
      })
    }
    return {
      documentId: result.document.manifest.documentId,
      generation: result.document.manifest.generation,
      baseline: current,
      ...result.data,
    }
  }
  throw lastTransactionConflict ?? new ToolError('CONFLICT', 'MDV changed repeatedly while applying the operation')
}

async function openExpected(file: string, expectedDocumentId: string): Promise<MdvDocument> {
  const document = await openMdv(file)
  if (document.manifest.documentId !== expectedDocumentId) {
    throw new ToolError('CONFLICT', 'The path now contains a different document; read it again before writing', {
      reason: 'document-changed',
      expectedDocumentId,
      actualDocumentId: document.manifest.documentId,
    })
  }
  return document
}

async function workingBaseline(document: MdvDocument, tree: TreeKind): Promise<TreeBaseline> {
  const source = tree === 'reference' ? await document.readReference() : await document.readDocument()
  return baseline(document, tree, source.bytes)
}

function baseline(document: MdvDocument, tree: TreeKind, bytes: Uint8Array): TreeBaseline {
  return {
    documentId: document.manifest.documentId,
    generation: document.manifest.generation,
    tree,
    head: tree === 'reference' ? document.referenceTree.head : document.documentTree.head,
    contentBytes: bytes.byteLength,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function assertCurrentBaseline(expected: TreeBaseline, actual: TreeBaseline, compareHead: boolean): void {
  if (actual.generation < expected.generation) {
    throw new ToolError('CONFLICT', 'MDV generation moved backwards; re-read before writing', {
      reason: 'generation-regressed',
      expectedGeneration: expected.generation,
      actualGeneration: actual.generation,
      tree: expected.tree,
    })
  }
  if (expected.contentBytes !== actual.contentBytes || expected.contentSha256 !== actual.contentSha256) {
    throw new ToolError('CONFLICT', `The MDV ${expected.tree} working copy changed after the baseline was read`, {
      reason: 'working-copy-changed',
      tree: expected.tree,
      expectedGeneration: expected.generation,
      actualGeneration: actual.generation,
      expectedContentBytes: expected.contentBytes,
      actualContentBytes: actual.contentBytes,
      expectedContentSha256: expected.contentSha256,
      actualContentSha256: actual.contentSha256,
    })
  }
  if (compareHead && expected.head !== actual.head) {
    throw new ToolError('CONFLICT', `The MDV ${expected.tree} HEAD changed after the baseline was read`, {
      reason: 'head-changed',
      tree: expected.tree,
      expectedGeneration: expected.generation,
      actualGeneration: actual.generation,
      expectedHead: expected.head,
      actualHead: actual.head,
    })
  }
}

function isRetryableTransactionConflict(error: unknown): error is MdvError {
  return error instanceof MdvError
    && error.code === 'CONFLICT'
    && error.details.committed !== true
    && (error.details.reason === 'locked'
      || (Number.isSafeInteger(error.details.expectedGeneration)
        && Number.isSafeInteger(error.details.actualGeneration)))
}

async function readExplicitFile(path: string, maxBytes: number): Promise<Uint8Array> {
  let file
  try { file = await open(path, 'r') }
  catch (cause) { throw new ToolError('IO_ERROR', `Could not open resource file: ${path}`, fileDetails(path, cause)) }
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new ToolError('INVALID_ARGUMENT', `Resource input is not a regular file: ${path}`)
    if (info.size > maxBytes) {
      throw new ToolError('LIMIT_EXCEEDED', `Resource exceeds ${maxBytes} bytes`, {
        path, maxBytes, actualBytes: info.size,
      })
    }
    const bytes = Buffer.alloc(info.size + 1)
    let used = 0
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, used)
      if (result.bytesRead === 0) break
      used += result.bytesRead
    }
    if (used !== info.size) {
      throw new ToolError('CONFLICT', 'Resource changed while it was being read; retry the explicit import', {
        path, expectedBytes: info.size, actualBytes: used,
      })
    }
    return bytes.subarray(0, used)
  } finally { await file.close() }
}

function fileDetails(path: string, cause: unknown): Readonly<Record<string, unknown>> {
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
    ? cause.code : undefined
  return { path, ...(code === undefined ? {} : { ioCode: code }) }
}

function checkTextBudget(text: string, name: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new ToolError('LIMIT_EXCEEDED', `${name} exceeds the output budget`)
  }
}

function decodeMarkdown(bytes: Uint8Array, name: string): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (text.charCodeAt(0) === 0xfeff) throw new TypeError('UTF-8 BOM is not allowed')
    return text
  }
  catch { throw new ToolError('INVALID_UTF8', `${name} working copy is not valid UTF-8`) }
}
