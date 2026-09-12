<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import MdvEditor from './components/MdvEditor.vue'
import VersionGraph from './components/VersionGraph.vue'
import WorkspaceTreeNode from './components/WorkspaceTreeNode.vue'
import type { EditorCapture } from './editor/types.js'
import type {
  DesktopTree,
  FolderWorkspaceView,
  OpenedDocumentView,
  OpenedMdvView,
  SaveTreeRequest,
  WorkspaceActionRequest,
  WorkspaceContextAction,
  WorkspaceNodeView,
} from '../shared/ipc.js'

interface EditorHandle {
  capture(): EditorCapture
}

interface TreeUiState {
  editorDirty: boolean
  workingCopyDirty: boolean
  revision: number
  originalMarkdown: string
  canonicalMarkdown: string
}

interface WorkspaceNodeContextRequest {
  readonly node: WorkspaceNodeView
  readonly clientX: number
  readonly clientY: number
  readonly trigger: HTMLElement
}

type NamedWorkspaceAction = Extract<
  WorkspaceContextAction,
  'new-file' | 'new-folder' | 'rename'
>

interface WorkspaceNameRequest extends WorkspaceNodeContextRequest {
  readonly action: NamedWorkspaceAction
  readonly title: string
  readonly confirmLabel: string
  readonly initialValue: string
}

interface WorkspaceNodeStep {
  readonly kind: WorkspaceNodeView['kind']
  readonly name: string
}

const sidebarStorageKey = 'mdv.desktop.sidebar-width'
const defaultSidebarWidth = 286
const minimumSidebarWidth = 190
const maximumSidebarWidth = 480
const worktreeHeightStorageKey = 'mdv.desktop.worktree-height'
const defaultWorktreeHeight = 170
const minimumWorktreeHeight = 82
const maximumWorktreeHeight = 560

const opened = ref<OpenedDocumentView>()
const workspace = ref<FolderWorkspaceView>()
const activeWorkspaceNodeId = ref<string>()
const activeTree = ref<DesktopTree>('document')
const opening = ref(false)
const workspaceLoading = ref(false)
const saving = ref(false)
const notice = ref('')
const errorMessage = ref('')
const comparisonOpen = ref(false)
const worktreeExpanded = ref(true)
const workspaceMenuOpen = ref(false)
const workspaceMenu = ref<HTMLElement>()
const workspaceMenuButton = ref<HTMLButtonElement>()
const workspaceMenuToggle = ref<HTMLButtonElement>()
const workspaceNameRequest = shallowRef<WorkspaceNameRequest>()
const workspaceNameInput = ref<HTMLInputElement>()
const workspaceActionRunning = ref(false)
const referenceEditor = shallowRef<EditorHandle>()
const documentEditor = shallowRef<EditorHandle>()
const sidebarWidth = ref(readSidebarWidth())
const worktreeHeight = ref(readWorktreeHeight())
const viewportRevision = ref(0)
const resizingSidebar = ref(false)
const resizingWorktree = ref(false)
let navigationSequence = 0
let workspaceSequence = 0
let workspaceContextSequence = 0
let workspaceNameResolver: ((name: string | null) => void) | undefined
let pendingEditorSessionId: string | undefined
const pendingEditorTrees = new Set<DesktopTree>()
let worktreeResizeStartY = 0
let worktreeResizeStartHeight = defaultWorktreeHeight
const treeUi = reactive<Record<DesktopTree, TreeUiState>>({
  reference: emptyTreeState(),
  document: emptyTreeState(),
})

const activeUi = computed(() => treeUi[
  opened.value?.kind === 'markdown' ? 'document' : activeTree.value
])
const activeEditor = computed(() => activeTree.value === 'reference'
  ? referenceEditor.value
  : documentEditor.value)
const canSave = computed(() => Boolean(
  opened.value
  && activeEditor.value
  && activeUi.value.editorDirty
  && !saving.value
))
const hasAnyEditorDirty = computed(() => Boolean(
  opened.value?.kind === 'markdown'
    ? treeUi.document.editorDirty
    : treeUi.reference.editorDirty || treeUi.document.editorDirty,
))
const hasNormalization = computed(() => (
  activeUi.value.originalMarkdown !== activeUi.value.canonicalMarkdown
))
const shellStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
  '--worktree-height': `${worktreeHeight.value}px`,
}))
const workspaceNamePopoverStyle = computed(() => {
  void viewportRevision.value
  const request = workspaceNameRequest.value
  if (!request) return undefined
  const edge = 12
  const width = Math.min(286, window.innerWidth - edge * 2)
  const height = 150
  return {
    left: `${Math.max(edge, Math.min(request.clientX, window.innerWidth - width - edge))}px`,
    top: `${Math.max(edge, Math.min(request.clientY, window.innerHeight - height - edge))}px`,
  }
})

function readSidebarWidth(): number {
  const value = Number.parseInt(window.localStorage.getItem('mdv.desktop.sidebar-width') ?? '', 10)
  return Number.isFinite(value)
    ? Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, value))
    : defaultSidebarWidth
}

function setSidebarWidth(width: number): void {
  sidebarWidth.value = Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, width))
}

function beginSidebarResize(event: PointerEvent): void {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  resizingSidebar.value = true
  handle.setPointerCapture(event.pointerId)
  setSidebarWidth(event.clientX)
}

function resizeSidebar(event: PointerEvent): void {
  if (resizingSidebar.value) setSidebarWidth(event.clientX)
}

