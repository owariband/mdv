import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
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

interface ScanState {
  scannedEntries: number
  returnedNodes: number
  incomplete: boolean
  readonly entries: Map<string, InternalNode>
}

export class FolderWorkspaceError extends Error {
  constructor(
    readonly code: 'ACCESS_DENIED' | 'INVALID_ARGUMENT' | 'LIMIT_EXCEEDED' | 'STALE_ENTRY' | 'STALE_WORKSPACE',
    message: string,
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

    const refresh = this.#scanAndSwap()
    this.#refreshing = refresh
    void refresh.finally(() => {
      if (this.#refreshing === refresh) this.#refreshing = undefined
    }).catch(() => undefined)
    return refresh
  }

  async resolveDocument(nodeId: string): Promise<ResolvedWorkspaceDocument> {
    if (typeof nodeId !== 'string' || !OPAQUE_NODE_ID.test(nodeId)) {
      throw staleEntry()
    }
    const entry = this.#entries.get(nodeId)
    if (!entry
      || (entry.kind !== 'mdv' && entry.kind !== 'markdown')
      || entry.segments.length === 0) throw staleEntry()

    try {
      const rootMetadata = await lstat(this.#rootPath)
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw staleEntry()
      let cursor = this.#rootPath
      for (const [index, segment] of entry.segments.entries()) {
        cursor = join(cursor, segment)
        const metadata = await lstat(cursor)
        const final = index === entry.segments.length - 1
        if (metadata.isSymbolicLink()
          || (final ? !metadata.isFile() : !metadata.isDirectory())) {
          throw staleEntry()
        }
      }

      const canonicalRoot = await realpath(this.#rootPath)
      const canonicalFile = await realpath(cursor)
      if (canonicalRoot !== this.#rootPath || !isWithin(this.#rootPath, canonicalFile)) {
        throw staleEntry()
      }
      return Object.freeze({ kind: entry.kind, path: canonicalFile })
    } catch (error) {
      if (error instanceof FolderWorkspaceError) throw error
      throw staleEntry()
    }
  }

  get view(): FolderWorkspaceView {
    if (!this.#view) throw new FolderWorkspaceError('STALE_WORKSPACE', 'The workspace is no longer available.')
    return this.#view
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

    const digest = createHmac('sha256', this.#nodeSecret)
      .update(kind)
      .update('\0')
      .update(segments.join('\0'))
      .digest('hex')
      .slice(0, 32)
    const id = `n_${digest}`
    const previous = state.entries.get(id)
    if (previous && (previous.kind !== kind || previous.segments.join('\0') !== segments.join('\0'))) {
      throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace index could not be created safely.')
    }
    state.entries.set(id, Object.freeze({ kind, segments: Object.freeze([...segments]) }))
    return id
  }
}

export function toWorkspaceFailure(error: unknown): DesktopFailure | undefined {
  if (!(error instanceof FolderWorkspaceError)) return undefined
  return { code: error.code, message: error.message }
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

function compareNodes(left: WorkspaceNodeView, right: WorkspaceNodeView): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (left.kind !== 'directory' && right.kind === 'directory') return 1
  const readableOrder = left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' })
  if (readableOrder !== 0) return readableOrder
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}
