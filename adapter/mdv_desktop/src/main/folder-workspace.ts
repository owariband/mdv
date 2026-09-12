import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants as fileSystemConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path'
import type {
  DesktopFailure,
  FolderWorkspaceView,
  WorkspaceDirectoryView,
  WorkspaceNodeView,
} from '../shared/ipc.js'

const MAX_DEPTH = 16
const MAX_SCANNED_ENTRIES = 20_000
const MAX_RETURNED_NODES = 5_000
const MAX_DUPLICATE_ATTEMPTS = 1_000
const OPAQUE_NODE_ID = /^n_[0-9a-f]{32}$/
const IGNORED_DIRECTORIES = new Set(['node_modules'])

type WorkspaceNodeKind = WorkspaceNodeView['kind']

interface InternalNode {
  readonly kind: WorkspaceNodeKind
  readonly segments: readonly string[]
}

export interface ResolvedWorkspaceDocument {
  readonly kind: 'mdv' | 'markdown'
  readonly path: string
}

export interface ResolvedWorkspaceNode {
  readonly kind: WorkspaceNodeKind
  readonly path: string
  readonly root: boolean
}

export interface FolderWorkspaceMutationResult {
  readonly view: FolderWorkspaceView
  readonly nodeId: string
}

interface ResolvedInternalNode extends ResolvedWorkspaceNode {
  readonly segments: readonly string[]
}

interface ScanState {
  scannedEntries: number
  returnedNodes: number
  incomplete: boolean
  readonly entries: Map<string, InternalNode>
}

export class FolderWorkspaceError extends Error {
  constructor(
    readonly code:
      | 'ACCESS_DENIED'
      | 'ALREADY_EXISTS'
      | 'INVALID_ARGUMENT'
      | 'IO_ERROR'
      | 'LIMIT_EXCEEDED'
      | 'STALE_ENTRY'
      | 'STALE_WORKSPACE',
    message: string,
    readonly committed = false,
    readonly activeDocumentInvalidated = false,
  ) {
    super(message)
    this.name = 'FolderWorkspaceError'
  }
}

