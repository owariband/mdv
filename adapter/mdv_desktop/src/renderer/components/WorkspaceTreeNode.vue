<script setup lang="ts">
import { ref } from 'vue'
import type { WorkspaceNodeView } from '../../shared/ipc.js'

interface WorkspaceNodeContextRequest {
  readonly node: WorkspaceNodeView
  readonly clientX: number
  readonly clientY: number
  readonly trigger: HTMLElement
}

const props = defineProps<{
  node: WorkspaceNodeView
  depth: number
  activeNodeId: string | undefined
}>()

const emit = defineEmits<{
  select: [node: WorkspaceNodeView]
  context: [request: WorkspaceNodeContextRequest]
}>()

const expanded = ref(false)

function showContextMenu(event: MouseEvent): void {
  const trigger = event.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  emit('context', {
    node: props.node,
    clientX: event.clientX,
    clientY: event.clientY,
    trigger,
  })
}

function showContextMenuFromKeyboard(event: KeyboardEvent): void {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
  const trigger = event.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  event.preventDefault()
  event.stopPropagation()
  const bounds = trigger.getBoundingClientRect()
  emit('context', {
    node: props.node,
    clientX: bounds.left + Math.min(32, bounds.width / 2),
    clientY: bounds.top + bounds.height / 2,
    trigger,
  })
}
</script>

<template>
  <div class="workspace-node">
    <template v-if="node.kind === 'directory'">
      <button
        class="workspace-row directory"
        type="button"
        role="treeitem"
        aria-haspopup="menu"
        :style="{ '--tree-depth': depth }"
        :aria-expanded="expanded"
        :title="node.name"
        @click="expanded = !expanded"
        @contextmenu.prevent.stop="showContextMenu"
        @keydown="showContextMenuFromKeyboard"
      >
        <svg class="workspace-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m5 3 5 5-5 5" />
        </svg>
        <svg class="workspace-kind-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 6.5h6l2 2h9v10h-17z" />
        </svg>
        <span>{{ node.name }}</span>
        <i v-if="node.truncated" class="workspace-truncated" title="This folder reached the scan depth limit">…</i>
      </button>
      <div v-show="expanded" class="workspace-children" role="group">
        <WorkspaceTreeNode
          v-for="child in node.children"
          :key="child.id"
          :node="child"
          :depth="depth + 1"
          :active-node-id="activeNodeId"
          @select="emit('select', $event)"
          @context="emit('context', $event)"
        />
      </div>
    </template>

    <button
      v-else
      class="workspace-row file"
      :class="[node.kind, { active: node.id === activeNodeId }]"
      type="button"
      role="treeitem"
      aria-haspopup="menu"
      :style="{ '--tree-depth': depth }"
      :aria-label="node.name"
      :title="node.name"
      @click="emit('select', node)"
      @contextmenu.prevent.stop="showContextMenu"
      @keydown="showContextMenuFromKeyboard"
    >
      <span class="workspace-chevron" aria-hidden="true" />
      <svg class="workspace-kind-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4" />
      </svg>
      <span>{{ node.name }}</span>
    </button>
  </div>
</template>
