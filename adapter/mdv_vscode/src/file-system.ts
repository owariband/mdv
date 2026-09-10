import { createHash } from 'node:crypto'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import * as vscode from 'vscode'
import { MdvError } from '@owariband/mdv'
import { DocumentSessions, type DocumentSession } from './document-session.js'
import { parseImageResource, parseSource, requireSource } from './uri.js'

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024

export class MdvFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  readonly #events = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.#events.event
  readonly #subscription: vscode.Disposable
  readonly #mtimes = new Map<string, { hash: string; mtime: number }>()

  constructor(private readonly sessions: DocumentSessions) {
    this.#subscription = sessions.onDidChange((uris) => this.#events.fire(
      uris.filter((uri) => uri.scheme === 'mdv').map((uri) => ({ type: vscode.FileChangeType.Changed, uri })),
    ))
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const source = parseSource(uri) ?? parseImageResource(uri)
    return source ? this.sessions.retain(source.packageUri, source.documentId) : new vscode.Disposable(() => undefined)
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const source = parseSource(uri)
    if (source) {
      const bytes = await this.sessions.read(uri, false)
      const key = uri.with({ fragment: '' }).toString()
      const hash = createHash('sha256').update(bytes).digest('hex')
      let clock = this.#mtimes.get(key)
      if (!clock || clock.hash !== hash) {
        clock = { hash, mtime: Math.max(Date.now(), (clock?.mtime ?? 0) + 1) }
        this.#mtimes.set(key, clock)
      }
      const readonly = source.content.kind === 'version' || !vscode.workspace.isTrusted
      return {
        type: vscode.FileType.File, ctime: 1, mtime: clock.mtime,
        size: bytes.byteLength, ...(readonly ? { permissions: vscode.FilePermission.Readonly } : {}),
      }
    }
    const { path } = await this.resource(uri)
    const value = await stat(path)
    return { type: value.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: value.ctimeMs, mtime: value.mtimeMs, size: value.size, permissions: vscode.FilePermission.Readonly }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      if (parseSource(uri)) return await this.sessions.read(uri, true)
      const { session, path, requestedPath } = await this.resource(uri)
      const local = relative(session.document.baseDirectory, requestedPath).split(sep).join('/')
      if (local.startsWith('.mdv-assets/')) {
        const resource = await session.document.readManagedResource(`./${local}`)
        return resource.bytes
      }
      return await readResourceFile(path)
    } catch (error) {
      throw filesystemError(error)
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { path } = await this.resource(uri)
    const entries = await readdir(path, { withFileTypes: true })
    return entries.slice(0, 10_000).filter((entry) => !entry.isSymbolicLink())
      .map((entry) => [entry.name, entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File])
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
    requireSource(uri)
    try { await this.sessions.save(uri, content) }
    catch (error) { throw filesystemError(error) }
  }

  createDirectory(): never { throw vscode.FileSystemError.NoPermissions('MDV only exposes its existing Ref/Doc working copies.') }
  delete(): never { throw vscode.FileSystemError.NoPermissions('MDV history and resources cannot be deleted through virtual documents.') }
  rename(): never { throw vscode.FileSystemError.NoPermissions('Rename the real .mdv file after closing its editors.') }

  dispose(): void { this.#subscription.dispose(); this.#events.dispose() }

  private async resource(uri: vscode.Uri): Promise<{ session: DocumentSession; path: string; requestedPath: string }> {
    const proxy = parseImageResource(uri)
    const session = proxy
      ? await this.sessions.get(proxy.packageUri, proxy.documentId)
      : await this.sessions.findResourceSession(uri)
    if (!session) throw vscode.FileSystemError.NoPermissions('Open the owning MDV document before reading its resources.')
    const target = proxy?.target ?? uri.with({ scheme: 'file', authority: '', query: '', fragment: '' })
    const root = session.document.baseDirectory
    const configured = vscode.workspace.isTrusted
      ? vscode.workspace.getConfiguration('mdv', session.packageUri).get<string[]>('additionalResourceRoots', []) : []
    const roots = [root, ...configured.map((path) => resolve(root, path))]
    const path = await realpath(target.fsPath)
    let allowed = false
    for (const candidate of roots) {
      try {
        const resolved = await realpath(candidate)
        const inside = relative(resolved, path)
        if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) allowed = true
      } catch { /* A missing allowed directory does not grant access. */ }
    }
    if (!allowed) throw vscode.FileSystemError.NoPermissions('Resource is outside the MDV directory. Explicitly allow its directory in mdv.additionalResourceRoots.')
    return { session, path, requestedPath: target.fsPath }
  }
}

export async function readResourceFile(path: string): Promise<Uint8Array> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw vscode.FileSystemError.FileIsADirectory(path)
    if (info.size > MAX_RESOURCE_BYTES) throw new Error('MDV resource exceeds the 32 MiB adapter limit.')
    const buffer = Buffer.alloc(info.size + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > info.size) throw new Error('Resource changed while it was being read; retry the explicit operation.')
    return buffer.subarray(0, used)
  } finally { await file.close() }
}

function filesystemError(error: unknown): Error {
  if (error instanceof vscode.FileSystemError) return error
  if (error instanceof MdvError) {
    if (error.code === 'NOT_FOUND') return vscode.FileSystemError.FileNotFound(error.message)
    return vscode.FileSystemError.Unavailable(`${error.code}: ${error.message}${error.details.committed === true ? ' (The write may already be saved; reopen before retrying.)' : ''}`)
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return vscode.FileSystemError.FileNotFound(error.message)
  return vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error))
}
