<script setup lang="ts">
import { ref } from 'vue'
import type { WorkspaceNodeView } from '../../shared/ipc.js'

const props = defineProps<{
  node: WorkspaceNodeView
  depth: number
  activeNodeId: string | undefined
}>()

const emit = defineEmits<{
  select: [node: WorkspaceNodeView]
}>()

const expanded = ref(false)
</script>

<template>
  <div class="workspace-node">
    <template v-if="node.kind === 'directory'">
      <button
        class="workspace-row directory"
        type="button"
        role="treeitem"
        :style="{ '--tree-depth': depth }"
        :aria-expanded="expanded"
        :title="node.name"
        @click="expanded = !expanded"
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
        />
      </div>
    </template>

    <button
      v-else
      class="workspace-row file"
      :class="[node.kind, { active: node.id === activeNodeId }]"
      type="button"
      role="treeitem"
      :style="{ '--tree-depth': depth }"
      :aria-label="node.name"
      :title="node.name"
      @click="emit('select', node)"
    >
      <span class="workspace-chevron" aria-hidden="true" />
      <svg class="workspace-kind-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4" />
      </svg>
      <span>{{ node.name }}</span>
    </button>
  </div>
</template>