function finishSidebarResize(event: PointerEvent): void {
  if (!resizingSidebar.value) return
  const handle = event.currentTarget as HTMLElement
  resizingSidebar.value = false
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  window.localStorage.setItem(sidebarStorageKey, String(sidebarWidth.value))
}

function resizeSidebarWithKeyboard(event: KeyboardEvent): void {
  const amount = event.shiftKey ? 32 : 12
  if (event.key === 'ArrowLeft') setSidebarWidth(sidebarWidth.value - amount)
  else if (event.key === 'ArrowRight') setSidebarWidth(sidebarWidth.value + amount)
  else if (event.key === 'Home') setSidebarWidth(minimumSidebarWidth)
  else if (event.key === 'End') setSidebarWidth(maximumSidebarWidth)
  else return
  event.preventDefault()
  window.localStorage.setItem(sidebarStorageKey, String(sidebarWidth.value))
}

function resetSidebarWidth(): void {
  sidebarWidth.value = defaultSidebarWidth
  window.localStorage.setItem(sidebarStorageKey, String(defaultSidebarWidth))
}

function readWorktreeHeight(): number {
  const value = Number.parseInt(window.localStorage.getItem(worktreeHeightStorageKey) ?? '', 10)
  return Number.isFinite(value) ? clampWorktreeHeight(value) : defaultWorktreeHeight
}

function clampWorktreeHeight(height: number): number {
  const available = Math.max(minimumWorktreeHeight, window.innerHeight - 184)
  return Math.min(maximumWorktreeHeight, available, Math.max(minimumWorktreeHeight, height))
}

function setWorktreeHeight(height: number): void {
  worktreeHeight.value = clampWorktreeHeight(height)
}

