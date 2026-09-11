<script setup lang="ts">
import { computed } from 'vue'
import type {
  DocumentVersionView,
  OpenedMdvView,
  ReferenceVersionView,
} from '../../shared/ipc.js'

type VersionView = ReferenceVersionView | DocumentVersionView

interface VersionNode<T extends VersionView> {
  readonly version: T
  readonly row: number
  readonly lane: number
}

const rowHeight = 36
const props = defineProps<{
  document: OpenedMdvView
}>()

const referenceNodes = computed(() => layoutVersions(props.document.versions.reference))
const documentNodes = computed(() => layoutVersions(props.document.versions.document))
const allNodes = computed(() => [...referenceNodes.value, ...documentNodes.value])
const graphHeight = computed(() => (
  Math.max(referenceNodes.value.length, documentNodes.value.length, 1) * rowHeight
))
const positions = computed(() => new Map(allNodes.value.map((node) => [
  node.version.id,
  nodePosition(node),
])))
const parentEdges = computed(() => allNodes.value.flatMap((node) => {
  const from = positions.value.get(node.version.id)
  const to = node.version.parent ? positions.value.get(node.version.parent) : undefined
  return from && to ? [{
    id: `${node.version.id}:${node.version.parent}`,
    tree: node.version.tree,
    path: curve(from, to),
  }] : []
}))
const bindEdges = computed(() => documentNodes.value.flatMap((node) => {
  const reference = node.version.referenceVersion
  const from = positions.value.get(node.version.id)
  const to = reference ? positions.value.get(reference) : undefined
  return from && to ? [{
    document: node.version.id,
    reference,
    path: `M${from.x - 1.4},${from.y} C50,${from.y} 50,${to.y} ${to.x + 1.4},${to.y}`,
  }] : []
}))
const railSpace = computed(() => ({
  reference: `${18 + maximumLane(referenceNodes.value) * 8}px`,
  document: `${18 + maximumLane(documentNodes.value) * 8}px`,
}))
const bindSummary = computed(() => {
  const relation = props.document.referenceRelation
  const documentHead = shortVersion(props.document.document.head)
  if (relation.kind === 'no-document-head') return 'BIND  —'
  if (relation.kind === 'unbound') return `BIND  DOC ${documentHead} → UNBOUND`
  if (relation.kind === 'aligned') {
    return `BIND  DOC ${documentHead} → REF ${shortVersion(relation.referenceVersion)}`
  }
  return `BIND  DOC ${documentHead} → REF ${shortVersion(relation.boundReference)} · REF HEAD ${shortVersion(relation.currentReference)}`
})

function layoutVersions<T extends VersionView>(versions: readonly T[]): readonly VersionNode<T>[] {
  const byId = new Map(versions.map((version) => [version.id, version]))
  const childCounts = new Map(versions.map((version) => [version.id, 0]))
  for (const version of versions) {
    if (version.parent && childCounts.has(version.parent)) {
      childCounts.set(version.parent, (childCounts.get(version.parent) ?? 0) + 1)
    }
  }

  const newestFirst = (left: T, right: T): number => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
  )
  const ready = versions.filter((version) => childCounts.get(version.id) === 0).sort(newestFirst)
  const lanes: (string | null)[] = []
  const nodes: VersionNode<T>[] = []

  while (ready.length > 0) {
    const version = ready.shift()
    if (!version) break
    let lane = lanes.indexOf(version.id)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
    }
    nodes.push({ version, row: nodes.length, lane })
    lanes[lane] = version.parent && !lanes.includes(version.parent) ? version.parent : null

    if (!version.parent || !byId.has(version.parent)) continue
    const remaining = (childCounts.get(version.parent) ?? 1) - 1
    childCounts.set(version.parent, remaining)
    if (remaining === 0) {
      const parent = byId.get(version.parent)
      if (!parent) continue
      const index = ready.findIndex((entry) => newestFirst(parent, entry) < 0)
      ready.splice(index < 0 ? ready.length : index, 0, parent)
    }
  }
  return nodes
}