export class FolderWorkspace {
  readonly id = randomUUID()
  readonly #rootPath: string
  readonly #nodeSecret = randomBytes(32)
  #revision = 0
  #entries: ReadonlyMap<string, InternalNode> = new Map()
  #view: FolderWorkspaceView | undefined
  #refreshing: Promise<FolderWorkspaceView> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  private constructor(rootPath: string) {
    this.#rootPath = rootPath
  }

  static async open(selectedPath: string): Promise<{
    workspace: FolderWorkspace
    view: FolderWorkspaceView
  }> {
    if (typeof selectedPath !== 'string' || !isAbsolute(selectedPath)) {
      throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The selected workspace is invalid.')
    }

    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(selectedPath)
      if (!(await stat(canonicalRoot)).isDirectory()) {
        throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The selected workspace is not a folder.')
      }
    } catch (error) {
      if (error instanceof FolderWorkspaceError) throw error
      throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace could not be opened.')
    }

    const workspace = new FolderWorkspace(canonicalRoot)
    return { workspace, view: await workspace.refresh() }
  }

  refresh(): Promise<FolderWorkspaceView> {
    if (this.#refreshing) return this.#refreshing

    const refresh = this.#run(() => this.#scanAndSwap())
    this.#refreshing = refresh
    void refresh.finally(() => {
      if (this.#refreshing === refresh) this.#refreshing = undefined
    }).catch(() => undefined)
    return refresh
  }

  refreshAfterExternalChange(): Promise<FolderWorkspaceView> {
    return this.#run(() => this.#scanAndSwap())
  }

  async resolveNode(nodeId: string): Promise<ResolvedWorkspaceNode> {
    const node = await this.#resolveNode(nodeId)
    return Object.freeze({ kind: node.kind, path: node.path, root: node.root })
  }

  async resolveDocument(nodeId: string): Promise<ResolvedWorkspaceDocument> {
    const node = await this.#resolveNode(nodeId)
    if ((node.kind !== 'mdv' && node.kind !== 'markdown') || node.root) throw staleEntry()
    return Object.freeze({ kind: node.kind, path: node.path })
  }

  createMarkdownFile(nodeId: string, name: string): Promise<FolderWorkspaceMutationResult> {
    const fileName = normalizeDocumentName(name, 'markdown')
    return this.#mutate('create the Markdown file', async () => {
      const target = await this.#resolveNode(nodeId)
      const parentSegments = target.kind === 'directory'
        ? target.segments
        : target.segments.slice(0, -1)
      const parentPath = await this.#resolveDirectory(parentSegments)
      await writeFile(join(parentPath, fileName), new Uint8Array(), { flag: 'wx', mode: 0o600 })
      return { kind: 'markdown', segments: [...parentSegments, fileName] }
    })
  }

  createDirectory(nodeId: string, name: string): Promise<FolderWorkspaceMutationResult> {
    const directoryName = normalizeEntryName(name)
    return this.#mutate('create the folder', async () => {
      const target = await this.#resolveNode(nodeId)
      const parentSegments = target.kind === 'directory'
        ? target.segments
        : target.segments.slice(0, -1)
      const parentPath = await this.#resolveDirectory(parentSegments)
      await mkdir(join(parentPath, directoryName), { mode: 0o700 })
      return { kind: 'directory', segments: [...parentSegments, directoryName] }
    })
  }

  renameEntry(nodeId: string, name: string): Promise<FolderWorkspaceMutationResult> {
    return this.#mutate('rename the workspace item', async () => {
      const target = await this.#resolveNode(nodeId)
      if (target.root) {
        throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace root cannot be renamed here.')
      }
      const nextName = target.kind === 'directory'
        ? normalizeEntryName(name)
        : normalizeDocumentName(name, target.kind)
      const previousName = target.segments.at(-1)
      if (!previousName) throw staleEntry()
      if (nextName === previousName) return { kind: target.kind, segments: target.segments }

      const parentSegments = target.segments.slice(0, -1)
      const parentPath = await this.#resolveDirectory(parentSegments)
      const nextPath = join(parentPath, nextName)
      await requireMissing(nextPath)
      await rename(target.path, nextPath)
      return { kind: target.kind, segments: [...parentSegments, nextName] }
    })
  }

  duplicateMarkdown(nodeId: string): Promise<FolderWorkspaceMutationResult> {
    return this.#mutate('duplicate the Markdown file', async () => {
      const target = await this.#resolveNode(nodeId)
      if (target.kind !== 'markdown' || target.root) {
        throw new FolderWorkspaceError(
          'INVALID_ARGUMENT',
          'Only Markdown files can be duplicated from the workspace menu.',
        )
      }
      const fileName = target.segments.at(-1)
      if (!fileName) throw staleEntry()
      const parentSegments = target.segments.slice(0, -1)
      const parentPath = await this.#resolveDirectory(parentSegments)

      for (let attempt = 1; attempt <= MAX_DUPLICATE_ATTEMPTS; attempt += 1) {
        const copyName = duplicateName(fileName, attempt)
        try {
          await copyFile(
            target.path,
            join(parentPath, copyName),
            fileSystemConstants.COPYFILE_EXCL,
          )
          return { kind: 'markdown', segments: [...parentSegments, copyName] }
        } catch (error) {
          if (fileSystemErrorCode(error) === 'EEXIST') continue
          throw error
        }
      }
      throw new FolderWorkspaceError(
        'ALREADY_EXISTS',
        'No available name could be found for the Markdown copy.',
      )
    })
  }

  async #resolveNode(nodeId: string): Promise<ResolvedInternalNode> {
    if (typeof nodeId !== 'string' || !OPAQUE_NODE_ID.test(nodeId)) throw staleEntry()
    const entry = this.#entries.get(nodeId)
    if (!entry) throw staleEntry()

    try {
      const rootMetadata = await lstat(this.#rootPath)
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw staleEntry()
      let cursor = this.#rootPath
      for (const [index, segment] of entry.segments.entries()) {
        cursor = join(cursor, segment)
        const metadata = await lstat(cursor)
        const final = index === entry.segments.length - 1
        if (metadata.isSymbolicLink()
          || (final
            ? entry.kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()
            : !metadata.isDirectory())) {
          throw staleEntry()
        }
      }

      const canonicalRoot = await realpath(this.#rootPath)
      const canonicalTarget = await realpath(cursor)
      const validLocation = entry.segments.length === 0
        ? canonicalTarget === this.#rootPath
        : isWithin(this.#rootPath, canonicalTarget)
      if (canonicalRoot !== this.#rootPath || !validLocation) {
        throw staleEntry()
      }
      return Object.freeze({
        kind: entry.kind,
        path: canonicalTarget,
        root: entry.segments.length === 0,
        segments: entry.segments,
      })
    } catch (error) {
      if (error instanceof FolderWorkspaceError) throw error
      throw staleEntry()
    }
  }

  get view(): FolderWorkspaceView {
    if (!this.#view) throw new FolderWorkspaceError('STALE_WORKSPACE', 'The workspace is no longer available.')
    return this.#view
  }

  #mutate(
    action: string,
    change: () => Promise<{ readonly kind: WorkspaceNodeKind; readonly segments: readonly string[] }>,
  ): Promise<FolderWorkspaceMutationResult> {
    return this.#run(async () => {
      let committed = false
      try {
        const changed = await change()
        committed = true
        const view = await this.#scanAndSwap()
        const nodeId = this.#nodeId(changed.kind, changed.segments)
        if (!this.#entries.has(nodeId)) {
          throw new FolderWorkspaceError(
            'IO_ERROR',
            'The workspace item was changed, but the folder could not display it.',
          )
        }
        return Object.freeze({ view, nodeId })
      } catch (error) {
        throw toMutationError(error, action, committed)
      }
    })
  }

  async #resolveDirectory(segments: readonly string[]): Promise<string> {
    const directoryPath = join(this.#rootPath, ...segments)
    try {
      const rootPath = await realpath(this.#rootPath)
      const metadata = await lstat(directoryPath)
      const canonicalPath = await realpath(directoryPath)
      const validLocation = segments.length === 0
        ? canonicalPath === this.#rootPath
        : isWithin(this.#rootPath, canonicalPath)
      if (rootPath !== this.#rootPath
        || metadata.isSymbolicLink()
        || !metadata.isDirectory()
        || !validLocation) throw staleEntry()
      return canonicalPath
    } catch (error) {
      if (error instanceof FolderWorkspaceError) throw error
      throw staleEntry()
    }
  }

  async #scanAndSwap(): Promise<FolderWorkspaceView> {
    const state: ScanState = {
      scannedEntries: 0,
      returnedNodes: 0,
      incomplete: false,
      entries: new Map(),
    }
    const root = await this.#scanDirectory(this.#rootPath, [], 0, state, true)
    if (!root) throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace could not be read.')

    const view: FolderWorkspaceView = Object.freeze({
      workspaceId: this.id,
      revision: this.#revision + 1,
      root,
      incomplete: state.incomplete,
    })
    this.#entries = state.entries
    this.#revision = view.revision
    this.#view = view
    return view
  }

  async #scanDirectory(
    directoryPath: string,
    segments: readonly string[],
    depth: number,
    state: ScanState,
    root: boolean,
  ): Promise<WorkspaceDirectoryView | undefined> {
    try {
      const metadata = await lstat(directoryPath)
      const canonicalPath = await realpath(directoryPath)
      const validLocation = root
        ? canonicalPath === this.#rootPath
        : isWithin(this.#rootPath, canonicalPath)
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || !validLocation) {
        if (root) throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace changed on disk.')
        return undefined
      }
    } catch (error) {
      if (error instanceof FolderWorkspaceError) throw error
      if (root) {
        throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace could not be read.')
      }
      state.incomplete = true
      return this.#directoryNode(segments, [], state, true)
    }

    if (depth >= MAX_DEPTH) {
      state.incomplete = true
      return this.#directoryNode(segments, [], state, true)
    }

    let directory
    try {
      directory = await opendir(directoryPath)
    } catch {
      if (root) {
        throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace could not be read.')
      }
      state.incomplete = true
      return this.#directoryNode(segments, [], state, true)
    }

    // Node does not expose an openat-style directory capability. Repeating the
    // check after opendir closes the ordinary rename/symlink window; a hostile
    // same-user process that continuously races path operations remains outside
    // the desktop workspace threat model.
    try {
      const metadata = await lstat(directoryPath)
      const canonicalPath = await realpath(directoryPath)
      const validLocation = root
        ? canonicalPath === this.#rootPath
        : isWithin(this.#rootPath, canonicalPath)
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || !validLocation) {
        await directory.close()
        if (root) throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace changed on disk.')
        return undefined
      }
    } catch (error) {
      await directory.close().catch(() => undefined)
      if (error instanceof FolderWorkspaceError) throw error
      if (root) throw new FolderWorkspaceError('ACCESS_DENIED', 'The selected workspace changed on disk.')
      state.incomplete = true
      return this.#directoryNode(segments, [], state, true)
    }

    const children: WorkspaceNodeView[] = []
    for await (const entry of directory) {
      state.scannedEntries += 1
      if (state.scannedEntries > MAX_SCANNED_ENTRIES) {
        throw new FolderWorkspaceError(
          'LIMIT_EXCEEDED',
          'The workspace is too large to display safely. Choose a smaller folder.',
        )
      }
      if (entry.name.startsWith('.')) continue

      const childSegments = [...segments, entry.name]
      const childPath = join(directoryPath, entry.name)
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        const child = await this.#scanDirectory(childPath, childSegments, depth + 1, state, false)
        if (child) children.push(child)
        continue
      }
      if (!entry.isFile()) continue

      const extension = extname(entry.name).toLowerCase()
      const kind = extension === '.mdv' ? 'mdv' : extension === '.md' ? 'markdown' : undefined
      if (!kind) continue
      try {
        const metadata = await lstat(childPath)
        if (metadata.isSymbolicLink() || !metadata.isFile()) continue
      } catch {
        state.incomplete = true
        continue
      }
      children.push(this.#fileNode(kind, childSegments, state))
    }

    children.sort(compareNodes)
    return this.#directoryNode(segments, children, state, false)
  }

  #directoryNode(
    segments: readonly string[],
    children: readonly WorkspaceNodeView[],
    state: ScanState,
    truncated: boolean,
  ): WorkspaceDirectoryView {
    const id = this.#register('directory', segments, state)
    const name = segments.at(-1) ?? (basename(this.#rootPath) || 'Workspace')
    return Object.freeze({
      id,
      kind: 'directory',
      name,
      children: Object.freeze([...children]),
      ...(truncated ? { truncated: true as const } : {}),
    })
  }

  #fileNode(
    kind: 'mdv' | 'markdown',
    segments: readonly string[],
    state: ScanState,
  ): WorkspaceNodeView {
    return Object.freeze({
      id: this.#register(kind, segments, state),
      kind,
      name: segments.at(-1) ?? 'Document',
    })
  }

  #register(kind: WorkspaceNodeKind, segments: readonly string[], state: ScanState): string {
    state.returnedNodes += 1
    if (state.returnedNodes > MAX_RETURNED_NODES) {
      throw new FolderWorkspaceError(
        'LIMIT_EXCEEDED',
        'The workspace contains too many documents to display safely.',
      )
    }

    const id = this.#nodeId(kind, segments)
    const previous = state.entries.get(id)
    if (previous && (previous.kind !== kind || previous.segments.join('\0') !== segments.join('\0'))) {
      throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace index could not be created safely.')
    }
    state.entries.set(id, Object.freeze({ kind, segments: Object.freeze([...segments]) }))
    return id
  }

  #nodeId(kind: WorkspaceNodeKind, segments: readonly string[]): string {
    const digest = createHmac('sha256', this.#nodeSecret)
      .update(kind)
      .update('\0')
      .update(segments.join('\0'))
      .digest('hex')
      .slice(0, 32)
    return `n_${digest}`
  }

  #run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action)
    this.#tail = result.catch(() => undefined)
    return result
  }
}