function beginWorktreeResize(event: PointerEvent): void {
  if (event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  worktreeExpanded.value = true
  resizingWorktree.value = true
  worktreeResizeStartY = event.clientY
  worktreeResizeStartHeight = worktreeHeight.value
  handle.setPointerCapture(event.pointerId)
}

function resizeWorktree(event: PointerEvent): void {
  if (!resizingWorktree.value) return
  setWorktreeHeight(worktreeResizeStartHeight + worktreeResizeStartY - event.clientY)
}

function finishWorktreeResize(event: PointerEvent): void {
  if (!resizingWorktree.value) return
  const handle = event.currentTarget as HTMLElement
  resizingWorktree.value = false
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  window.localStorage.setItem(worktreeHeightStorageKey, String(worktreeHeight.value))
}

function resizeWorktreeWithKeyboard(event: KeyboardEvent): void {
  const amount = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowUp') setWorktreeHeight(worktreeHeight.value + amount)
  else if (event.key === 'ArrowDown') setWorktreeHeight(worktreeHeight.value - amount)
  else if (event.key === 'Home') setWorktreeHeight(minimumWorktreeHeight)
  else if (event.key === 'End') setWorktreeHeight(maximumWorktreeHeight)
  else return
  worktreeExpanded.value = true
  event.preventDefault()
  window.localStorage.setItem(worktreeHeightStorageKey, String(worktreeHeight.value))
}

function resetWorktreeHeight(): void {
  worktreeHeight.value = clampWorktreeHeight(defaultWorktreeHeight)
  window.localStorage.setItem(worktreeHeightStorageKey, String(worktreeHeight.value))
}

function fitWorktreeHeight(): void {
  setWorktreeHeight(worktreeHeight.value)
}

function onWindowResize(): void {
  fitWorktreeHeight()
  viewportRevision.value += 1
}

function emptyTreeState(): TreeUiState {
  return {
    editorDirty: false,
    workingCopyDirty: false,
    revision: 0,
    originalMarkdown: '',
    canonicalMarkdown: '',
  }
}

async function openDocument(): Promise<void> {
  if (opening.value || saving.value || workspaceLoading.value || workspaceActionRunning.value) return
  if (!confirmDocumentReplacement()) return

  const request = ++navigationSequence
  let activated = false
  opening.value = true
  clearMessages()
  try {
    const result = await window.mdvDesktop.openDocument()
    if (request !== navigationSequence) return
    if (!result.ok) {
      errorMessage.value = result.error.message
      return
    }
    if (!result.value) return

    activateDocument(result.value, undefined)
    activated = true
  } finally {
    if (request === navigationSequence && !activated) finishOpening()
  }
}

async function selectWorkspace(): Promise<void> {
  if (workspaceLoading.value || opening.value || saving.value || workspaceActionRunning.value) return
  workspaceMenuOpen.value = false
  const request = ++workspaceSequence
  workspaceLoading.value = true
  clearMessages()
  try {
    const result = await window.mdvDesktop.selectWorkspace()
    if (request !== workspaceSequence) return
    if (!result.ok) {
      errorMessage.value = result.error.message
      return
    }
    if (!result.value) return
    workspace.value = result.value
    activeWorkspaceNodeId.value = undefined
    if (result.value.incomplete) {
      notice.value = 'Folder opened. Some nested entries could not be displayed.'
    }
  } finally {
    if (request === workspaceSequence) workspaceLoading.value = false
  }
}

async function refreshWorkspace(): Promise<void> {
  const current = workspace.value
  if (!current || workspaceLoading.value || opening.value || workspaceActionRunning.value) return

  const request = ++workspaceSequence
  workspaceLoading.value = true
  clearMessages()
  try {
    const result = await window.mdvDesktop.refreshWorkspace({ workspaceId: current.workspaceId })
    if (request !== workspaceSequence) return
    if (!result.ok) {
      errorMessage.value = result.error.message
      return
    }
    workspace.value = result.value
    if (result.value.incomplete) {
      notice.value = 'Folder refreshed with some nested entries omitted.'
    }
  } finally {
    if (request === workspaceSequence) workspaceLoading.value = false
  }
}

async function openWorkspaceContextMenu(request: WorkspaceNodeContextRequest): Promise<void> {
  const currentWorkspace = workspace.value
  if (!currentWorkspace
    || opening.value
    || saving.value
    || workspaceLoading.value
    || workspaceActionRunning.value
    || workspaceNameRequest.value) return

  const sequence = ++workspaceContextSequence
  const result = await window.mdvDesktop.showWorkspaceContextMenu({
    workspaceId: currentWorkspace.workspaceId,
    nodeId: request.node.id,
  })
  if (sequence !== workspaceContextSequence
    || workspace.value?.workspaceId !== currentWorkspace.workspaceId) return
  if (!result.ok) {
    errorMessage.value = result.error.message
    return
  }

  const action = result.value
  if (!action) return
  if (action === 'open') {
    await selectWorkspaceNode(request.node)
    return
  }
  await runWorkspaceContextAction(currentWorkspace, request, action)
}

async function runWorkspaceContextAction(
  currentWorkspace: FolderWorkspaceView,
  context: WorkspaceNodeContextRequest,
  action: Exclude<WorkspaceContextAction, 'open'>,
): Promise<void> {
  if (opening.value || saving.value || workspaceLoading.value || workspaceActionRunning.value) return

  let name: string | undefined
  if (action === 'new-file' || action === 'new-folder' || action === 'rename') {
    const requestedName = await requestWorkspaceName(context, action)
    if (requestedName === null) return
    name = requestedName
  }

  const activeTrail = activeWorkspaceNodeId.value
    ? descendantTrail(context.node, activeWorkspaceNodeId.value)
    : undefined
  const dirtyEditorCouldBeAffected = hasAnyEditorDirty.value
    && (activeTrail !== undefined || activeWorkspaceNodeId.value === undefined)
  if (action === 'rename'
    && dirtyEditorCouldBeAffected
    && !window.confirm(
      `Rename “${context.node.name}”? If this item is open, its unsaved editor text will be discarded.`,
    )) return
  if (action === 'move-to-trash') {
    const dirtyWarning = dirtyEditorCouldBeAffected
      ? ' Any unsaved editor text in this item will be discarded.'
      : ''
    if (!window.confirm(`Move “${context.node.name}” to Trash?${dirtyWarning}`)) return
  }

  const ipcRequest = buildWorkspaceActionRequest(
    currentWorkspace.workspaceId,
    context.node.id,
    action,
    name,
  )

  workspaceActionRunning.value = true
  clearMessages()
  try {
    const result = await window.mdvDesktop.runWorkspaceAction(ipcRequest)
    if (!result.ok) {
      errorMessage.value = result.error.message
      if (result.error.committed) {
        await recoverWorkspaceAfterCommittedAction(currentWorkspace)
        if ((action === 'rename' || action === 'move-to-trash')
          && (result.error.activeDocumentInvalidated || activeTrail !== undefined)) {
          clearOpenedDocument()
        }
      }
      return
    }

    const updatedWorkspace = result.value.workspace
    if (updatedWorkspace) workspace.value = updatedWorkspace
    const activeDocumentAffected = result.value.activeDocumentInvalidated === true
      || activeTrail !== undefined

    if (action === 'rename' && activeDocumentAffected) {
      resetEditorDirtyState()
      const renamedTarget = updatedWorkspace && result.value.nodeId
        ? findWorkspaceNode(updatedWorkspace.root, result.value.nodeId)
        : undefined
      const renamedActiveNode = renamedTarget && activeTrail !== undefined
        ? followWorkspaceTrail(renamedTarget, activeTrail)
        : renamedTarget
      if (renamedActiveNode && renamedActiveNode.kind !== 'directory') {
        activeWorkspaceNodeId.value = undefined
        const reopened = await selectWorkspaceNode(renamedActiveNode, true)
        if (!reopened) clearOpenedDocument()
      } else {
        clearOpenedDocument()
      }
    } else if (action === 'move-to-trash' && activeDocumentAffected) {
      clearOpenedDocument()
    }

    if (action === 'new-file') {
      const created = updatedWorkspace && result.value.nodeId
        ? findWorkspaceNode(updatedWorkspace.root, result.value.nodeId)
        : undefined
      if (!hasAnyEditorDirty.value && created && created.kind === 'markdown') {
        await selectWorkspaceNode(created, true)
      }
      notice.value = `Created ${created?.name ?? 'the Markdown file'}.`
    } else if (action === 'new-folder') {
      const created = updatedWorkspace && result.value.nodeId
        ? findWorkspaceNode(updatedWorkspace.root, result.value.nodeId)
        : undefined
      notice.value = `Created ${created?.name ?? 'the folder'}.`
    } else if (action === 'duplicate') {
      const duplicate = updatedWorkspace && result.value.nodeId
        ? findWorkspaceNode(updatedWorkspace.root, result.value.nodeId)
        : undefined
      notice.value = `Created ${duplicate?.name ?? 'a Markdown copy'}.`
    } else if (action === 'rename') {
      const renamed = updatedWorkspace && result.value.nodeId
        ? findWorkspaceNode(updatedWorkspace.root, result.value.nodeId)
        : undefined
      notice.value = `Renamed to ${renamed?.name ?? name}.`
    } else if (action === 'move-to-trash') {
      notice.value = `Moved ${context.node.name} to Trash.`
    } else if (action === 'copy-path') {
      notice.value = 'Path copied.'
    } else if (action === 'show-in-finder') {
      notice.value = 'Shown in Finder.'
    }
  } finally {
    workspaceActionRunning.value = false
  }
}

function buildWorkspaceActionRequest(
  workspaceId: string,
  nodeId: string,
  action: Exclude<WorkspaceContextAction, 'open'>,
  name: string | undefined,
): WorkspaceActionRequest {
  if (action === 'new-file' || action === 'new-folder' || action === 'rename') {
    if (name === undefined) throw new Error('The workspace action requires a name')
    return { workspaceId, nodeId, action, name }
  }
  return { workspaceId, nodeId, action }
}

function requestWorkspaceName(
  context: WorkspaceNodeContextRequest,
  action: NamedWorkspaceAction,
): Promise<string | null> {
  const copy = action === 'new-file'
    ? { title: 'New Markdown file', confirmLabel: 'Create', initialValue: 'Untitled.md' }
    : action === 'new-folder'
      ? { title: 'New folder', confirmLabel: 'Create', initialValue: 'Untitled Folder' }
      : { title: 'Rename item', confirmLabel: 'Rename', initialValue: context.node.name }

  finishWorkspaceNameRequest(null)
  workspaceNameRequest.value = { ...context, action, ...copy }
  return new Promise((resolve) => {
    workspaceNameResolver = resolve
    void nextTick(() => {
      const input = workspaceNameInput.value
      if (!input) return
      input.focus()
      const extensionStart = action === 'rename' && context.node.kind !== 'directory'
        ? context.node.name.lastIndexOf('.')
        : -1
      if (extensionStart > 0) input.setSelectionRange(0, extensionStart)
      else input.select()
    })
  })
}

function submitWorkspaceNameRequest(): void {
  const name = workspaceNameInput.value?.value.trim()
  if (name) finishWorkspaceNameRequest(name)
}

function trapWorkspaceNameFocus(event: KeyboardEvent): void {
  const form = event.currentTarget
  if (!(form instanceof HTMLFormElement)) return
  const controls = [...form.querySelectorAll<HTMLElement>('input, button')]
    .filter((control) => !control.hasAttribute('disabled'))
  if (controls.length === 0) return
  const current = controls.indexOf(document.activeElement as HTMLElement)
  const next = event.shiftKey
    ? current <= 0 ? controls.at(-1) : controls[current - 1]
    : current === -1 || current === controls.length - 1 ? controls[0] : controls[current + 1]
  if (!next) return
  event.preventDefault()
  next.focus()
}

function finishWorkspaceNameRequest(name: string | null): void {
  const trigger = workspaceNameRequest.value?.trigger
  const resolve = workspaceNameResolver
  workspaceNameResolver = undefined
  workspaceNameRequest.value = undefined
  resolve?.(name)
  if (trigger) {
    void nextTick(() => {
      if (trigger.isConnected) trigger.focus()
    })
  }
}

async function recoverWorkspaceAfterCommittedAction(
  previousWorkspace: FolderWorkspaceView,
): Promise<void> {
  const result = await window.mdvDesktop.refreshWorkspace({
    workspaceId: previousWorkspace.workspaceId,
  })
  if (result.ok) workspace.value = result.value
}

function resetEditorDirtyState(): void {
  treeUi.reference.editorDirty = false
  treeUi.document.editorDirty = false
}

function clearOpenedDocument(): void {
  navigationSequence += 1
  finishOpening()
  opened.value = undefined
  activeWorkspaceNodeId.value = undefined
  activeTree.value = 'document'
  comparisonOpen.value = false
  treeUi.reference = emptyTreeState()
  treeUi.document = emptyTreeState()
}

function findWorkspaceNode(
  node: WorkspaceNodeView,
  nodeId: string,
): WorkspaceNodeView | undefined {
  if (node.id === nodeId) return node
  if (node.kind !== 'directory') return undefined
  for (const child of node.children) {
    const match = findWorkspaceNode(child, nodeId)
    if (match) return match
  }
  return undefined
}

function descendantTrail(
  node: WorkspaceNodeView,
  descendantId: string,
): readonly WorkspaceNodeStep[] | undefined {
  if (node.id === descendantId) return []
  if (node.kind !== 'directory') return undefined
  for (const child of node.children) {
    const trail = descendantTrail(child, descendantId)
    if (trail) return [{ kind: child.kind, name: child.name }, ...trail]
  }
  return undefined
}

function followWorkspaceTrail(
  start: WorkspaceNodeView,
  trail: readonly WorkspaceNodeStep[],
): WorkspaceNodeView | undefined {
  let current = start
  for (const step of trail) {
    if (current.kind !== 'directory') return undefined
    const next = current.children.find((child) => (
      child.kind === step.kind && child.name === step.name
    ))
    if (!next) return undefined
    current = next
  }
  return current
}

async function selectWorkspaceNode(
  node: WorkspaceNodeView,
  allowDuringWorkspaceAction = false,
): Promise<boolean> {
  if (saving.value || (workspaceActionRunning.value && !allowDuringWorkspaceAction)) return false
  if (node.kind === 'directory') return false
  const currentWorkspace = workspace.value
  if (!currentWorkspace || !confirmDocumentReplacement()) return false

  const request = ++navigationSequence
  let activated = false
  opening.value = true
  try {
    const result = await window.mdvDesktop.openWorkspaceDocument({
      workspaceId: currentWorkspace.workspaceId,
      nodeId: node.id,
    })
    if (request !== navigationSequence) return false
    if (!result.ok) {
      errorMessage.value = result.error.message
      return false
    }
    clearMessages()
    activateDocument(result.value, node.id)
    activated = true
    return true
  } finally {
    if (request === navigationSequence && !activated) finishOpening()
  }
}

function confirmDocumentReplacement(): boolean {
  const dirty = opened.value?.kind === 'markdown'
    ? treeUi.document.editorDirty
    : treeUi.reference.editorDirty || treeUi.document.editorDirty
  if (!dirty) return true
  return window.confirm('Open another document and discard the unsaved editor text?')
}

function activateDocument(document: OpenedDocumentView, workspaceNodeId: string | undefined): void {
  pendingEditorSessionId = document.sessionId
  pendingEditorTrees.clear()
  pendingEditorTrees.add('document')
  if (document.kind === 'mdv') pendingEditorTrees.add('reference')
  opened.value = document
  activeWorkspaceNodeId.value = workspaceNodeId
  activeTree.value = 'document'
  comparisonOpen.value = false
  if (document.kind === 'mdv') {
    resetTree('reference', document)
    resetTree('document', document)
  } else {
    treeUi.reference = emptyTreeState()
    treeUi.document = {
      editorDirty: false,
      workingCopyDirty: false,
      revision: 0,
      originalMarkdown: document.markdown,
      canonicalMarkdown: document.markdown,
    }
  }
}

function resetTree(tree: DesktopTree, document: OpenedMdvView): void {
  const source = document[tree]
  treeUi[tree] = {
    editorDirty: false,
    workingCopyDirty: source.workingCopyDirty,
    revision: 0,
    originalMarkdown: source.markdown,
    canonicalMarkdown: source.markdown,
  }
}

function activateTree(tree: DesktopTree): void {
  activeTree.value = tree
  comparisonOpen.value = false
  clearMessages()
}

function focusTree(tree: DesktopTree): void {
  if (activeTree.value === tree) return
  activateTree(tree)
}

function treeStateLabel(tree: DesktopTree): string {
  if (treeUi[tree].editorDirty) return 'Unsaved'
  return 'Uncommitted'
}

function onEditorReady(event: {
  sessionId: string
  tree: DesktopTree
}): void {
  if (event.sessionId !== opened.value?.sessionId) return
  if (event.sessionId !== pendingEditorSessionId) return
  pendingEditorTrees.delete(event.tree)
  if (pendingEditorTrees.size === 0) finishOpening()
}

function onEditorCanonicalized(event: {
  sessionId: string
  tree: DesktopTree
  canonicalMarkdown: string
}): void {
  if (event.sessionId === opened.value?.sessionId) {
    treeUi[event.tree].canonicalMarkdown = event.canonicalMarkdown
  }
}

function onEditorChanged(event: { sessionId: string; tree: DesktopTree; revision: number }): void {
  if (event.sessionId !== opened.value?.sessionId) return
  treeUi[event.tree].editorDirty = true
  treeUi[event.tree].revision = event.revision
  if (event.tree === activeTree.value) clearMessages()
}

function onEditorFailed(event: { sessionId: string; message: string }): void {
  if (event.sessionId !== opened.value?.sessionId) return
  errorMessage.value = event.message
  if (event.sessionId === pendingEditorSessionId) finishOpening()
}

function finishOpening(): void {
  pendingEditorSessionId = undefined
  pendingEditorTrees.clear()
  opening.value = false
}

async function saveCurrent(): Promise<void> {
  const document = opened.value
  const editor = activeEditor.value
  if (!document
    || !editor
    || !canSave.value
    || opening.value
    || workspaceActionRunning.value) return

  const capture = editor.capture()
  const request: SaveTreeRequest = {
    sessionId: document.sessionId,
    markdown: capture.markdown,
    revision: capture.revision,
  }

  saving.value = true
  clearMessages()
  try {
    if (document.kind === 'markdown') {
      const result = await window.mdvDesktop.saveMarkdown(request)
      if (!result.ok) {
        errorMessage.value = result.error.message
        return
      }

      const now = editor.capture()
      treeUi.document.editorDirty = !(
        now.revision === capture.revision && now.markdown === capture.markdown
      )
      treeUi.document.originalMarkdown = capture.markdown
      treeUi.document.canonicalMarkdown = capture.markdown
      notice.value = 'Markdown file saved.'
      return
    }

    const tree = activeTree.value
    const result = tree === 'reference'
      ? await window.mdvDesktop.saveReference(request)
      : await window.mdvDesktop.saveDocument(request)
    if (!result.ok) {
      if (result.error.code === 'USER_CANCELLED') notice.value = result.error.message
      else errorMessage.value = result.error.message
      return
    }

    const now = editor.capture()
    treeUi[tree].editorDirty = !(
      now.revision === capture.revision && now.markdown === capture.markdown
    )
    treeUi[tree].workingCopyDirty = result.value.workingCopyDirty
    treeUi[tree].originalMarkdown = capture.markdown
    treeUi[tree].canonicalMarkdown = capture.markdown
    opened.value = updateOpenedDocument(document, tree, result.value.generation, result.value.head)

    notice.value = result.value.staleTrees.length === 0
      ? `${treeName(tree)} working copy saved. No version was created.`
      : `${treeName(tree)} saved. ${result.value.staleTrees.map(treeName).join(' and ')} changed outside this editor; reopen before editing it.`
  } finally {
    saving.value = false
  }
}

function updateOpenedDocument(
  document: OpenedMdvView,
  tree: DesktopTree,
  generation: number,
  head: string | null,
): OpenedMdvView {
  const updatedTree = {
    ...document[tree],
    head,
    workingCopyDirty: treeUi[tree].workingCopyDirty,
  }
  return tree === 'reference'
    ? { ...document, generation, reference: updatedTree }
    : { ...document, generation, document: updatedTree }
}

function showComparison(): void {
  comparisonOpen.value = true
}

function closeComparison(): void {
  comparisonOpen.value = false
}

function treeName(tree: DesktopTree): string {
  return tree === 'reference' ? 'Reference' : 'Document'
}

function shortHead(head: string | null): string {
  return head ? head.replace(/^v_/, '').slice(0, 7) : '—'
}

function clearMessages(): void {
  notice.value = ''
  errorMessage.value = ''
}

function closeWorkspaceMenu(restoreFocus = false): void {
  workspaceMenuOpen.value = false
  if (restoreFocus) workspaceMenuButton.value?.focus()
}

function onWindowPointerDown(event: PointerEvent): void {
  if (!workspaceMenuOpen.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (
    workspaceMenu.value?.contains(target)
    || workspaceMenuButton.value?.contains(target)
    || workspaceMenuToggle.value?.contains(target)
  ) return
  workspaceMenuOpen.value = false
}

function onKeyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape' && workspaceNameRequest.value) {
    event.preventDefault()
    finishWorkspaceNameRequest(null)
    return
  }
  if (workspaceNameRequest.value) {
    if ((event.metaKey || event.ctrlKey)
      && (event.key.toLowerCase() === 'o' || event.key.toLowerCase() === 's')) {
      event.preventDefault()
    }
    return
  }
  if (event.key === 'Escape' && workspaceMenuOpen.value) {
    event.preventDefault()
    closeWorkspaceMenu(true)
    return
  }
  if (!(event.metaKey || event.ctrlKey)) return
  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveCurrent()
  } else if (event.key.toLowerCase() === 'o') {
    event.preventDefault()
    if (event.shiftKey) void selectWorkspace()
    else void openDocument()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyboard)
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => {
  finishWorkspaceNameRequest(null)
  window.removeEventListener('keydown', onKeyboard)
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'is-resizing': resizingSidebar, 'is-resizing-worktree': resizingWorktree }"
    :style="shellStyle"
  >
    <aside class="tree-rail" :inert="Boolean(workspaceNameRequest)">
      <header class="sidebar-header">
        <span class="sidebar-title">Files</span>
      </header>

      <div class="sidebar-body">
        <div class="sidebar-explorer">
          <div
            v-if="workspace"
            class="workspace-tree"
            :class="{ 'is-busy': saving }"
            role="tree"
            :aria-label="`${workspace.root.name} workspace`"
            :aria-busy="saving"
          >
            <WorkspaceTreeNode
              v-for="node in workspace.root.children"
              :key="node.id"
              :node="node"
              :depth="0"
              :active-node-id="activeWorkspaceNodeId"
              @select="selectWorkspaceNode"
              @context="openWorkspaceContextMenu"
            />
            <p v-if="workspace.root.children.length === 0" class="workspace-empty">
              No Markdown documents or folders
            </p>
            <p v-if="workspace.incomplete" class="workspace-limit-note">
              Some entries are hidden by workspace safety limits.
            </p>
          </div>
        </div>

        <div
          v-if="opened?.kind === 'mdv'"
          class="active-document-panel"
          :class="{ collapsed: !worktreeExpanded }"
        >
          <div
            class="worktree-resizer"
            role="separator"
            aria-label="Resize Worktree"
            aria-orientation="horizontal"
            :aria-valuemin="minimumWorktreeHeight"
            :aria-valuemax="maximumWorktreeHeight"
            :aria-valuenow="worktreeHeight"
            tabindex="0"
            @pointerdown="beginWorktreeResize"
            @pointermove="resizeWorktree"
            @pointerup="finishWorktreeResize"
            @pointercancel="finishWorktreeResize"
            @lostpointercapture="finishWorktreeResize"
            @keydown="resizeWorktreeWithKeyboard"
            @dblclick="resetWorktreeHeight"
          />
          <section class="worktree-section">
            <button
              class="worktree-toggle"
              type="button"
              :aria-expanded="worktreeExpanded"
              aria-controls="mdv-worktree"
              @click="worktreeExpanded = !worktreeExpanded"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
              <span>Worktree</span>
              <i
                v-if="treeUi.reference.editorDirty || treeUi.document.editorDirty"
                class="worktree-attention"
                aria-label="Worktree needs attention"
              />
            </button>

            <div v-show="worktreeExpanded" id="mdv-worktree" class="worktree-content">
              <div class="worktree-grid" role="tablist" aria-label="MDV worktree">
                <div class="tree-column reference" :class="{ active: activeTree === 'reference' }">
                  <button
                    class="tree-button"
                    type="button"
                    role="tab"
                    aria-label="Reference working copy"
                    :aria-selected="activeTree === 'reference'"
                    @click="activateTree('reference')"
                  >
                    <span class="tree-label">
                      <span class="tree-code">REF</span>
                      <small :aria-label="`${opened.versions.reference.length} Reference versions`">
                        {{ opened.versions.reference.length }}
                      </small>
                    </span>
                    <span
                      v-if="treeUi.reference.editorDirty || treeUi.reference.workingCopyDirty"
                      class="tree-state"
                    >
                      <i :class="{ dirty: treeUi.reference.editorDirty }" />
                      {{ treeStateLabel('reference') }}
                    </span>
                    <span class="tree-head"><b>HEAD</b>{{ shortHead(opened.reference.head) }}</span>
                  </button>
                </div>

                <div class="tree-column document" :class="{ active: activeTree === 'document' }">
                  <button
                    class="tree-button"
                    type="button"
                    role="tab"
                    aria-label="Document working copy"
                    :aria-selected="activeTree === 'document'"
                    @click="activateTree('document')"
                  >
                    <span class="tree-label">
                      <span class="tree-code">DOC</span>
                      <small :aria-label="`${opened.versions.document.length} Document versions`">
                        {{ opened.versions.document.length }}
                      </small>
                    </span>
                    <span
                      v-if="treeUi.document.editorDirty || treeUi.document.workingCopyDirty"
                      class="tree-state"
                    >
                      <i :class="{ dirty: treeUi.document.editorDirty }" />
                      {{ treeStateLabel('document') }}
                    </span>
                    <span class="tree-head"><b>HEAD</b>{{ shortHead(opened.document.head) }}</span>
                  </button>
                </div>
              </div>

              <VersionGraph :document="opened" />

              <button
                v-if="hasNormalization"
                class="normalization-button"
                type="button"
                @click="showComparison"
              >
                <i aria-hidden="true" />
                <span>Markdown rewritten · Review</span>
              </button>
            </div>
          </section>
        </div>
      </div>

      <Transition name="workspace-drawer">
        <section
          v-if="workspaceMenuOpen"
          id="workspace-drawer"
          ref="workspaceMenu"
          class="workspace-drawer"
          aria-label="Workspace actions"
        >
          <header class="workspace-drawer-header">
            <span>Workspace</span>
            <button
              type="button"
              aria-label="Close workspace menu"
              @click="closeWorkspaceMenu(true)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <path d="m9.5 9.5 5 5m0-5-5 5" />
              </svg>
            </button>
          </header>

          <div class="workspace-drawer-actions">
            <button
              type="button"
              aria-label="Open a folder"
              :disabled="workspaceLoading || saving"
              @click="selectWorkspace"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 18.5 6.2 9h14.3l-2.7 9.5H3.5Zm1.7-9.6V5.5h5l2 2h6.6v1.4" />
              </svg>
              <span>Open Folder…</span>
              <kbd>⇧⌘O</kbd>
            </button>
            <button
              v-if="workspace"
              type="button"
              aria-label="Refresh folder"
              :disabled="workspaceLoading"
              @click="refreshWorkspace"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 8V4l-2 2a7 7 0 1 0 1.1 10.3M19 4h-4" />
              </svg>
              <span>{{ workspaceLoading ? 'Refreshing…' : 'Refresh' }}</span>
            </button>
          </div>

          <div v-if="workspace" class="workspace-drawer-current">
            <span>Current folder</span>
            <div>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 18V7h7l2 2h9v9z" />
              </svg>
              <b :title="workspace.root.name">{{ workspace.root.name }}</b>
              <i aria-label="Current workspace" />
            </div>
          </div>
        </section>
      </Transition>

      <footer class="sidebar-footer">
        <button
          class="sidebar-folder-button"
          type="button"
          aria-label="Open a folder"
          :disabled="workspaceLoading || saving"
          @click="selectWorkspace"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 18.5 6.2 9h14.3l-2.7 9.5H3.5Zm1.7-9.6V5.5h5l2 2h6.6v1.4" />
          </svg>
        </button>
        <button
          ref="workspaceMenuButton"
          class="sidebar-workspace-button"
          type="button"
          :aria-label="`Workspace: ${workspace?.root.name ?? 'No folder open'}`"
          :aria-expanded="workspaceMenuOpen"
          aria-controls="workspace-drawer"
          @click="workspaceMenuOpen = !workspaceMenuOpen"
        >
          <span>{{ workspaceLoading ? 'Opening…' : workspace?.root.name ?? 'No folder open' }}</span>
        </button>
        <button
          ref="workspaceMenuToggle"
          class="sidebar-menu-button"
          type="button"
          aria-label="Workspace menu"
          :aria-expanded="workspaceMenuOpen"
          aria-controls="workspace-drawer"
          @click="workspaceMenuOpen = !workspaceMenuOpen"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="19" r="1" />
          </svg>
        </button>
      </footer>
    </aside>

    <div
      class="sidebar-resizer"
      :inert="Boolean(workspaceNameRequest)"
      role="separator"
      aria-label="Resize file sidebar"
      aria-orientation="vertical"
      :aria-valuemin="minimumSidebarWidth"
      :aria-valuemax="maximumSidebarWidth"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      @pointerdown="beginSidebarResize"
      @pointermove="resizeSidebar"
      @pointerup="finishSidebarResize"
      @pointercancel="finishSidebarResize"
      @lostpointercapture="finishSidebarResize"
      @keydown="resizeSidebarWithKeyboard"
      @dblclick="resetSidebarWidth"
    />

    <section class="writing-room" :inert="Boolean(workspaceNameRequest)">
      <header class="titlebar">
        <div class="titlebar-spacer" />
        <div class="document-title" :title="opened?.displayName ?? 'Untitled'">
          <span>{{ opened?.displayName ?? 'Untitled' }}</span>
          <i v-if="opened && hasAnyEditorDirty" aria-label="Unsaved" />
        </div>
        <div v-if="opened" class="window-actions">
          <span class="window-action-slot">
            <button
              v-if="opened.kind === 'markdown' && hasNormalization"
              class="icon-button normalization-action tooltip-trigger"
              type="button"
              aria-label="Review Markdown rewrite"
              data-tooltip="Review rewrite"
              @click="showComparison"
            >
              <svg viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Zm0 6v4.5m0 2.8v.2" /></svg>
            </button>
          </span>
          <button
            class="icon-button tooltip-trigger"
            type="button"
            aria-label="Open a document"
            data-tooltip="Open  ⌘O"
            :disabled="saving || workspaceLoading"
            @click="openDocument"
          >
            <svg viewBox="0 0 24 24"><path d="M3.5 18.5 6.2 9h14.3l-2.7 9.5H3.5Zm1.7-9.6V5.5h5l2 2h6.6v1.4" /></svg>
          </button>
          <button
            class="icon-button save-action tooltip-trigger"
            :class="{ reference: opened.kind === 'mdv' && activeTree === 'reference' }"
            type="button"
            :aria-label="opened.kind === 'mdv' ? `Save ${treeName(activeTree)} working copy` : 'Save Markdown file'"
            :data-tooltip="opened.kind === 'mdv' ? `Save ${treeName(activeTree)}  ⌘S` : 'Save  ⌘S'"
            :disabled="!canSave"
            @click="saveCurrent"
          >
            <svg viewBox="0 0 24 24"><path d="M5 3.5h12l2 2v15H5zM8 3.5v6h8v-6M8 20.5v-7h8v7" /></svg>
          </button>
        </div>
      </header>

      <div class="editor-stage">
        <div
          v-if="opened"
          class="editor-stack"
          :class="{ 'mdv-dual-stack': opened.kind === 'mdv' }"
        >
          <section
            v-if="opened.kind === 'mdv'"
            key="reference"
            class="editor-pane reference"
            :class="{ active: activeTree === 'reference' }"
            aria-label="Reference editor pane"
            @pointerdown.capture="focusTree('reference')"
            @focusin.capture="focusTree('reference')"
          >
            <span class="editor-pane-label" aria-hidden="true">REF</span>
            <MdvEditor
              ref="referenceEditor"
              class="editor-layer"
              :session-id="opened.sessionId"
              tree="reference"
              :initial-markdown="opened.reference.markdown"
              :read-only="opening || workspaceActionRunning"
              @changed="onEditorChanged"
              @ready="onEditorReady"
              @canonicalized="onEditorCanonicalized"
              @failed="onEditorFailed"
            />
          </section>

          <section
            key="document"
            class="editor-pane document"
            :class="{
              active: activeTree === 'document',
              single: opened.kind === 'markdown',
            }"
            aria-label="Document editor pane"
            @pointerdown.capture="focusTree('document')"
            @focusin.capture="focusTree('document')"
          >
            <span v-if="opened.kind === 'mdv'" class="editor-pane-label" aria-hidden="true">DOC</span>
            <MdvEditor
              ref="documentEditor"
              class="editor-layer"
              :session-id="opened.sessionId"
              tree="document"
              :initial-markdown="opened.kind === 'mdv' ? opened.document.markdown : opened.markdown"
              :read-only="opening || workspaceActionRunning"
              @changed="onEditorChanged"
              @ready="onEditorReady"
              @canonicalized="onEditorCanonicalized"
              @failed="onEditorFailed"
            />
          </section>
        </div>
        <div v-else class="empty-document" aria-label="No document open" />
      </div>

      <footer
        v-if="errorMessage || notice"
        class="statusbar"
        :class="{ danger: Boolean(errorMessage) }"
        role="status"
        aria-live="polite"
      >
        <span>{{ errorMessage || notice }}</span>
      </footer>
    </section>

    <div v-if="comparisonOpen" class="modal-backdrop" @click.self="closeComparison">
      <section class="comparison-dialog" role="dialog" aria-modal="true" aria-label="Milkdown rewrite comparison">
        <header>
          <div>
            <p class="eyebrow">Milkdown canonical Markdown</p>
            <h2>What changes before your first save</h2>
          </div>
          <button class="dialog-button" type="button" @click="closeComparison">Close</button>
        </header>
        <p class="comparison-note">
          This comparison is informational. Once you edit and save, the right-hand form becomes the saved Markdown.
        </p>
        <div class="comparison-grid">
          <article>
            <h3>Original Markdown</h3>
            <pre>{{ activeUi.originalMarkdown }}</pre>
          </article>
          <article>
            <h3>Milkdown output</h3>
            <pre>{{ activeUi.canonicalMarkdown }}</pre>
          </article>
        </div>
      </section>
    </div>

    <div
      v-if="workspaceNameRequest"
      class="workspace-name-layer"
      @pointerdown.self="finishWorkspaceNameRequest(null)"
    >
      <form
        class="workspace-name-popover"
        :style="workspaceNamePopoverStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="workspaceNameRequest.title"
        @submit.prevent="submitWorkspaceNameRequest"
        @keydown.tab="trapWorkspaceNameFocus"
      >
        <label for="workspace-item-name">{{ workspaceNameRequest.title }}</label>
        <input
          id="workspace-item-name"
          ref="workspaceNameInput"
          name="workspace-item-name"
          :value="workspaceNameRequest.initialValue"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <div>
          <button type="button" @click="finishWorkspaceNameRequest(null)">Cancel</button>
          <button class="primary" type="submit">{{ workspaceNameRequest.confirmLabel }}</button>
        </div>
      </form>
    </div>
  </main>
</template>