function nodePosition(node: VersionNode<VersionView>): { x: number; y: number } {
  const direction = node.version.tree === 'reference' ? -1 : 1
  return {
    x: 50 + direction * (2.7 + node.lane * 2.8),
    y: node.row * rowHeight + rowHeight / 2,
  }
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return `M${from.x},${from.y} C${from.x},${from.y + rowHeight / 2} ${to.x},${to.y - rowHeight / 2} ${to.x},${to.y}`
}

function maximumLane(nodes: readonly VersionNode<VersionView>[]): number {
  return Math.max(0, ...nodes.map((node) => node.lane))
}

function shortVersion(version: string | null): string {
  return version ? version.replace(/^v_/, '').slice(0, 7) : '—'
}

function versionTitle(version: VersionView): string {
  const actor = version.actor.name ?? version.actor.type
  const binding = version.tree === 'document'
    ? `\nBind: ${version.referenceVersion ?? 'unbound'}`
    : ''
  return `${version.summary}\n${version.id}\n${version.createdAt} · ${actor}${binding}`
}
</script>

<template>
  <div class="version-history" role="group" aria-label="Reference and Document version history">
    <div
      class="version-graph"
      :style="{ height: `${graphHeight}px` }"
      :aria-label="`${document.versions.reference.length} Reference versions and ${document.versions.document.length} Document versions`"
    >
      <svg class="version-edges" :viewBox="`0 0 100 ${graphHeight}`" preserveAspectRatio="none" aria-hidden="true">
        <path
          v-for="edge in parentEdges"
          :key="edge.id"
          class="version-edge parent"
          :class="edge.tree"
          :d="edge.path"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-for="edge in bindEdges"
          :key="edge.document"
          class="version-edge bind"
          :d="edge.path"
          :data-doc="edge.document"
          :data-ref="edge.reference"
          vector-effect="non-scaling-stroke"
        />
        <circle
          v-for="node in allNodes"
          :key="node.version.id"
          class="version-dot"
          :class="[
            node.version.tree,
            { head: document[node.version.tree].head === node.version.id },
          ]"
          :cx="positions.get(node.version.id)?.x"
          :cy="positions.get(node.version.id)?.y"
          :r="document[node.version.tree].head === node.version.id ? 1.65 : 1.15"
          vector-effect="non-scaling-stroke"
        />
      </svg>

      <span v-if="referenceNodes.length === 0" class="version-empty reference">No versions</span>
      <span v-if="documentNodes.length === 0" class="version-empty document">No versions</span>

      <div
        v-for="node in referenceNodes"
        :key="node.version.id"
        class="version-node reference"
        role="listitem"
        :class="{ head: document.reference.head === node.version.id }"
        :style="{ top: `${node.row * rowHeight}px`, paddingRight: railSpace.reference }"
        :title="versionTitle(node.version)"
      >
        <span class="version-summary">{{ node.version.summary }}</span>
        <span class="version-meta">
          {{ shortVersion(node.version.id) }}
          <b v-if="document.reference.head === node.version.id">HEAD</b>
        </span>
      </div>

      <div
        v-for="node in documentNodes"
        :key="node.version.id"
        class="version-node document"
        role="listitem"
        :class="{ head: document.document.head === node.version.id }"
        :style="{ top: `${node.row * rowHeight}px`, paddingLeft: railSpace.document }"
        :title="versionTitle(node.version)"
      >
        <span class="version-summary">{{ node.version.summary }}</span>
        <span class="version-meta">
          {{ shortVersion(node.version.id) }}
          <template v-if="node.version.referenceVersion">
            → {{ shortVersion(node.version.referenceVersion) }}
          </template>
          <template v-else>· unbound</template>
          <b v-if="document.document.head === node.version.id">HEAD</b>
        </span>
      </div>
    </div>
    <p class="bind-summary" :title="bindSummary">{{ bindSummary }}</p>
  </div>
</template>
