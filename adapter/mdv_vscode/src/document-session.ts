import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import * as vscode from 'vscode'
import { MdvError, openMdv, type DocumentId, type MdvDocument } from '@mdv/core'
import { parseSource, requireLocalPackage, requireSource, sourceKey, sourceUri } from './uri.js'

interface Baseline {
  generation: number
  blocked: boolean
  readonly restored: boolean
}

export class DocumentSession {
  readonly baselines = new Map<string, Baseline>()
  tail: Promise<unknown> = Promise.resolve()
  watcher: FSWatcher | undefined
  invalid: string | undefined
  pins = 0

  constructor(readonly packageUri: vscode.Uri, public document: MdvDocument) {}

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export class DocumentSessions implements vscode.Disposable {
  readonly #sessions = new Map<string, Promise<DocumentSession>>()
  readonly #events = new vscode.EventEmitter<readonly vscode.Uri[]>()
  readonly onDidChange = this.#events.event
  readonly #subscriptions: vscode.Disposable[] = []
  #disposed = false

  constructor(private readonly state: vscode.Memento, private readonly report: (error: unknown) => void) {
    const opened = (document: vscode.TextDocument) => {
      const source = parseSource(document.uri)
      if (!source || source.content.kind !== 'working-copy') return
      const recoveredDirty = document.isDirty
      // Hot exit can restore the buffer before activation, without an FSP read.
      void this.read(document.uri, true).then(() => this.get(source.packageUri, source.documentId)).then((session) => session.run(async () => {
        const baseline = session.baselines.get(sourceKey(document.uri))
        if (recoveredDirty && baseline && !baseline.restored) {
          baseline.blocked = true
          await this.persist(sourceKey(document.uri), baseline)
          this.report(new Error('Recovered MDV edits have no reliable save baseline. Export the text or explicitly reload before saving.'))
        }
      })).catch(report)
    }
    this.#subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(opened),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const source = parseSource(document.uri)
        if (!source) return
        void this.get(source.packageUri, source.documentId).then((session) => session.run(async () => {
          if (!document.isDirty) {
            session.baselines.delete(sourceKey(document.uri))
            await this.state.update(`baseline:${sourceKey(document.uri)}`, undefined)
          }
          this.collect(session)
        })).catch(() => undefined)
      }),
      vscode.window.onDidChangeWindowState((event) => {
        if (event.focused) for (const session of this.#sessions.values()) {
          void session.then((value) => this.refresh(value)).catch(report)
        }
      }),
    )
    vscode.workspace.textDocuments.forEach(opened)
  }

  async get(packageUri: vscode.Uri, expectedId?: DocumentId): Promise<DocumentSession> {
    requireLocalPackage(packageUri)
    const key = packageUri.toString()
    let pending = this.#sessions.get(key)
    if (!pending) {
      pending = openMdv(packageUri.fsPath).then((document) => {
        const session = new DocumentSession(packageUri, document)
        const reportOnce = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (session.invalid !== message) { session.invalid = message; this.report(error) }
        }
        if (!this.#disposed) {
          session.watcher = watch(dirname(packageUri.fsPath), { persistent: false }, (_event, filename) => {
            if (filename === null || filename.toString() === basename(packageUri.fsPath)) {
              void this.refresh(session).catch(reportOnce)
            }
          })
          session.watcher.on('error', reportOnce)
        }
        return session
      })
      this.#sessions.set(key, pending)
      void pending.catch(() => { if (this.#sessions.get(key) === pending) this.#sessions.delete(key) })
    }
    const session = await pending
    if (expectedId !== undefined && session.document.manifest.documentId !== expectedId) {
      throw vscode.FileSystemError.Unavailable('The .mdv path now contains another document. Keep your edits and reopen the package.')
    }
    return session
  }

  async read(uri: vscode.Uri, establishBaseline: boolean): Promise<Uint8Array> {
    const source = requireSource(uri)
    const session = await this.get(source.packageUri, source.documentId)
    if (source.content.kind === 'version') {
      const version = source.content.version
      if (!session.document.listVersions().some((entry) => entry.id === version)) await this.refresh(session)
    }
    return session.run(async () => {
      const result = await session.document.readContent(source.content)
      if (establishBaseline && source.content.kind === 'working-copy') {
        const key = sourceKey(uri)
        if (!session.baselines.has(key)) {
          const stored = this.state.get<{ generation: number; blocked?: boolean }>(`baseline:${key}`)
          const valid = stored && Number.isSafeInteger(stored.generation) && stored.generation >= 0
          const baseline: Baseline = {
            generation: valid ? stored.generation : session.document.manifest.generation,
            blocked: Boolean(stored && (!valid || stored.blocked)), restored: Boolean(valid),
          }
          session.baselines.set(key, baseline)
          await this.persist(key, baseline)
        }
      }
      return result.bytes
    })
  }

  async save(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    this.requireTrusted()
    const source = requireSource(uri)
    if (source.content.kind !== 'working-copy') throw vscode.FileSystemError.NoPermissions('History is immutable. Restore it explicitly to edit.')
    const bytes = Uint8Array.from(content)
    const session = await this.get(source.packageUri, source.documentId)
    await session.run(async () => {
      this.requireTrusted()
      const baseline = session.baselines.get(sourceKey(uri))
      if (!baseline || baseline.blocked || session.invalid) {
        throw vscode.FileSystemError.Unavailable('MDV save baseline is stale or missing. Your edits are kept; compare/export them or explicitly reload from disk.')
      }
      const generation = baseline.generation
      let published = false
      try {
        const input = { markdown: bytes, expectedGeneration: generation }
        const next = source.content.tree === 'reference'
          ? await session.document.saveReference(input) : await session.document.saveDocument(input)
        published = true
        await this.accept(session, next, generation)
      } catch (error) {
        this.handleWriteError(session, error, published)
        throw error
      }
    })
  }

  async mutate(
    session: DocumentSession, generation: number,
    operation: (document: MdvDocument) => Promise<MdvDocument>,
  ): Promise<void> {
    this.requireTrusted()
    await session.run(async () => {
      this.requireTrusted()
      if (session.invalid) throw vscode.FileSystemError.Unavailable(session.invalid)
      let published = false
      try {
        const next = await operation(session.document)
        published = true
        await this.accept(session, next, generation)
      } catch (error) { this.handleWriteError(session, error, published); throw error }
    })
  }

  async refresh(session: DocumentSession): Promise<void> {
    await session.run(async () => {
      const next = await openMdv(session.packageUri.fsPath)
      if (next.manifest.documentId !== session.document.manifest.documentId) {
        throw new Error('The .mdv file was replaced by a different document. Existing editors will not overwrite it.')
      }
      session.invalid = undefined
      if (next.manifest.generation === session.document.manifest.generation) return
      session.document = next
      const changed: vscode.Uri[] = [session.packageUri]
      for (const [key, baseline] of session.baselines) {
        const editor = vscode.workspace.textDocuments.find((doc) => sourceKey(doc.uri) === key)
        if (editor?.isDirty || baseline.blocked) {
          if (!baseline.blocked) this.report(new Error('The MDV file changed outside this editor. Unsaved text is kept; compare or export it before explicitly reloading.'))
          baseline.blocked = true
        } else {
          baseline.generation = next.manifest.generation
          changed.push(vscode.Uri.parse(key))
        }
        await this.persist(key, baseline)
      }
      this.#events.fire(changed)
    })
  }

  async reload(uri: vscode.Uri): Promise<void> {
    const source = requireSource(uri)
    const session = await this.get(source.packageUri, source.documentId)
    await this.refresh(session)
    await session.run(async () => {
      const baseline: Baseline = { generation: session.document.manifest.generation, blocked: false, restored: false }
      session.baselines.set(sourceKey(uri), baseline)
      await this.persist(sourceKey(uri), baseline)
      this.#events.fire([uri, session.packageUri])
    })
  }

  async block(uri: vscode.Uri): Promise<void> {
    const source = requireSource(uri)
    const session = await this.get(source.packageUri, source.documentId)
    await session.run(async () => {
      const baseline = session.baselines.get(sourceKey(uri))
      if (baseline) { baseline.blocked = true; await this.persist(sourceKey(uri), baseline) }
    })
  }

  requireTrusted(): void {
    if (!vscode.workspace.isTrusted) throw vscode.FileSystemError.NoPermissions('Trust this workspace before modifying MDV documents.')
  }

  retain(packageUri: vscode.Uri, documentId?: DocumentId): vscode.Disposable {
    let disposed = false
    let retained = false
    const pending = this.get(packageUri, documentId).then((session) => {
      if (!disposed) { session.pins++; retained = true }
      return session
    })
    void pending.catch(() => undefined)
    return new vscode.Disposable(() => {
      if (disposed) return
      disposed = true
      void pending.then((session) => {
        if (retained) session.pins--
        this.collect(session)
      }).catch(() => undefined)
    })
  }

  async findResourceSession(uri: vscode.Uri): Promise<DocumentSession | undefined> {
    for (const pending of this.#sessions.values()) {
      const session = await pending
      if (session.document.manifest.documentId === uri.authority) {
        const parent = vscode.Uri.joinPath(session.packageUri, '..').path.replace(/\/$/, '')
        if (uri.path === parent || uri.path.startsWith(parent + '/')) return session
      }
    }
    return undefined
  }

  dispose(): void {
    this.#disposed = true
    this.#subscriptions.forEach((item) => item.dispose())
    for (const pending of this.#sessions.values()) void pending.then((session) => session.watcher?.close()).catch(() => undefined)
    this.#sessions.clear()
    this.#events.dispose()
  }

  private async accept(session: DocumentSession, next: MdvDocument, previousGeneration: number): Promise<void> {
    session.document = next
    session.invalid = undefined
    for (const [key, baseline] of session.baselines) {
      // Only our successful CAS proves that the other working copy has not changed externally.
      if (!baseline.blocked && baseline.generation === previousGeneration) {
        baseline.generation = next.manifest.generation
        await this.persist(key, baseline)
      }
    }
    this.#events.fire([session.packageUri,
      sourceUri(session.packageUri, next.manifest.documentId, { tree: 'reference', kind: 'working-copy' }),
      sourceUri(session.packageUri, next.manifest.documentId, { tree: 'document', kind: 'working-copy' }),
    ])
  }

  private handleWriteError(session: DocumentSession, error: unknown, published: boolean): void {
    if (published || error instanceof MdvError && error.details.committed === true) {
      session.invalid = 'The write may already be saved. Reopen the package and inspect disk state before retrying.'
      this.report(new Error(session.invalid))
    }
  }

  private persist(key: string, baseline: Baseline): Thenable<void> {
    return this.state.update(`baseline:${key}`, { generation: baseline.generation, blocked: baseline.blocked })
  }

  private collect(session: DocumentSession): void {
    if (session.pins !== 0) return
    const open = vscode.workspace.textDocuments.some((document) => !document.isClosed
      && parseSource(document.uri)?.packageUri.toString() === session.packageUri.toString())
    if (!open) {
      session.watcher?.close()
      this.#sessions.delete(session.packageUri.toString())
    }
  }
}
