import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { extname, isAbsolute, join } from 'node:path'
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
}

const e2eDialogPlan = readE2eDialogPlan()
let e2eReferenceResponse = 0

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
    || value.referenceResponses.some((response) => response !== 0 && response !== 1)) {
    throw new Error(
      'MDV_DESKTOP_E2E_DIALOG_PLAN must contain an absolute openFile or openDirectory and 0/1 Reference responses',
    )
  }
  return {
    openFile: typeof value.openFile === 'string' ? value.openFile : undefined,
    openDirectory: typeof value.openDirectory === 'string' ? value.openDirectory : undefined,
    referenceResponses: value.referenceResponses,
  }
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
