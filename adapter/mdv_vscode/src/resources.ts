import * as vscode from 'vscode'
import { DocumentSessions } from './document-session.js'
import { readResourceFile } from './file-system.js'
import { parseSource } from './uri.js'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const IMAGE_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('mdv', 'image')

export function registerImageInput(sessions: DocumentSessions): vscode.Disposable[] {
  const selector = { scheme: 'mdv', language: 'markdown' }
  async function insertText(document: vscode.TextDocument, transfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.SnippetString | undefined> {
    const source = parseSource(document.uri)
    if (!source || source.content.kind !== 'working-copy' || !vscode.workspace.isTrusted) return
    const files: { bytes: () => Promise<Uint8Array>; mediaType?: string }[] = []
    for (const [type, item] of transfer) {
      const file = item.asFile()
      if (file && (IMAGE_TYPES.includes(type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
        files.push({ bytes: async () => file.data(), ...(IMAGE_TYPES.includes(type) ? { mediaType: type } : {}) })
      }
    }
    if (!files.length) {
      const text = await transfer.get('text/uri-list')?.asString()
      for (const line of text?.split(/\r?\n/).filter((line) => line && !line.startsWith('#')) ?? []) {
        const uri = vscode.Uri.parse(line)
        if (uri.scheme === 'file' && !uri.authority && /\.(png|jpe?g|gif|webp)$/i.test(uri.path)) files.push({ bytes: () => readResourceFile(uri.fsPath) })
      }
    }
    if (!files.length || token.isCancellationRequested) return
    if (files.length > 16) throw new Error('Insert at most 16 images at a time.')
    const session = await sessions.get(source.packageUri, source.documentId)
    const links: string[] = []
    for (const file of files) {
      if (token.isCancellationRequested) return
      const bytes = await file.bytes()
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('Image exceeds the 32 MiB limit.')
      if (token.isCancellationRequested) return
      sessions.requireTrusted()
      const path = await session.document.importManagedResource({ bytes, ...(file.mediaType ? { mediaType: file.mediaType } : {}) })
      links.push(`![image](${path})`)
    }
    if (token.isCancellationRequested) return
    return new vscode.SnippetString().appendText(links.join('\n'))
  }
  return [
    vscode.languages.registerDocumentPasteEditProvider(selector, {
      async provideDocumentPasteEdits(document, _ranges, transfer, _context, token) {
        const text = await insertText(document, transfer, token)
        return text ? [new vscode.DocumentPasteEdit(text, 'Insert MDV hash image', IMAGE_KIND)] : undefined
      },
    }, { providedPasteEditKinds: [IMAGE_KIND], pasteMimeTypes: [...IMAGE_TYPES, 'text/uri-list', 'files'] }),
    vscode.languages.registerDocumentDropEditProvider(selector, {
      async provideDocumentDropEdits(document, _position, transfer, token) {
        const text = await insertText(document, transfer, token)
        if (!text) return
        const edit = new vscode.DocumentDropEdit(text)
        edit.title = 'Insert MDV hash image'
        edit.kind = IMAGE_KIND
        return edit
      },
    }, { providedDropEditKinds: [IMAGE_KIND], dropMimeTypes: [...IMAGE_TYPES, 'text/uri-list', 'files'] }),
  ]
}