export function toWorkspaceFailure(error: unknown): DesktopFailure | undefined {
  if (!(error instanceof FolderWorkspaceError)) return undefined
  return {
    code: error.code,
    message: error.message,
    ...(error.committed ? { committed: true } : {}),
    ...(error.activeDocumentInvalidated ? { activeDocumentInvalidated: true } : {}),
  }
}

function isWithin(rootPath: string, candidate: string): boolean {
  const fromRoot = relative(rootPath, candidate)
  return fromRoot !== ''
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
}

function staleEntry(): FolderWorkspaceError {
  return new FolderWorkspaceError(
    'STALE_ENTRY',
    'The workspace item changed. Refresh the folder and try again.',
  )
}

function normalizeDocumentName(name: string, kind: 'mdv' | 'markdown'): string {
  const normalized = normalizeEntryName(name)
  const expectedExtension = kind === 'mdv' ? '.mdv' : '.md'
  const extension = extname(normalized)
  if (extension === '') return normalizeEntryName(`${normalized}${expectedExtension}`)
  if (extension.toLowerCase() !== expectedExtension) {
    throw new FolderWorkspaceError(
      'INVALID_ARGUMENT',
      `The file name must use the ${expectedExtension} extension.`,
    )
  }
  return normalized
}

function normalizeEntryName(value: string): string {
  if (typeof value !== 'string') {
    throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace item name is invalid.')
  }
  const name = value.trim()
  if (name === ''
    || name === '.'
    || name === '..'
    || name.startsWith('.')
    || name.endsWith('.')
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
    || Buffer.byteLength(name, 'utf8') > 255) {
    throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace item name is invalid.')
  }
  return name
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') return
    throw error
  }
  throw new FolderWorkspaceError('ALREADY_EXISTS', 'A workspace item with that name already exists.')
}

