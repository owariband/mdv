import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import * as vscode from 'vscode'
import { createMdv, verifyMdv, type ContentSpec, type MdvDocument, type TreeKind, type VersionSummary } from '@mdv/core'
import { DocumentSessions } from './document-session.js'
import { readResourceFile } from './file-system.js'
import { parseSource, requireLocalPackage, sourceUri } from './uri.js'

export class MdvCommands implements vscode.Disposable {
  readonly #events = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChangePackage = this.#events.event
  #activePackage: vscode.Uri | undefined
  #layout: Promise<unknown> = Promise.resolve()

  get activePackage(): vscode.Uri | undefined { return this.#activePackage }
  set activePackage(uri: vscode.Uri | undefined) {
    if (uri?.toString() === this.#activePackage?.toString()) return
    this.#activePackage = uri
    if (uri) this.#events.fire(uri)
  }

  dispose(): void { this.#events.dispose() }

  constructor(private readonly sessions: DocumentSessions, private readonly output: vscode.OutputChannel) {}

  register(report: (error: unknown) => void): vscode.Disposable[] {
    const commands: Record<string, (uri?: vscode.Uri) => Promise<unknown>> = {
      'mdv.create': () => this.create(),
      'mdv.open': (uri) => this.open(uri),
      'mdv.editReference': (uri) => this.edit('reference', uri),
      'mdv.editDocument': (uri) => this.edit('document', uri),
      'mdv.toggleReference': (uri) => this.toggle('reference', uri),
      'mdv.toggleDocument': (uri) => this.toggle('document', uri),
      'mdv.showVersions': async (uri) => {
        const target = await this.packageFor(uri)
        if (target) { await this.sessions.get(target); this.activePackage = target }
        await vscode.commands.executeCommand('mdv.versions.focus')
      },
      'mdv.preview': (uri) => this.preview(uri),
      'mdv.history': (uri) => this.history(uri),
      'mdv.showBinding': (uri) => this.binding(uri, true),
      'mdv.showBindingSources': (uri) => this.binding(uri, false),
      'mdv.commitReference': (uri) => this.commit('reference', uri),
      'mdv.commitDocument': (uri) => this.commit('document', uri),
      'mdv.checkout': (uri) => this.checkout(uri),
      'mdv.insertImage': () => this.insertImage(),
      'mdv.reload': () => this.reload(),
      'mdv.status': (uri) => this.status(uri),
      'mdv.verify': (uri) => this.verify(uri),
    }
    return Object.entries(commands).map(([name, action]) => vscode.commands.registerCommand(name, async (argument: unknown) => {
      try { return await action(argument instanceof vscode.Uri ? argument : undefined) }
      catch (error) { report(error); throw error }
    }))
  }

  async openSource(packageUri: vscode.Uri, content: ContentSpec, column?: vscode.ViewColumn): Promise<vscode.Uri> {
    const session = await this.sessions.get(packageUri)
    this.activePackage = packageUri
    const uri = sourceUri(packageUri, session.document.manifest.documentId, content)
    const document = await vscode.workspace.openTextDocument(uri)
    if (document.languageId !== 'markdown') await vscode.languages.setTextDocumentLanguage(document, 'markdown')
    const viewColumn = column ?? sourceTab(uri)?.group.viewColumn
    await vscode.window.showTextDocument(document, { preview: false, ...(viewColumn === undefined ? {} : { viewColumn }) })
    return uri
  }

  async packageFor(argument?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const candidate = argument ?? vscode.window.activeTextEditor?.document.uri
    const source = candidate && parseSource(candidate)
    if (source) {
      await this.sessions.get(source.packageUri, source.documentId)
      return source.packageUri
    }
    if (candidate?.scheme === 'file' && /\.mdv$/i.test(candidate.path)) return candidate
    if (!argument && this.activePackage) return this.activePackage
    const [uri] = await vscode.window.showOpenDialog({ filters: { MDV: ['mdv'] }, canSelectMany: false }) ?? []
    return uri
  }

  private async create(): Promise<vscode.Uri | undefined> {
    this.sessions.requireTrusted()
    const uri = await vscode.window.showSaveDialog({ filters: { MDV: ['mdv'] }, title: 'New MDV document' })
    if (!uri) return
    requireLocalPackage(uri)
    this.sessions.requireTrusted()
    await createMdv(uri.fsPath)
    await this.open(uri)
    return uri
  }

  async open(argument?: vscode.Uri, column?: vscode.ViewColumn): Promise<void> {
    const uri = await this.packageFor(argument)
    if (!uri) return
    requireLocalPackage(uri)
    this.activePackage = uri
    await this.arrange(() => this.showWorkingCopy(uri, 'document', column))
  }

  private async edit(tree: TreeKind, argument?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const uri = await this.packageFor(argument)
    if (uri) return this.arrange(() => this.showWorkingCopy(uri, tree))
  }

  private arrange<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#layout.then(action)
    this.#layout = pending.catch(() => undefined)
    return pending
  }

  private async showWorkingCopy(packageUri: vscode.Uri, tree: TreeKind, column?: vscode.ViewColumn): Promise<vscode.Uri> {
    const session = await this.sessions.get(packageUri)
    const content = { tree, kind: 'working-copy' } as const
    const uri = sourceUri(packageUri, session.document.manifest.documentId, content)
    const otherTree = tree === 'reference' ? 'document' : 'reference'
    const otherUri = sourceUri(packageUri, session.document.manifest.documentId, { tree: otherTree, kind: 'working-copy' })
    if (vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri.toString())) {
      return this.openSource(packageUri, content)
    }
    const other = sourceTab(otherUri)
    // Doc is the normal entry. Ref is added to the left of its own Doc, never an unrelated file.
    if (!other && tree === 'document') return this.openSource(packageUri, content, column)
    await this.openSource(packageUri, { tree: otherTree, kind: 'working-copy' }, other?.group.viewColumn ?? column)
    const existing = sourceTab(uri)
    if (existing && existing.group !== sourceTab(otherUri)?.group) return this.openSource(packageUri, content, existing.group.viewColumn)
    await vscode.commands.executeCommand(tree === 'reference' ? 'workbench.action.newGroupLeft' : 'workbench.action.newGroupRight')
    const target = vscode.window.tabGroups.activeTabGroup
    if (existing) {
      await this.openSource(packageUri, content, existing.group.viewColumn)
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: target.viewColumn })
    } else {
      await this.openSource(packageUri, content, target.viewColumn)
    }
    await this.openSource(packageUri, { tree: otherTree, kind: 'working-copy' }, sourceTab(otherUri)?.group.viewColumn)
    return this.openSource(packageUri, content, sourceTab(uri)?.group.viewColumn)
  }

  private async toggle(tree: TreeKind, argument?: vscode.Uri): Promise<void> {
    const packageUri = await this.packageFor(argument)
    if (!packageUri) return
    await this.arrange(async () => {
      const session = await this.sessions.get(packageUri)
      const content = { tree, kind: 'working-copy' } as const
      const uri = sourceUri(packageUri, session.document.manifest.documentId, content)
      if (!vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === uri.toString())) {
        await this.showWorkingCopy(packageUri, tree)
        return
      }
      const otherTree = tree === 'reference' ? 'document' : 'reference'
      const otherUri = await this.openSource(packageUri, { tree: otherTree, kind: 'working-copy' })
      // Park the native tab behind the other source. Closing a dirty tab would invoke Save/Discard.
      for (const tab of sourceTabs(uri)) {
        const target = sourceTab(otherUri)!.group
        if (tab.group === target) continue
        await this.openSource(packageUri, content, tab.group.viewColumn)
        await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: target.viewColumn })
      }
      await this.openSource(packageUri, { tree: otherTree, kind: 'working-copy' }, sourceTab(otherUri)?.group.viewColumn)
    })
  }

  private async preview(argument?: vscode.Uri): Promise<void> {
    let uri = argument ?? vscode.window.activeTextEditor?.document.uri
    if (!uri || !parseSource(uri)) uri = await this.edit('document', argument)
    if (!uri) return
    const source = parseSource(uri)!
    const command = vscode.workspace.getConfiguration('mdv', source.packageUri)
      .get<string>('previewCommand', 'markdown.showPreviewToSide')
    if (command !== 'markdown.showPreviewToSide' && command !== 'markdown.showPreview') this.sessions.requireTrusted()
    if (!command || command.startsWith('mdv.')) throw new Error('Choose an existing Markdown preview command, not an MDV command.')
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false })
    await vscode.commands.executeCommand(command, uri)
  }

  private async history(argument?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const uri = await this.packageFor(argument)
    if (!uri) return
    const session = await this.sessions.get(uri)
    await this.sessions.refresh(session)
    const version = await pickVersion(session.document)
    if (version) return this.openSource(uri, { tree: version.tree, kind: 'version', version: version.id })
  }

  private async binding(argument: vscode.Uri | undefined, preview: boolean): Promise<readonly vscode.Uri[] | undefined> {
    const packageUri = await this.packageFor(argument)
    if (!packageUri) return
    const session = await this.sessions.get(packageUri)
    await this.sessions.refresh(session)
    const selected = parseSource(argument ?? vscode.window.activeTextEditor?.document.uri ?? packageUri)
    const version = selected?.content.kind === 'version' && selected.content.tree === 'document'
      ? selected.content.version : (await pickVersion(session.document, 'document'))?.id
    if (!version) return
    const trace = session.document.traceDocument(version)
    const targets = [
      ...(trace.reference ? [sourceUri(packageUri, session.document.manifest.documentId,
        { tree: 'reference', kind: 'version', version: trace.reference.id })] : []),
      sourceUri(packageUri, session.document.manifest.documentId, { tree: 'document', kind: 'version', version }),
    ]
    if (!trace.reference) void vscode.window.showInformationMessage('This Document Version is unbound. No current Reference is substituted.')
    for (let index = 0; index < targets.length; index++) {
      const uri = targets[index]!
      const viewColumn = index === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Two
      if (preview) {
        // Static built-in previews stay bound to these exact historical URIs.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', { viewColumn, preview: false })
      } else {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn, preview: false })
      }
    }
    return targets
  }

  private async commit(tree: TreeKind, argument?: vscode.Uri): Promise<void> {
    this.sessions.requireTrusted()
    const packageUri = await this.packageFor(argument)
    if (!packageUri) return
    const uri = await this.openSource(packageUri, { tree, kind: 'working-copy' })
    const editorDocument = await vscode.workspace.openTextDocument(uri)
    if (editorDocument.isDirty) {
      const choice = await vscode.window.showWarningMessage('Save this working copy before creating a version?', { modal: true }, 'Save and continue')
      if (choice !== 'Save and continue' || !await editorDocument.save()) return
    }
    const session = await this.sessions.get(packageUri)
    await this.sessions.refresh(session)
    const generation = session.document.manifest.generation
    const summary = await vscode.window.showInputBox({ title: `Commit ${tree}`, prompt: 'Describe this version',
      validateInput: (value) => value.trim() && value.length <= 4096 ? undefined : 'Enter a summary (1–4096 characters).' })
    if (!summary) return
    let referenceVersion: `v_${string}` | null = null
    if (tree === 'document') {
      const choices = [
        { label: 'Unbound', description: 'Do not bind a Reference Version', version: null },
        ...session.document.listVersions({ tree: 'reference' }).map((version) => ({
          label: version.summary, description: version.id + (session.document.referenceTree.head === version.id ? ' · HEAD' : ''), version: version.id,
        })),
      ]
      const choice = await vscode.window.showQuickPick(choices, { title: 'Bind this Document to an exact Reference Version', matchOnDescription: true })
      if (!choice) return
      referenceVersion = choice.version
    }
    let created = false
    await this.sessions.mutate(session, generation, async (document) => {
      if (editorDocument.isDirty) throw new Error('The editor changed while confirming the commit. Save it and commit again.')
      const input = { summary, actor: { type: 'human' as const }, expectedGeneration: generation }
      const result = tree === 'reference' ? await document.commitReference(input)
        : await document.commitDocument({ ...input, referenceVersion })
      created = result.created
      return result.document
    })
    void vscode.window.showInformationMessage(created ? `Committed ${tree} version.` : 'No changes; no new version was created.')
  }

  private async checkout(argument?: vscode.Uri): Promise<void> {
    this.sessions.requireTrusted()
    const packageUri = await this.packageFor(argument)
    if (!packageUri) return
    const session = await this.sessions.get(packageUri)
    await this.sessions.refresh(session)
    const version = await pickVersion(session.document)
    if (!version) return
    const uri = sourceUri(packageUri, session.document.manifest.documentId, { tree: version.tree, kind: 'working-copy' })
    const editor = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
    const status = await session.document.getStatus()
    const generation = session.document.manifest.generation
    const losses = [editor?.isDirty ? 'unsaved editor text' : '', status[version.tree].dirty ? 'saved but uncommitted working-copy changes' : ''].filter(Boolean)
    const editorVersion = editor?.version
    const choice = await vscode.window.showWarningMessage(
      `Restore ${version.tree} to ${version.id}?${losses.length ? ` This discards ${losses.join(' and ')}.` : ''} Historical versions are kept.`,
      { modal: true }, 'Restore version',
    )
    if (choice !== 'Restore version') return
    await this.sessions.mutate(session, generation, async (document) => {
      if (editor && editor.version !== editorVersion) throw new Error('The editor changed during restore. Confirm the operation again.')
      const input = { version: version.id, expectedGeneration: generation, discardChanges: losses.length > 0 }
      return version.tree === 'reference' ? document.checkoutReference(input) : document.checkoutDocument(input)
    })
    if (editor?.isDirty && editor.version !== editorVersion) {
      await this.sessions.block(uri)
      throw new Error('The disk version was restored, but the editor changed during the operation. Its newer unsaved text was kept; compare/export it before reloading.')
    }
    await this.sessions.reload(uri)
    if (editor?.isDirty && editor.version !== editorVersion) {
      await this.sessions.block(uri)
      throw new Error('The editor changed while reloading the restored version. Its unsaved text was kept.')
    }
    await this.openSource(packageUri, { tree: version.tree, kind: 'working-copy' })
    if (editor?.isDirty && editor.version !== editorVersion) {
      await this.sessions.block(uri)
      throw new Error('The editor changed before applying the restored text. Its unsaved text was kept.')
    }
    await vscode.commands.executeCommand('workbench.action.files.revert')
  }

  private async reload(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    const source = editor && parseSource(editor.document.uri)
    if (!editor || !source || source.content.kind !== 'working-copy') throw new Error('Open a Ref or Doc working copy first.')
    const editorVersion = editor.document.version
    if (editor.document.isDirty) {
      const choice = await vscode.window.showWarningMessage('Discard unsaved editor text and load the saved MDV working copy?', { modal: true }, 'Discard and reload')
      if (choice !== 'Discard and reload') return
    }
    await this.sessions.reload(editor.document.uri)
    if (editor.document.isDirty && editor.document.version !== editorVersion) {
      await this.sessions.block(editor.document.uri)
      throw new Error('The editor changed while confirming reload. Its unsaved text was kept; confirm reload again.')
    }
    await vscode.window.showTextDocument(editor.document, { preview: false })
    if (editor.document.isDirty && editor.document.version !== editorVersion) {
      await this.sessions.block(editor.document.uri)
      throw new Error('The editor changed before applying the reloaded text. Its unsaved text was kept.')
    }
    await vscode.commands.executeCommand('workbench.action.files.revert')
  }

  private async insertImage(): Promise<void> {
    this.sessions.requireTrusted()
    const editor = vscode.window.activeTextEditor
    const source = editor && parseSource(editor.document.uri)
    if (!editor || !source || source.content.kind !== 'working-copy') throw new Error('Open a writable MDV Ref or Doc first.')
    const [file] = await vscode.window.showOpenDialog({ filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, canSelectMany: false }) ?? []
    if (!file) return
    if (file.scheme !== 'file') throw new Error('Select a local image file.')
    const session = await this.sessions.get(source.packageUri, source.documentId)
    const bytes = await readResourceFile(file.fsPath)
    this.sessions.requireTrusted()
    const path = await session.document.importManagedResource({ bytes })
    await editor.insertSnippet(new vscode.SnippetString().appendText(`![image](${path})`))
  }

  private async status(argument?: vscode.Uri): Promise<void> {
    const uri = await this.packageFor(argument)
    if (!uri) return
    const session = await this.sessions.get(uri)
    await this.sessions.refresh(session)
    this.output.appendLine(JSON.stringify({ file: uri.fsPath, manifest: session.document.manifest,
      status: await session.document.getStatus(), versions: session.document.listVersions() }, null, 2))
    this.output.show(true)
  }

  private async verify(argument?: vscode.Uri): Promise<void> {
    const uri = await this.packageFor(argument)
    if (!uri) return
    requireLocalPackage(uri)
    if ((await stat(uri.fsPath)).size === 0) {
      void vscode.window.showInformationMessage('This is a new empty MDV document. Its archive will be written on the first save; there is no saved archive to verify yet.')
      return
    }
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying MDV' },
      () => verifyMdv(uri.fsPath, { mode: 'full' }))
    this.output.appendLine(`${basename(uri.fsPath)}\n${JSON.stringify(report, null, 2)}`)
    this.output.show(true)
  }
}

function sourceTabs(uri: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString())
}

function sourceTab(uri: vscode.Uri): vscode.Tab | undefined {
  const tabs = sourceTabs(uri)
  return tabs.find((tab) => tab.isActive) ?? tabs[0]
}

async function pickVersion(document: MdvDocument, tree?: TreeKind): Promise<VersionSummary | undefined> {
  const versions = document.listVersions(tree ? { tree } : undefined)
  if (!versions.length) { void vscode.window.showInformationMessage('No committed versions yet. Save edits, then explicitly commit a version.'); return }
  const choice = await vscode.window.showQuickPick([...versions].reverse().map((version) => ({
    label: `${version.tree === 'reference' ? 'Ref' : 'Doc'} · ${version.summary}`,
    description: version.id,
    detail: `${version.createdAt} · ${version.actor.name ?? version.actor.type}${version.tree === 'document' ? ` · Ref: ${version.referenceVersion ?? 'unbound'}` : ''}`,
    version,
  })), { title: 'MDV history', matchOnDescription: true, matchOnDetail: true })
  return choice?.version
}
