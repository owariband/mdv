import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import * as vscode from 'vscode'
import type { MdvDocument, TreeKind, VersionId } from '@owariband/mdv'
import { DocumentSessions } from './document-session.js'
import { MdvCommands } from './commands.js'
import { layoutVersions } from './version-graph.js'
import { parseSource, sourceUri } from './uri.js'

const graphCommands = new Set(['mdv.toggleReference', 'mdv.toggleDocument', 'mdv.editReference', 'mdv.editDocument',
  'mdv.commitReference', 'mdv.commitDocument', 'mdv.checkout', 'mdv.history', 'mdv.verify'])
type Selection = { tree: TreeKind; id: VersionId }

export class MdvVersionView implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #subscriptions: vscode.Disposable[] = []
  readonly #selections = new Map<string, Selection>()
  #view: vscode.WebviewView | undefined
  #pin: vscode.Disposable | undefined
  #package: vscode.Uri | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #revision = 0
  #cache: { document: MdvDocument; status: Awaited<ReturnType<MdvDocument['getStatus']>>;
    reference: ReturnType<typeof layoutVersions>; documentNodes: ReturnType<typeof layoutVersions> } | undefined
  #lastState = ''

  constructor(private readonly sessions: DocumentSessions, private readonly commands: MdvCommands,
    private readonly extensionUri: vscode.Uri, private readonly report: (error: unknown) => void) {
    const follow = (editor: vscode.TextEditor | undefined) => {
      const source = editor && parseSource(editor.document.uri)
      if (!source) return
      if (source.content.kind === 'version') this.#selections.set(source.packageUri.toString(), { tree: source.content.tree, id: source.content.version })
      this.commands.activePackage = source.packageUri
      this.schedule()
    }
    this.#subscriptions.push(
      commands.onDidChangePackage((uri) => {
        this.#pin?.dispose()
        this.#package = uri
        this.#pin = sessions.retain(uri)
        this.schedule()
      }),
      vscode.window.onDidChangeActiveTextEditor(follow),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (parseSource(event.document.uri)?.packageUri.toString() === this.#package?.toString()) this.schedule()
      }),
      sessions.onDidChange((uris) => {
        if (uris.some((uri) => uri.toString() === this.#package?.toString())) this.schedule()
      }),
    )
    follow(vscode.window.activeTextEditor)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    const nonce = randomBytes(16).toString('hex')
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'version-graph.js'))
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'version-graph.css'))
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${style}"><title>MDV versions</title></head><body>
      <div id="empty">Open an .mdv document to see its version history.</div>
      <main id="versions" hidden>
        <header><div id="package" title=""></div><div id="notice" role="status"></div></header>
        <div class="columns">
          <section aria-label="Reference controls"><div class="column-title">
            <button class="tree-title" data-command="mdv.editReference" id="open-reference" aria-label="Open current Reference" title="Open current Ref">REF <span aria-hidden="true">›</span></button>
            <button class="icon" data-command="mdv.toggleReference" id="toggle-reference" aria-label="Show Ref" title="Show Ref">◧</button>
            <button class="icon" data-command="mdv.commitReference" data-write title="Commit Ref version…" aria-label="Commit Ref version">＋</button></div>
            <button class="working" data-command="mdv.editReference" id="working-reference" title="Open current Ref"></button></section>
          <section aria-label="Document controls"><div class="column-title">
            <button class="tree-title" data-command="mdv.editDocument" id="open-document" aria-label="Open current Document" title="Open current Doc">DOC <span aria-hidden="true">›</span></button>
            <button class="icon" data-command="mdv.toggleDocument" id="toggle-document" aria-label="Hide Doc" title="Hide Doc">◨</button>
            <button class="icon" data-command="mdv.commitDocument" data-write title="Commit Doc version…" aria-label="Commit Doc version">＋</button></div>
            <button class="working" data-command="mdv.editDocument" id="working-document" title="Open current Doc"></button></section>
        </div>
        <div id="viewport"><div id="graph" aria-label="Ref and Doc version graph"><svg id="edges" aria-hidden="true"></svg><div id="nodes"></div></div></div>
        <footer><div id="relation" role="status" aria-live="polite"></div><div id="detail"></div>
          <div class="actions"><button id="open-version" title="Open this immutable version as Markdown">Open version</button>
            <button id="open-binding" title="Open this Doc and its exact bound Ref">Open bound pair</button>
            <button class="icon" data-command="mdv.history" title="Find a version…" aria-label="Find a version">⌕</button>
            <button class="icon" data-command="mdv.checkout" data-write title="Restore a historical version…" aria-label="Restore a historical version">↶</button></div>
          <div class="legend">Solid: parent · Dashed: Doc → Ref</div>
        </footer>
      </main><script nonce="${nonce}" src="${script}"></script></body></html>`
    const subscriptions = [
      view.onDidChangeVisibility(() => { this.#lastState = ''; this.schedule() }),
      view.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message).catch(this.report) }),
    ]
    view.onDidDispose(() => {
      subscriptions.forEach((subscription) => subscription.dispose())
      if (this.#view === view) this.#view = undefined
    })
    this.#lastState = ''
  }

  private schedule(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.render().catch(this.report) }, 50)
  }

  private async render(): Promise<void> {
    const view = this.#view
    const uri = this.#package
    if (!view?.visible || !uri) return
    const revision = ++this.#revision
    const session = await this.sessions.get(uri)
    const document = session.document
    let cache = this.#cache
    if (cache?.document !== document) {
      cache = { document, status: await document.getStatus(),
        reference: layoutVersions(document.listVersions({ tree: 'reference' })),
        documentNodes: layoutVersions(document.listVersions({ tree: 'document' })) }
    }
    if (revision !== this.#revision || uri.toString() !== this.#package?.toString() || view !== this.#view) return
    this.#cache = cache
    const key = uri.toString()
    let selection = this.#selections.get(key)
    if (!selection || !document.listVersions({ tree: selection.tree }).some((version) => version.id === selection?.id)) {
      selection = document.referenceTree.head ? { tree: 'reference', id: document.referenceTree.head }
        : document.documentTree.head ? { tree: 'document', id: document.documentTree.head } : undefined
      if (selection) this.#selections.set(key, selection)
    }
    const related = selection?.tree === 'reference' ? document.listDocumentsUsingReference(selection.id).map((version) => version.id)
      : selection ? [document.getDocumentReference(selection.id)].filter((id) => id !== null) : []
    const working = (tree: TreeKind) => {
      const source = sourceUri(uri, document.manifest.documentId, { tree, kind: 'working-copy' }).toString()
      return { head: cache.status[tree].head, dirty: cache.status[tree].dirty,
        unsaved: vscode.workspace.textDocuments.some((editor) => editor.uri.toString() === source && editor.isDirty),
        visible: vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === source) }
    }
    const state = { package: key, documentId: document.manifest.documentId, name: basename(uri.fsPath),
      generation: document.manifest.generation, trusted: vscode.workspace.isTrusted, invalid: session.invalid,
      reference: cache.reference, document: cache.documentNodes, selection, related,
      working: { reference: working('reference'), document: working('document') } }
    const serialized = JSON.stringify(state)
    if (serialized === this.#lastState) return
    if (await view.webview.postMessage(state)) this.#lastState = serialized
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('action' in message)) return
    if (message.action === 'ready') { this.#lastState = ''; await this.render(); return }
    const uri = this.#package
    if (!uri || !('package' in message) || message.package !== uri.toString() || !('documentId' in message)) return
    const session = await this.sessions.get(uri)
    if (message.documentId !== session.document.manifest.documentId) return
    if (message.action === 'command') {
      if ('command' in message && typeof message.command === 'string' && graphCommands.has(message.command)) {
        await vscode.commands.executeCommand(message.command, uri)
      }
      return
    }
    if (message.action !== 'select' && message.action !== 'open' && message.action !== 'binding') return
    if (!('tree' in message) || (message.tree !== 'reference' && message.tree !== 'document')
      || !('id' in message) || typeof message.id !== 'string') return
    const version = session.document.listVersions({ tree: message.tree }).find((entry) => entry.id === message.id)
    if (!version) return
    this.#selections.set(uri.toString(), { tree: version.tree, id: version.id })
    if (message.action === 'select') { await this.render(); return }
    const content = { tree: version.tree, kind: 'version', version: version.id } as const
    if (message.action === 'open') await this.commands.openSource(uri, content)
    else if (version.tree === 'document') {
      await vscode.commands.executeCommand('mdv.showBindingSources', sourceUri(uri, session.document.manifest.documentId, content))
    }
  }

  dispose(): void {
    this.#revision++
    if (this.#timer) clearTimeout(this.#timer)
    this.#pin?.dispose()
    this.#subscriptions.forEach((subscription) => subscription.dispose())
    this.#view = undefined
  }
}
