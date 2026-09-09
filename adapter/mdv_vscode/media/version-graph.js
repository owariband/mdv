/* This view only draws metadata. Markdown and dirty text remain in native editors. */
const vscode = acquireVsCodeApi()
const $ = (id) => document.getElementById(id)
const rowHeight = 38
let state

function send(action, extra = {}) {
  if (state) vscode.postMessage({ action, package: state.package, documentId: state.documentId, ...extra })
}

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => send('command', { command: button.dataset.command }))
})
$('open-version').addEventListener('click', () => state.selection && send('open', state.selection))
$('open-binding').addEventListener('click', () => state.selection && send('binding', state.selection))

function svgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

function drawEdges() {
  if (!state) return
  const svg = $('edges')
  const width = $('graph').clientWidth
  if (!width) return
  const gap = Math.min(18, width / 16)
  const spacing = {}
  for (const tree of ['reference', 'document']) {
    const lanes = Math.max(0, ...state[tree].map((node) => node.lane))
    // Keep room for labels inside this sidebar; extra branches must not widen the view.
    spacing[tree] = lanes ? Math.min(9, Math.max(0, width / 5 - gap - 8) / lanes) : 0
    $('graph').style.setProperty(`--${tree}-rail-space`, `${gap + lanes * spacing[tree] + 2}px`)
  }
  const all = [...state.reference, ...state.document]
  const positions = new Map(all.map((node) => [node.version.id, {
    x: width / 2 + (node.version.tree === 'reference' ? -1 : 1) * (gap + node.lane * spacing[node.version.tree]),
    y: node.row * rowHeight + rowHeight / 2,
  }]))
  svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(state.reference.length, state.document.length, 1) * rowHeight}`)
  svg.replaceChildren()
  for (const node of all) {
    const from = positions.get(node.version.id)
    const parent = positions.get(node.version.parent)
    if (parent) svg.append(svgElement('path', {
      d: `M${from.x},${from.y} C${from.x},${from.y + 19} ${parent.x},${parent.y - 19} ${parent.x},${parent.y}`,
      class: `parent ${node.version.tree}`, 'data-child': node.version.id, 'data-parent': node.version.parent,
    }))
  }
  const bindings = state.document.filter((node) => node.version.referenceVersion)
  const selectedBinding = (node) => state.selection?.tree === 'reference'
    ? node.version.referenceVersion === state.selection.id : node.version.id === state.selection?.id
  // Selected bindings are drawn last, so their direction and destination stay legible.
  bindings.sort((a, b) => Number(selectedBinding(a)) - Number(selectedBinding(b)))
  for (const node of bindings) {
    const from = positions.get(node.version.id)
    const to = positions.get(node.version.referenceVersion)
    if (!to) continue
    const highlighted = selectedBinding(node)
    svg.append(svgElement('path', {
      d: `M${from.x - 5},${from.y} C${width / 2},${from.y} ${width / 2},${to.y} ${to.x + 5},${to.y}`,
      class: `binding${highlighted ? ' highlighted' : ''}`, 'data-doc': node.version.id, 'data-ref': node.version.referenceVersion,
    }))
    if (highlighted) svg.append(svgElement('path', {
      d: `M${to.x + 9},${to.y - 3} L${to.x + 5},${to.y} L${to.x + 9},${to.y + 3}`, class: 'binding highlighted arrow',
    }))
  }
  for (const node of all) {
    const position = positions.get(node.version.id)
    const head = state.working[node.version.tree].head === node.version.id
    const selected = state.selection?.id === node.version.id
    svg.append(svgElement('circle', { cx: position.x, cy: position.y, r: head ? 5 : 3.5,
      class: `dot ${node.version.tree}${head ? ' head' : ''}${selected ? ' selected' : ''}` }))
  }
}

window.addEventListener('message', (event) => {
  const next = event.data
  if (!next || !Array.isArray(next.reference) || !Array.isArray(next.document)) return
  const packageChanged = state?.package !== next.package || state?.documentId !== next.documentId
  const previousSelection = state?.selection?.id
  const focused = document.activeElement?.dataset?.id
  state = next
  $('empty').hidden = true
  $('versions').hidden = false
  $('package').textContent = state.name
  $('package').title = state.package
  $('versions').dataset.package = state.package
  $('versions').dataset.documentId = state.documentId
  $('versions').dataset.generation = String(state.generation)
  $('notice').textContent = state.invalid || (state.trusted ? '' : 'Restricted Mode · read-only')
  document.querySelectorAll('[data-write]').forEach((button) => { button.disabled = !state.trusted })
  for (const tree of ['reference', 'document']) {
    const working = state.working[tree]
    const label = tree === 'reference' ? 'Ref' : 'Doc'
    const toggle = $(`toggle-${tree}`)
    toggle.title = `${working.visible ? 'Hide' : 'Show'} ${label}`
    toggle.setAttribute('aria-label', toggle.title)
    toggle.setAttribute('aria-pressed', String(working.visible))
    $(`working-${tree}`).textContent = working.unsaved ? '● Unsaved edits'
      : working.dirty ? '○ Uncommitted' : working.head ? 'Working · at HEAD' : 'Working · no versions'
    $(`working-${tree}`).title = `${label} working copy${working.unsaved && working.dirty ? ': unsaved edits and saved uncommitted changes' : ''}. Click to edit; this is not a committed version.`
  }
  $('graph').style.height = `${Math.max(state.reference.length, state.document.length, 1) * rowHeight}px`
  const nodes = $('nodes')
  nodes.replaceChildren()
  for (const tree of ['reference', 'document']) {
    if (!state[tree].length) {
      const empty = document.createElement('div')
      empty.className = `empty-column ${tree}`
      empty.textContent = 'No versions yet'
      nodes.append(empty)
    }
    for (const node of state[tree]) {
      const version = node.version
      const button = document.createElement('button')
      button.className = `node ${tree}`
      button.dataset.id = version.id
      button.dataset.tree = tree
      button.style.top = `${node.row * rowHeight}px`
      const selected = state.selection?.id === version.id
      button.setAttribute('aria-pressed', String(selected))
      button.classList.toggle('related', state.related.includes(version.id))
      button.title = `${version.summary}\n${version.id}\n${version.createdAt} · ${version.actor.name || version.actor.type}\nParent: ${version.parent || 'none'}${tree === 'document' ? `\nRef: ${version.referenceVersion || 'unbound'}` : ''}`
      const label = document.createElement('span')
      label.className = 'node-label'
      const summary = document.createElement('span')
      summary.className = 'summary'
      summary.textContent = version.summary
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = version.id.slice(2, 9)
      if (state.working[tree].head === version.id) {
        const badge = document.createElement('span')
        badge.className = 'head-badge'
        badge.textContent = 'HEAD'
        meta.append(badge)
      }
      if (tree === 'document' && !version.referenceVersion) meta.append(' · unbound')
      label.append(summary, meta)
      button.append(label)
      button.addEventListener('click', () => send('select', { tree, id: version.id }))
      button.addEventListener('dblclick', () => send('open', { tree, id: version.id }))
      button.addEventListener('keydown', (event) => {
        const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        if (!direction) return
        const next = nodes.querySelectorAll(`.node.${tree}`)[node.row + direction]
        if (next) { event.preventDefault(); next.focus(); next.click() }
      })
      nodes.append(button)
    }
  }
  const selected = [...state.reference, ...state.document].find((node) => node.version.id === state.selection?.id)?.version
  $('relation').textContent = !selected ? 'Save your text; commit when a version is ready.'
    : selected.tree === 'reference' ? `Ref ${selected.id.slice(2, 9)} · used by ${state.related.length} Doc version${state.related.length === 1 ? '' : 's'}`
      : selected.referenceVersion ? `Doc ${selected.id.slice(2, 9)} → Ref ${selected.referenceVersion.slice(2, 9)}` : `Doc ${selected.id.slice(2, 9)} · unbound`
  const headDoc = state.document.find((node) => node.version.id === state.working.document.head)?.version
  $('detail').textContent = headDoc ? `Doc HEAD → ${headDoc.referenceVersion ? `Ref ${headDoc.referenceVersion.slice(2, 9)}` : 'unbound'}${headDoc.referenceVersion && headDoc.referenceVersion !== state.working.reference.head ? ' (not Ref HEAD)' : ''}` : 'Doc has no committed HEAD.'
  $('open-version').disabled = !selected
  $('open-binding').hidden = selected?.tree !== 'document' || !selected.referenceVersion
  drawEdges()
  if (packageChanged) $('viewport').scrollTop = 0
  if (focused && !packageChanged) nodes.querySelector(`[data-id="${focused}"]`)?.focus({ preventScroll: true })
  if (selected && selected.id !== previousSelection) {
    const destination = selected.tree === 'document' && selected.referenceVersion ? selected.referenceVersion : selected.id
    nodes.querySelector(`[data-id="${destination}"]`)?.scrollIntoView({ block: 'nearest' })
  }
})

new ResizeObserver(drawEdges).observe($('graph'))
vscode.postMessage({ action: 'ready' })
