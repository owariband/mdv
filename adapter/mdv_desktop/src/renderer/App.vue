<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
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
const referenceEditor = shallowRef<EditorHandle>()
const documentEditor = shallowRef<EditorHandle>()
const sidebarWidth = ref(readSidebarWidth())
const worktreeHeight = ref(readWorktreeHeight())
const resizingSidebar = ref(false)
const resizingWorktree = ref(false)
let navigationSequence = 0
let workspaceSequence = 0
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
  && !opening.value
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
  if (opening.value || saving.value || workspaceLoading.value) return
  if (!confirmDocumentReplacement()) return

  const request = ++navigationSequence
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
  } finally {
    if (request === navigationSequence) opening.value = false
  }
}

async function selectWorkspace(): Promise<void> {
  if (workspaceLoading.value || opening.value || saving.value) return
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
  if (!current || workspaceLoading.value) return

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

async function selectWorkspaceNode(node: WorkspaceNodeView): Promise<void> {
  if (opening.value || saving.value) return
  if (node.kind === 'directory') return
  const currentWorkspace = workspace.value
  if (!currentWorkspace || !confirmDocumentReplacement()) return

  const request = ++navigationSequence
  opening.value = true
  clearMessages()
  try {
    const result = await window.mdvDesktop.openWorkspaceDocument({
      workspaceId: currentWorkspace.workspaceId,
      nodeId: node.id,
    })
    if (request !== navigationSequence) return
    if (!result.ok) {
      errorMessage.value = result.error.message
      return
    }
    activateDocument(result.value, node.id)
  } finally {
    if (request === navigationSequence) opening.value = false
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
  canonicalMarkdown: string
}): void {
  if (event.sessionId !== opened.value?.sessionId) return
  treeUi[event.tree].canonicalMarkdown = event.canonicalMarkdown
}

function onEditorChanged(event: { sessionId: string; tree: DesktopTree; revision: number }): void {
  if (event.sessionId !== opened.value?.sessionId) return
  treeUi[event.tree].editorDirty = true
  treeUi[event.tree].revision = event.revision
  if (event.tree === activeTree.value) clearMessages()
}

function onEditorFailed(event: { sessionId: string; message: string }): void {
  if (event.sessionId === opened.value?.sessionId) errorMessage.value = event.message
}

async function saveCurrent(): Promise<void> {
  const document = opened.value
  const editor = activeEditor.value
  if (!document || !editor || !canSave.value) return

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

function onKeyboard(event: KeyboardEvent): void {
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
  window.addEventListener('resize', fitWorktreeHeight)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyboard)
  window.removeEventListener('resize', fitWorktreeHeight)
})
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'is-resizing': resizingSidebar, 'is-resizing-worktree': resizingWorktree }"
    :style="shellStyle"
  >
    <aside class="tree-rail">
      <header class="sidebar-header">
        <span class="sidebar-title">Files</span>
      </header>

      <div class="sidebar-body">
        <div class="sidebar-explorer">
          <div
            v-if="workspace"
            class="workspace-tree"
            :class="{ 'is-busy': opening || saving }"
            role="tree"
            :aria-label="`${workspace.root.name} workspace`"
            :aria-busy="opening || saving"
          >
            <WorkspaceTreeNode
              v-for="node in workspace.root.children"
              :key="node.id"
              :node="node"
              :depth="0"
              :active-node-id="activeWorkspaceNodeId"
              @select="selectWorkspaceNode"
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

      <footer class="sidebar-footer">
        <button
          class="sidebar-open"
          :class="{ prominent: !workspace }"
          type="button"
          aria-label="Open a folder"
          :disabled="workspaceLoading || opening || saving"
          @click="selectWorkspace"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 18.5 6.2 9h14.3l-2.7 9.5H3.5Zm1.7-9.6V5.5h5l2 2h6.6v1.4" /></svg>
          <span>{{ workspaceLoading ? 'Opening…' : 'Open Folder…' }}</span>
        </button>
        <button
          v-if="workspace"
          class="sidebar-refresh tooltip-trigger"
          type="button"
          aria-label="Refresh folder"
          data-tooltip="Refresh"
          :disabled="workspaceLoading"
          @click="refreshWorkspace"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8V4l-2 2a7 7 0 1 0 1.1 10.3M19 4h-4" /></svg>
        </button>
      </footer>
    </aside>

    <div
      class="sidebar-resizer"
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

    <section class="writing-room">
      <header class="titlebar">
        <div class="titlebar-spacer" />
        <div class="document-title" :title="opened?.displayName ?? 'Untitled'">
          <span>{{ opened?.displayName ?? 'Untitled' }}</span>
          <i v-if="opened && hasAnyEditorDirty" aria-label="Unsaved" />
        </div>
        <div v-if="opened" class="window-actions">
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
          <button
            class="icon-button tooltip-trigger"
            type="button"
            aria-label="Open a document"
            data-tooltip="Open  ⌘O"
            :disabled="opening || saving || workspaceLoading"
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
        <div v-if="opened?.kind === 'mdv'" class="editor-stack mdv-dual-stack">
          <section
            class="editor-pane reference"
            :class="{ active: activeTree === 'reference' }"
            aria-label="Reference editor pane"
            @pointerdown.capture="focusTree('reference')"
            @focusin.capture="focusTree('reference')"
          >
            <span class="editor-pane-label" aria-hidden="true">REF</span>
            <MdvEditor
              :key="`${opened.sessionId}:reference`"
              ref="referenceEditor"
              class="editor-layer"
              :session-id="opened.sessionId"
              tree="reference"
              :initial-markdown="opened.reference.markdown"
              :read-only="false"
              @changed="onEditorChanged"
              @ready="onEditorReady"
              @failed="onEditorFailed"
            />
          </section>

          <section
            class="editor-pane document"
            :class="{ active: activeTree === 'document' }"
            aria-label="Document editor pane"
            @pointerdown.capture="focusTree('document')"
            @focusin.capture="focusTree('document')"
          >
            <span class="editor-pane-label" aria-hidden="true">DOC</span>
            <MdvEditor
              :key="`${opened.sessionId}:document`"
              ref="documentEditor"
              class="editor-layer"
              :session-id="opened.sessionId"
              tree="document"
              :initial-markdown="opened.document.markdown"
              :read-only="false"
              @changed="onEditorChanged"
              @ready="onEditorReady"
              @failed="onEditorFailed"
            />
          </section>
        </div>
        <div v-else-if="opened" class="editor-stack">
          <MdvEditor
            :key="`${opened.sessionId}:markdown`"
            ref="documentEditor"
            class="editor-layer"
            :session-id="opened.sessionId"
            tree="document"
            :initial-markdown="opened.markdown"
            :read-only="false"
            @changed="onEditorChanged"
            @ready="onEditorReady"
            @failed="onEditorFailed"
          />
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
  </main>
</template>
