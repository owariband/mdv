import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MdvSession,
  issueReferenceWritePermit,
  toDesktopFailure,
} from './mdv-session.js'
import {
  FolderWorkspace,
  FolderWorkspaceError,
  type ResolvedWorkspaceDocument,
  toWorkspaceFailure,
} from './folder-workspace.js'
import {
  MarkdownSession,
  toMarkdownFailure,
} from './markdown-session.js'
import {
  ipcChannels,
  type DesktopFailure,
  type DesktopResult,
  type FolderWorkspaceView,
  type OpenWorkspaceDocumentRequest,
  type OpenedDocumentView,
  type SaveMarkdownResult,
  type SaveTreeRequest,
  type SaveTreeResult,
  type WorkspaceActionRequest,
  type WorkspaceActionResult,
  type WorkspaceContextAction,
  type WorkspaceNodeRequest,
  type WorkspaceRequest,
} from '../shared/ipc.js'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
let mainWindow: BrowserWindow | undefined
type ActiveSession =
  | { readonly kind: 'mdv'; readonly session: MdvSession }
  | { readonly kind: 'markdown'; readonly session: MarkdownSession }

let activeSession: ActiveSession | undefined
let activeWorkspace: FolderWorkspace | undefined
let navigationEpoch = 0
let workspaceEpoch = 0

interface E2eDialogPlan {
  readonly openFile: string | undefined
  readonly openDirectory: string | undefined
  readonly referenceResponses: readonly (0 | 1)[]
  readonly contextActions: readonly WorkspaceContextAction[]
  readonly workspaceOpenDelayMs: number
}

const e2eDialogPlan = readE2eDialogPlan()
let e2eReferenceResponse = 0
let e2eContextAction = 0

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1b1c',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
    } : {}),
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
      activeSession = undefined
      activeWorkspace = undefined
      navigationEpoch += 1
      workspaceEpoch += 1
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadFile(join(currentDirectory, '../renderer/index.html'))

  return window
}