function duplicateName(fileName: string, attempt: number): string {
  const extension = extname(fileName)
  const stem = fileName.slice(0, -extension.length)
  const suffix = attempt === 1 ? ' copy' : ` copy ${attempt}`
  return `${stem}${suffix}${extension}`
}

function toMutationError(error: unknown, action: string, committed: boolean): FolderWorkspaceError {
  if (committed) {
    return new FolderWorkspaceError(
      'IO_ERROR',
      'The workspace item was changed, but the folder could not be refreshed.',
      true,
    )
  }
  if (error instanceof FolderWorkspaceError) return error

  const code = fileSystemErrorCode(error)
  if (code === 'EEXIST') {
    return new FolderWorkspaceError('ALREADY_EXISTS', 'A workspace item with that name already exists.')
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') return staleEntry()
  if (code === 'EACCES' || code === 'EPERM') {
    return new FolderWorkspaceError('ACCESS_DENIED', `The workspace could not ${action}.`)
  }
  if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
    return new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace item name is invalid.')
  }
  return new FolderWorkspaceError('IO_ERROR', `The workspace could not ${action}.`)
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function compareNodes(left: WorkspaceNodeView, right: WorkspaceNodeView): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (left.kind !== 'directory' && right.kind === 'directory') return 1
  const readableOrder = left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
  if (readableOrder !== 0) return readableOrder
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}
