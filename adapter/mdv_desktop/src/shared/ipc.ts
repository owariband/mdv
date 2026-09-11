export type DesktopTree = 'reference' | 'document'

export const ipcChannels = {
  openDocument: 'mdv-desktop:open-document',
  selectWorkspace: 'mdv-desktop:select-workspace',
  refreshWorkspace: 'mdv-desktop:refresh-workspace',
  openWorkspaceDocument: 'mdv-desktop:open-workspace-document',
  saveDocument: 'mdv-desktop:save-document',
  saveReference: 'mdv-desktop:save-reference',
  saveMarkdown: 'mdv-desktop:save-markdown',
} as const

export interface WorkspaceDirectoryView {
  readonly id: string
  readonly kind: 'directory'
  readonly name: string
  readonly children: readonly WorkspaceNodeView[]
  readonly truncated?: true
}

export interface WorkspaceFileView {
  readonly id: string
  readonly kind: 'mdv' | 'markdown'
  readonly name: string
}

export type WorkspaceNodeView = WorkspaceDirectoryView | WorkspaceFileView

export interface FolderWorkspaceView {
  readonly workspaceId: string
  readonly revision: number
  readonly root: WorkspaceDirectoryView
  readonly incomplete: boolean
}

export interface WorkspaceRequest {
  readonly workspaceId: string
}

export interface OpenWorkspaceDocumentRequest extends WorkspaceRequest {
  readonly nodeId: string
}

export interface TreeView {
  readonly markdown: string
  readonly head: string | null
  readonly workingCopyDirty: boolean
}

export interface VersionActorView {
  readonly type: 'human' | 'agent'
  readonly name?: string
}

interface VersionViewBase {
  readonly id: string
  readonly parent: string | null
  readonly createdAt: string
  readonly actor: VersionActorView
  readonly summary: string
}

export interface ReferenceVersionView extends VersionViewBase {
  readonly tree: 'reference'
}

export interface DocumentVersionView extends VersionViewBase {
  readonly tree: 'document'
  readonly referenceVersion: string | null
}

export interface VersionTreesView {
  readonly reference: readonly ReferenceVersionView[]
  readonly document: readonly DocumentVersionView[]
}

export type ReferenceRelationView =
  | { readonly kind: 'no-document-head' }
  | { readonly kind: 'unbound' }
  | { readonly kind: 'aligned'; readonly referenceVersion: string }
  | {
      readonly kind: 'drifted'
      readonly boundReference: string
      readonly currentReference: string | null
    }

export interface OpenedMdvView {
  readonly kind: 'mdv'
  readonly sessionId: string
  readonly displayName: string
  readonly documentId: string
  readonly generation: number
  readonly markdownProfile: string
  readonly reference: TreeView
  readonly document: TreeView
  readonly versions: VersionTreesView
  readonly referenceRelation: ReferenceRelationView
}

export interface OpenedMarkdownView {
  readonly kind: 'markdown'
  readonly sessionId: string
  readonly displayName: string
  readonly markdown: string
}

export type OpenedDocumentView = OpenedMdvView | OpenedMarkdownView

export interface SaveTreeRequest {
  readonly sessionId: string
  readonly markdown: string
  readonly revision: number
}

export interface SaveTreeResult {
  readonly tree: DesktopTree
  readonly generation: number
  readonly head: string | null
  readonly savedRevision: number
  readonly workingCopyDirty: boolean
  readonly staleTrees: readonly DesktopTree[]
}

export interface SaveMarkdownResult {
  readonly savedRevision: number
}

export interface DesktopFailure {
  readonly code: string
  readonly message: string
  readonly reason?: string
  readonly tree?: DesktopTree
  readonly committed?: boolean
}

export type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DesktopFailure }

export interface MdvDesktopApi {
  openDocument(): Promise<DesktopResult<OpenedDocumentView | null>>
  selectWorkspace(): Promise<DesktopResult<FolderWorkspaceView | null>>
  refreshWorkspace(request: WorkspaceRequest): Promise<DesktopResult<FolderWorkspaceView>>
  openWorkspaceDocument(request: OpenWorkspaceDocumentRequest): Promise<DesktopResult<OpenedDocumentView>>
  saveDocument(request: SaveTreeRequest): Promise<DesktopResult<SaveTreeResult>>
  saveReference(request: SaveTreeRequest): Promise<DesktopResult<SaveTreeResult>>
  saveMarkdown(request: SaveTreeRequest): Promise<DesktopResult<SaveMarkdownResult>>
}