function registerIpc(): void {
  ipcMain.handle(ipcChannels.openDocument, async (event): Promise<DesktopResult<OpenedDocumentView | null>> => {
    try {
      const window = requireTrustedSender(event)
      const requestEpoch = ++navigationEpoch
      const selectedFile = await selectDocumentFile(window)
      if (!selectedFile) return { ok: true, value: null }
      return {
        ok: true,
        value: await activateDocument(window, selectedDocumentTarget(selectedFile), requestEpoch),
      }
    } catch (error) {
      report(error)
      return { ok: false, error: toPublicFailure(error) }
    }
  })

  ipcMain.handle(
    ipcChannels.selectWorkspace,
    async (event): Promise<DesktopResult<FolderWorkspaceView | null>> => {
      try {
        const window = requireTrustedSender(event)
        const requestEpoch = ++workspaceEpoch
        navigationEpoch += 1
        const selectedDirectory = await selectWorkspaceDirectory(window)
        if (!selectedDirectory) return { ok: true, value: null }

        const opened = await FolderWorkspace.open(selectedDirectory)
        if (requestEpoch !== workspaceEpoch) {
          throw new FolderWorkspaceError('STALE_WORKSPACE', 'A newer workspace selection replaced this request.')
        }
        activeWorkspace = opened.workspace
        if (!activeSession) window.setTitle(`${opened.view.root.name} — milkdownv`)
        return { ok: true, value: opened.view }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.refreshWorkspace,
    async (event, request: WorkspaceRequest): Promise<DesktopResult<FolderWorkspaceView>> => {
      try {
        requireTrustedSender(event)
        const workspace = requireWorkspace(request)
        const view = await workspace.refresh()
        if (activeWorkspace !== workspace) {
          throw new FolderWorkspaceError('STALE_WORKSPACE', 'The workspace changed while it was refreshing.')
        }
        return { ok: true, value: view }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.openWorkspaceDocument,
    async (event, request: OpenWorkspaceDocumentRequest): Promise<DesktopResult<OpenedDocumentView>> => {
      try {
        const window = requireTrustedSender(event)
        const workspace = requireWorkspace(request)
        if (!request || typeof request.nodeId !== 'string') {
          throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace document request is invalid.')
        }
        const requestEpoch = ++navigationEpoch
        const target = await workspace.resolveDocument(request.nodeId)
        if (e2eDialogPlan && e2eDialogPlan.workspaceOpenDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, e2eDialogPlan.workspaceOpenDelayMs))
        }
        return {
          ok: true,
          value: await activateDocument(window, target, requestEpoch, async () => {
            if (activeWorkspace !== workspace) {
              throw new FolderWorkspaceError('STALE_WORKSPACE', 'The workspace changed while opening the document.')
            }
            const current = await workspace.resolveDocument(request.nodeId)
            if (current.kind !== target.kind || current.path !== target.path) {
              throw new FolderWorkspaceError('STALE_ENTRY', 'The workspace item changed while it was opening.')
            }
          }),
        }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.showWorkspaceContextMenu,
    async (
      event,
      request: WorkspaceNodeRequest,
    ): Promise<DesktopResult<WorkspaceContextAction | null>> => {
      try {
        const window = requireTrustedSender(event)
        const workspace = requireWorkspace(request)
        const node = await workspace.resolveNode(request?.nodeId)
        return { ok: true, value: await selectWorkspaceContextAction(window, node.kind, node.root) }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.runWorkspaceAction,
    async (
      event,
      request: WorkspaceActionRequest,
    ): Promise<DesktopResult<WorkspaceActionResult>> => {
      try {
        const window = requireTrustedSender(event)
        const workspace = requireWorkspace(request)
        if (!request || typeof request !== 'object' || typeof request.action !== 'string') {
          throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace action is invalid.')
        }

        if (request.action === 'new-file') {
          const result = await workspace.createMarkdownFile(request.nodeId, request.name)
          return { ok: true, value: { workspace: result.view, nodeId: result.nodeId } }
        }
        if (request.action === 'new-folder') {
          const result = await workspace.createDirectory(request.nodeId, request.name)
          return { ok: true, value: { workspace: result.view, nodeId: result.nodeId } }
        }
        if (request.action === 'duplicate') {
          const result = await workspace.duplicateMarkdown(request.nodeId)
          return { ok: true, value: { workspace: result.view, nodeId: result.nodeId } }
        }
        if (request.action === 'rename') {
          const target = await workspace.resolveNode(request.nodeId)
          let result
          try {
            result = await workspace.renameEntry(request.nodeId, request.name)
          } catch (error) {
            if (error instanceof FolderWorkspaceError && error.committed) {
              const activeDocumentInvalidated = deactivateSessionWithin(
                window,
                workspace,
                target.path,
                target.kind === 'directory',
              )
              throw new FolderWorkspaceError(
                error.code,
                error.message,
                true,
                activeDocumentInvalidated,
              )
            }
            throw error
          }
          const activeDocumentInvalidated = deactivateSessionWithin(
            window,
            workspace,
            target.path,
            target.kind === 'directory',
          )
          return {
            ok: true,
            value: {
              workspace: result.view,
              nodeId: result.nodeId,
              ...(activeDocumentInvalidated ? { activeDocumentInvalidated: true as const } : {}),
            },
          }
        }
        if (request.action === 'move-to-trash') {
          const target = await workspace.resolveNode(request.nodeId)
          if (target.root) {
            throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace root cannot be moved to Trash here.')
          }
          try {
            await shell.trashItem(target.path)
          } catch {
            throw new FolderWorkspaceError('IO_ERROR', 'The workspace item could not be moved to Trash.')
          }
          const activeDocumentInvalidated = deactivateSessionWithin(
            window,
            workspace,
            target.path,
            target.kind === 'directory',
          )
          try {
            return {
              ok: true,
              value: {
                workspace: await workspace.refreshAfterExternalChange(),
                ...(activeDocumentInvalidated ? { activeDocumentInvalidated: true as const } : {}),
              },
            }
          } catch {
            throw new FolderWorkspaceError(
              'IO_ERROR',
              'The item was moved to Trash, but the folder could not be refreshed.',
              true,
              activeDocumentInvalidated,
            )
          }
        }
        if (request.action === 'copy-path') {
          const target = await workspace.resolveNode(request.nodeId)
          clipboard.writeText(target.path)
          return { ok: true, value: {} }
        }
        if (request.action === 'show-in-finder') {
          const target = await workspace.resolveNode(request.nodeId)
          shell.showItemInFolder(target.path)
          return { ok: true, value: {} }
        }
        throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The workspace action is invalid.')
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.saveDocument,
    async (event, request: SaveTreeRequest): Promise<DesktopResult<SaveTreeResult>> => {
      try {
        requireTrustedSender(event)
        const session = requireMdvSession(request)
        return { ok: true, value: await session.saveDocument(request) }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.saveReference,
    async (event, request: SaveTreeRequest): Promise<DesktopResult<SaveTreeResult>> => {
      try {
        const window = requireTrustedSender(event)
        const session = requireMdvSession(request)
        if (!await confirmReferenceSave(window, session.packagePath)) {
          return {
            ok: false,
            error: {
              code: 'USER_CANCELLED',
              message: 'Reference was not saved.',
              tree: 'reference',
            },
          }
        }
        return {
          ok: true,
          value: await session.saveReference(request, issueReferenceWritePermit()),
        }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )

  ipcMain.handle(
    ipcChannels.saveMarkdown,
    async (event, request: SaveTreeRequest): Promise<DesktopResult<SaveMarkdownResult>> => {
      try {
        requireTrustedSender(event)
        const session = requireMarkdownSession(request)
        return { ok: true, value: await session.saveMarkdown(request) }
      } catch (error) {
        report(error)
        return { ok: false, error: toPublicFailure(error) }
      }
    },
  )
}

async function selectDocumentFile(window: BrowserWindow): Promise<string | undefined> {
  if (e2eDialogPlan) {
    if (!e2eDialogPlan.openFile) throw new Error('The milkdownv E2E dialog plan has no openFile')
    return e2eDialogPlan.openFile
  }

  const selection = await dialog.showOpenDialog(window, {
    title: 'Open a document',
    properties: ['openFile'],
    filters: [
      { name: 'MDV and Markdown documents', extensions: ['mdv', 'md'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return selection.canceled ? undefined : selection.filePaths[0]
}

function selectedDocumentTarget(filePath: string): ResolvedWorkspaceDocument {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new FolderWorkspaceError('INVALID_ARGUMENT', 'The selected document is invalid.')
  }
  const extension = extname(filePath).toLowerCase()
  if (extension === '.mdv') return { kind: 'mdv', path: filePath }
  if (extension === '.md') return { kind: 'markdown', path: filePath }
  throw new FolderWorkspaceError(
    'INVALID_ARGUMENT',
    'Only MDV and Markdown documents can be opened.',
  )
}

async function selectWorkspaceDirectory(window: BrowserWindow): Promise<string | undefined> {
  if (e2eDialogPlan) {
    if (!e2eDialogPlan.openDirectory) throw new Error('The milkdownv E2E dialog plan has no openDirectory')
    return e2eDialogPlan.openDirectory
  }

  const selection = await dialog.showOpenDialog(window, {
    title: 'Open a folder',
    properties: ['openDirectory'],
  })
  return selection.canceled ? undefined : selection.filePaths[0]
}

function selectWorkspaceContextAction(
  window: BrowserWindow,
  kind: 'directory' | 'mdv' | 'markdown',
  root: boolean,
): Promise<WorkspaceContextAction | null> {
  if (e2eDialogPlan) {
    const action = e2eDialogPlan.contextActions[e2eContextAction]
    if (!action) throw new Error('The milkdownv E2E dialog plan has no remaining context action')
    if (!workspaceContextActionAvailable(action, kind, root)) {
      throw new Error(`The milkdownv E2E context action ${action} is unavailable for this item`)
    }
    e2eContextAction += 1
    return Promise.resolve(action)
  }

  return new Promise((resolve) => {
    let selected: WorkspaceContextAction | null = null
    const item = (
      label: string,
      action: WorkspaceContextAction,
    ): MenuItemConstructorOptions => ({
      label,
      click: () => {
        selected = action
      },
    })
    const createItems: MenuItemConstructorOptions[] = [
      item('New File', 'new-file'),
      item('New Folder', 'new-folder'),
    ]
    const locateItems: MenuItemConstructorOptions[] = [
      item('Copy Path', 'copy-path'),
      item('Show in Finder', 'show-in-finder'),
    ]
    let template: MenuItemConstructorOptions[]

    if (kind === 'directory') {
      template = [
        ...createItems,
        ...(!root ? [
          { type: 'separator' as const },
          item('Rename…', 'rename'),
          item('Move to Trash…', 'move-to-trash'),
        ] : []),
        { type: 'separator' },
        ...locateItems,
      ]
    } else {
      template = [
        item('Open', 'open'),
        { type: 'separator' },
        ...createItems,
        ...(kind === 'markdown' ? [
          { type: 'separator' as const },
          item('Duplicate', 'duplicate'),
        ] : []),
        { type: 'separator' },
        item('Rename…', 'rename'),
        item('Move to Trash…', 'move-to-trash'),
        { type: 'separator' },
        ...locateItems,
      ]
    }

    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => resolve(selected),
    })
  })
}

async function activateDocument(
  window: BrowserWindow,
  target: ResolvedWorkspaceDocument,
  requestEpoch: number,
  validateBeforeActivation?: () => Promise<void>,
): Promise<OpenedDocumentView> {
  const opened = target.kind === 'mdv'
    ? { kind: 'mdv' as const, ...await MdvSession.open(target.path) }
    : { kind: 'markdown' as const, ...await MarkdownSession.open(target.path) }
  if (requestEpoch !== navigationEpoch) {
    throw new FolderWorkspaceError('STALE_ENTRY', 'A newer document selection replaced this request.')
  }
  await validateBeforeActivation?.()
  if (requestEpoch !== navigationEpoch) {
    throw new FolderWorkspaceError('STALE_ENTRY', 'A newer document selection replaced this request.')
  }
  activeSession = opened.kind === 'mdv'
    ? { kind: 'mdv', session: opened.session }
    : { kind: 'markdown', session: opened.session }
  window.setTitle(`${opened.view.displayName} — milkdownv`)
  return opened.view
}

async function confirmReferenceSave(window: BrowserWindow, packagePath: string): Promise<boolean> {
  if (e2eDialogPlan) {
    const response = e2eDialogPlan.referenceResponses[e2eReferenceResponse]
    if (response === undefined) {
      throw new Error('The milkdownv E2E dialog plan has no remaining Reference response')
    }
    e2eReferenceResponse += 1
    return response === 1
  }

  const confirmation = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Save Reference working copy?',
    message: 'Save changes to this document’s Reference?',
    detail: `${packagePath}\n\nThis modifies the Reference working copy but does not create a version.`,
    buttons: ['Cancel', 'Save Reference'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return confirmation.response === 1
}

function readE2eDialogPlan(): E2eDialogPlan | undefined {
  const source = process.env.MDV_DESKTOP_E2E_DIALOG_PLAN
  if (!source || app.isPackaged || process.defaultApp !== true) return undefined

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('MDV_DESKTOP_E2E_DIALOG_PLAN must contain valid JSON')
  }
  if (!isRecord(value)
    || (value.openFile !== undefined && (typeof value.openFile !== 'string' || !isAbsolute(value.openFile)))
    || (value.openDirectory !== undefined
      && (typeof value.openDirectory !== 'string' || !isAbsolute(value.openDirectory)))
    || (value.openFile === undefined && value.openDirectory === undefined)
    || !Array.isArray(value.referenceResponses)
    || value.referenceResponses.some((response) => response !== 0 && response !== 1)
    || (value.contextActions !== undefined
      && (!Array.isArray(value.contextActions)
        || value.contextActions.some((action) => !isWorkspaceContextAction(action))))
    || (value.workspaceOpenDelayMs !== undefined
      && (typeof value.workspaceOpenDelayMs !== 'number'
        || !Number.isInteger(value.workspaceOpenDelayMs)
        || value.workspaceOpenDelayMs < 0
        || value.workspaceOpenDelayMs > 1_000))) {
    throw new Error(
      'MDV_DESKTOP_E2E_DIALOG_PLAN must contain valid paths, Reference responses, and context actions',
    )
  }
  return {
    openFile: typeof value.openFile === 'string' ? value.openFile : undefined,
    openDirectory: typeof value.openDirectory === 'string' ? value.openDirectory : undefined,
    referenceResponses: value.referenceResponses,
    contextActions: Array.isArray(value.contextActions) ? value.contextActions : [],
    workspaceOpenDelayMs: typeof value.workspaceOpenDelayMs === 'number'
      ? value.workspaceOpenDelayMs
      : 0,
  }
}

function isWorkspaceContextAction(value: unknown): value is WorkspaceContextAction {
  return value === 'open'
    || value === 'new-file'
    || value === 'new-folder'
    || value === 'duplicate'
    || value === 'rename'
    || value === 'move-to-trash'
    || value === 'copy-path'
    || value === 'show-in-finder'
}

function workspaceContextActionAvailable(
  action: WorkspaceContextAction,
  kind: 'directory' | 'mdv' | 'markdown',
  root: boolean,
): boolean {
  if (action === 'open') return kind !== 'directory'
  if (action === 'duplicate') return kind === 'markdown'
  if (action === 'rename' || action === 'move-to-trash') return !root
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireTrustedSender(event: IpcMainInvokeEvent): BrowserWindow {
  if (!mainWindow
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Rejected IPC from an unknown renderer')
  }
  return mainWindow
}

function requireMdvSession(request: SaveTreeRequest): MdvSession {
  if (!request
    || typeof request !== 'object'
    || activeSession?.kind !== 'mdv'
    || request.sessionId !== activeSession.session.id) {
    throw new Error('The active MDV session changed; reopen the document before saving')
  }
  return activeSession.session
}

function requireMarkdownSession(request: SaveTreeRequest): MarkdownSession {
  if (!request
    || typeof request !== 'object'
    || activeSession?.kind !== 'markdown'
    || request.sessionId !== activeSession.session.id) {
    throw new Error('The active Markdown session changed; reopen the document before saving')
  }
  return activeSession.session
}

function requireWorkspace(request: WorkspaceRequest): FolderWorkspace {
  if (!request
    || typeof request !== 'object'
    || typeof request.workspaceId !== 'string'
    || !activeWorkspace
    || request.workspaceId !== activeWorkspace.id) {
    throw new FolderWorkspaceError('STALE_WORKSPACE', 'The active workspace changed. Open the folder again.')
  }
  return activeWorkspace
}

function deactivateSessionWithin(
  window: BrowserWindow,
  workspace: FolderWorkspace,
  targetPath: string,
  directory: boolean,
): boolean {
  const sessionPath = activeSession?.kind === 'mdv'
    ? activeSession.session.packagePath
    : activeSession?.session.filePath
  if (!sessionPath) return false
  const relativePath = relative(targetPath, sessionPath)
  const affected = directory
    ? relativePath === ''
      || (relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath))
    : targetPath === sessionPath
  if (!affected) return false

  activeSession = undefined
  navigationEpoch += 1
  window.setTitle(`${workspace.view.root.name} — milkdownv`)
  return true
}

function report(error: unknown): void {
  const failure = toPublicFailure(error)
  console.error(`[milkdownv] ${failure.code}: ${failure.message}`)
}

function toPublicFailure(error: unknown): DesktopFailure {
  return toWorkspaceFailure(error) ?? toMarkdownFailure(error) ?? toDesktopFailure(error)
}

app.setName('milkdownv')
void app.whenReady().then(() => {
  registerIpc()
  mainWindow = createWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
