<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CrepeBuilder } from '@milkdown/crepe/builder'
import { blockEdit } from '@milkdown/crepe/feature/block-edit'
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip'
import { listItem } from '@milkdown/crepe/feature/list-item'
import { placeholder } from '@milkdown/crepe/feature/placeholder'
import { table } from '@milkdown/crepe/feature/table'
import { toolbar } from '@milkdown/crepe/feature/toolbar'
import { editorViewCtx, serializerCtx, type Editor } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose, replaceAll } from '@milkdown/kit/utils'
import type { DesktopTree } from '../../shared/ipc.js'
import type { EditorCapture } from '../editor/types.js'

const props = defineProps<{
  sessionId: string
  tree: DesktopTree
  initialMarkdown: string
  readOnly: boolean
}>()

const emit = defineEmits<{
  changed: [event: { sessionId: string; tree: DesktopTree; revision: number }]
  ready: [event: { sessionId: string; tree: DesktopTree }]
  canonicalized: [event: { sessionId: string; tree: DesktopTree; canonicalMarkdown: string }]
  failed: [event: { sessionId: string; message: string }]
}>()

interface EditorDocument {
  readonly sessionId: string
  readonly markdown: string
}

const editorRoot = ref<HTMLDivElement>()
const sourceMarkdown = ref(props.initialMarkdown)
const mode = ref<'visual' | 'source'>('visual')
const ready = ref(false)
let builder: CrepeBuilder | undefined
let editorRevision = 0
let trackTransactions = false
let disposed = false
let initialized = false
let documentSequence = 0
let canonicalizationHandle: number | undefined
let requestedDocument: EditorDocument = {
  sessionId: props.sessionId,
  markdown: props.initialMarkdown,
}

function disableImageUploads(editor: Editor): void {
  editor.config((ctx) => {
    ctx.update(uploadConfig.key, (previous) => ({
      ...previous,
      uploader: async () => [],
    }))
  })
}

function trackDocumentChanges(editor: Editor): void {
  editor.use($prose(() => new Plugin({
    view: () => ({
      update: (view, previousState) => {
        if (trackTransactions && !view.state.doc.eq(previousState.doc)) markChanged()
      },
    }),
  })))
}

function markChanged(): void {
  if (disposed) return
  editorRevision += 1
  emit('changed', { sessionId: props.sessionId, tree: props.tree, revision: editorRevision })
}

function loadDocument(
  current: CrepeBuilder,
  document: EditorDocument,
  replaceContent: boolean,
): void {
  const sequence = ++documentSequence
  if (canonicalizationHandle !== undefined) {
    window.cancelIdleCallback(canonicalizationHandle)
    canonicalizationHandle = undefined
  }
  trackTransactions = false
  editorRevision = 0
  sourceMarkdown.value = document.markdown

  try {
    if (replaceContent) current.editor.action(replaceAll(document.markdown, true))
    if (disposed || builder !== current) return
    const serializeSnapshot = current.editor.action((ctx) => {
      const serializer = ctx.get(serializerCtx)
      const snapshot = ctx.get(editorViewCtx).state.doc
      return () => serializer(snapshot)
    })
    emit('ready', {
      sessionId: document.sessionId,
      tree: props.tree,
    })
    ready.value = true
    trackTransactions = true
    canonicalizationHandle = window.requestIdleCallback(() => {
      canonicalizationHandle = undefined
      if (disposed || builder !== current || sequence !== documentSequence) return
      try {
        emit('canonicalized', {
          sessionId: document.sessionId,
          tree: props.tree,
          canonicalMarkdown: serializeSnapshot(),
        })
      } catch (error) {
        emit('failed', {
          sessionId: document.sessionId,
          message: error instanceof Error ? error.message : 'Milkdown could not serialize the document',
        })
      }
    }, { timeout: 500 })
  } catch (error) {
    if (disposed || builder !== current) return
    emit('failed', {
      sessionId: document.sessionId,
      message: error instanceof Error ? error.message : 'Milkdown could not load the document',
    })
  }
}

