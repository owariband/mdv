import { contextBridge, ipcRenderer } from 'electron'
import {
  ipcChannels,
  type MdvDesktopApi,
  type OpenWorkspaceDocumentRequest,
  type SaveTreeRequest,
  type WorkspaceActionRequest,
  type WorkspaceNodeRequest,
  type WorkspaceRequest,
} from '../shared/ipc.js'

const api: MdvDesktopApi = Object.freeze({
  openDocument: () => ipcRenderer.invoke(ipcChannels.openDocument),
  selectWorkspace: () => ipcRenderer.invoke(ipcChannels.selectWorkspace),
  refreshWorkspace: (request: WorkspaceRequest) => ipcRenderer.invoke(ipcChannels.refreshWorkspace, request),
  openWorkspaceDocument: (request: OpenWorkspaceDocumentRequest) => (
    ipcRenderer.invoke(ipcChannels.openWorkspaceDocument, request)
  ),
  showWorkspaceContextMenu: (request: WorkspaceNodeRequest) => (
    ipcRenderer.invoke(ipcChannels.showWorkspaceContextMenu, request)
  ),
  runWorkspaceAction: (request: WorkspaceActionRequest) => (
    ipcRenderer.invoke(ipcChannels.runWorkspaceAction, request)
  ),
  saveDocument: (request: SaveTreeRequest) => ipcRenderer.invoke(ipcChannels.saveDocument, request),
  saveReference: (request: SaveTreeRequest) => ipcRenderer.invoke(ipcChannels.saveReference, request),
  saveMarkdown: (request: SaveTreeRequest) => ipcRenderer.invoke(ipcChannels.saveMarkdown, request),
})

contextBridge.exposeInMainWorld('mdvDesktop', api)
