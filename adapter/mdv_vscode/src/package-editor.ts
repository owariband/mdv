import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { DocumentSessions } from './document-session.js'
import { MdvCommands } from './commands.js'

/** The ZIP association only routes to native Markdown; it owns no editable content or overview. */
export class MdvPackageEditor implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly sessions: DocumentSessions, private readonly commands: MdvCommands,
    private readonly report: (error: unknown) => void) {}

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    await this.sessions.get(uri)
    const pin = this.sessions.retain(uri)
    return { uri, dispose: () => pin.dispose() }
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): void {
    let ready = false
    let opening = false
    let disposed = false
    const redirect = async () => {
      if (disposed || token.isCancellationRequested || !ready || opening || !panel.active) return
      opening = true
      try {
        await this.commands.open(document.uri, panel.viewColumn)
        if (!disposed) panel.dispose()
      } finally { opening = false }
    }
    const listeners = [
      panel.onDidChangeViewState(() => { void redirect().catch(this.report) }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (ready || !message || typeof message !== 'object' || !('action' in message) || message.action !== 'ready') return
        ready = true
        void redirect().catch(this.report)
      }),
    ]
    panel.onDidDispose(() => { disposed = true; listeners.forEach((listener) => listener.dispose()) })
    // resolve must return before redirecting: VS Code still has to claim this Webview.
    // A message from its loaded content confirms that mounting has actually happened.
    const nonce = randomBytes(16).toString('hex')
    panel.webview.options = { enableScripts: true, localResourceRoots: [] }
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}';">
      <title>MDV</title></head><body><script nonce="${nonce}">
      acquireVsCodeApi().postMessage({ action: 'ready' });</script></body></html>`
  }
}