async function createEditor(): Promise<void> {
  const root = editorRoot.value
  if (!root) return

  const initialDocument = requestedDocument

  const next = new CrepeBuilder({
    root,
    defaultValue: initialDocument.markdown,
  })
    .addFeature(blockEdit)
    .addFeature(toolbar)
    .addFeature(linkTooltip, {
      onCopyLink: (link) => void navigator.clipboard.writeText(link),
    })
    .addFeature(listItem)
    .addFeature(table)
    .addFeature(placeholder, {
      text: props.tree === 'document' ? 'Start writing…' : 'Reference is empty',
      mode: 'doc',
    })
    .addFeature(disableImageUploads)

  trackDocumentChanges(next.editor)
  next.setReadonly(props.readOnly)
  builder = next

  try {
    await next.create()
    if (disposed || builder !== next) {
      await next.destroy().catch(() => undefined)
      return
    }
    initialized = true
    const latestDocument = requestedDocument
    loadDocument(
      next,
      latestDocument,
      latestDocument.sessionId !== initialDocument.sessionId
        || latestDocument.markdown !== initialDocument.markdown,
    )
  } catch (error) {
    if (disposed) return
    initialized = false
    builder = undefined
    await next.destroy().catch(() => undefined)
    emit('failed', {
      sessionId: requestedDocument.sessionId,
      message: error instanceof Error ? error.message : 'Milkdown could not create the editor',
    })
  }
}

function switchMode(nextMode: 'visual' | 'source'): void {
  if (!builder || mode.value === nextMode) return
  if (nextMode === 'source') {
    sourceMarkdown.value = builder.getMarkdown()
  } else {
    trackTransactions = false
    try {
      builder.editor.action(replaceAll(sourceMarkdown.value, true))
    } finally {
      trackTransactions = true
    }
  }
  mode.value = nextMode
}

function onSourceInput(): void {
  markChanged()
}

function capture(): EditorCapture {
  return {
    markdown: mode.value === 'source'
      ? sourceMarkdown.value
      : builder?.getMarkdown() ?? props.initialMarkdown,
    revision: editorRevision,
  }
}

watch(
  () => [props.sessionId, props.initialMarkdown] as const,
  ([sessionId, markdown]) => {
    requestedDocument = { sessionId, markdown }
    if (initialized && builder) loadDocument(builder, requestedDocument, true)
    else ready.value = false
  },
)
watch(() => props.readOnly, (readOnly) => builder?.setReadonly(readOnly))

onMounted(() => void createEditor())
onBeforeUnmount(() => {
  disposed = true
  initialized = false
  documentSequence += 1
  if (canonicalizationHandle !== undefined) window.cancelIdleCallback(canonicalizationHandle)
  trackTransactions = false
  const current = builder
  builder = undefined
  if (current) void current.destroy()
})

defineExpose({ capture })
</script>

<template>
  <section class="mdv-editor" :class="[tree, { 'is-source': mode === 'source' }]">
    <div class="view-switch" role="group" aria-label="Editor mode">
      <button
        type="button"
        class="tooltip-trigger"
        :class="{ active: mode === 'visual' }"
        :disabled="!ready"
        aria-label="Visual editor"
        data-tooltip="Write"
        @click="switchMode('visual')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 17 1 2 2-1L18.5 7.5 15.5 4 5 14.5V17Zm8.7-11.2 3.5 3.5M4 20h16" /></svg>
      </button>
      <button
        type="button"
        class="tooltip-trigger"
        :class="{ active: mode === 'source' }"
        :disabled="!ready"
        aria-label="Markdown source"
        data-tooltip="Source"
        @click="switchMode('source')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-5 5 5 5m6-10 5 5-5 5m-3-12-2 14" /></svg>
      </button>
    </div>

    <div ref="editorRoot" class="milkdown-root" :aria-hidden="mode !== 'visual'" />
    <textarea
      v-if="mode === 'source'"
      v-model="sourceMarkdown"
      class="source-editor"
      :readonly="readOnly"
      spellcheck="false"
      aria-label="Markdown source"
      @input="onSourceInput"
    />
  </section>
</template>
