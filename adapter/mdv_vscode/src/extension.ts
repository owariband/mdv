import * as vscode from 'vscode'
import { MdvCommands } from './commands.js'
import { DocumentSessions } from './document-session.js'
import { MdvFileSystem } from './file-system.js'
import { extendMarkdownIt } from './markdown.js'
import { MdvPackageEditor } from './package-editor.js'
import { MdvVersionView } from './version-view.js'
import { registerImageInput } from './resources.js'

export function activate(context: vscode.ExtensionContext): { extendMarkdownIt: typeof extendMarkdownIt } {
  const output = vscode.window.createOutputChannel('MDV')
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(message)
    void vscode.window.showWarningMessage(`MDV: ${message}`)
  }
  const sessions = new DocumentSessions(context.workspaceState, report)
  const files = new MdvFileSystem(sessions)
  const commands = new MdvCommands(sessions, output)
  const versions = new MdvVersionView(sessions, commands, context.extensionUri, report)
  context.subscriptions.push(
    output, sessions, files, commands, versions,
    vscode.workspace.registerFileSystemProvider('mdv', files, { isCaseSensitive: true }),
    // Retain the association ID so old workspaces also route their restored overview tabs to Doc.
    vscode.window.registerCustomEditorProvider('mdv.overview', new MdvPackageEditor(sessions, commands, report), {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerWebviewViewProvider('mdv.versions', versions),
    ...commands.register(report),
    ...registerImageInput(sessions),
  )
  return { extendMarkdownIt }
}
