import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectConfig, WsMessage } from '../src/shared/types'

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('axiom', {
  // Project management
  openProjectDialog: (): Promise<ProjectConfig | null> =>
    ipcRenderer.invoke('project:open-dialog'),

  openProject: (config: ProjectConfig): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:open', config),

  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:choose-directory'),

  createProject: (parentDir: string, name: string): Promise<ProjectConfig> =>
    ipcRenderer.invoke('project:create', { parentDir, name }),

  listRecentProjects: (): Promise<ProjectConfig[]> =>
    ipcRenderer.invoke('project:list-recent'),

  removeProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:remove', projectId),

  // Mutations
  sendMutationIntent: (intent: unknown) =>
    ipcRenderer.invoke('mutation:intent', intent),

  // Node positions
  saveNodePosition: (id: string, x: number, y: number, projectId: string) =>
    ipcRenderer.invoke('node:save-position', { id, x, y, projectId }),

  // Filesystem helpers
  listDir: (dirPath: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> =>
    ipcRenderer.invoke('fs:list-dir', dirPath),

  // Shell
  showInFolder: (filePath: string) =>
    ipcRenderer.invoke('shell:show-item', filePath),

  openFile: (filePath: string) =>
    ipcRenderer.invoke('shell:open-file', filePath),

  // App info
  getAppInfo: (): Promise<{ version: string; dataDir: string; platform: string; mcpPath: string; archdApiUrl: string; archdWsUrl: string; isPackaged: boolean }> =>
    ipcRenderer.invoke('app:info'),

  // How an agent connects to this install (stdio server entry, not a URL)
  getAgentConnection: (): Promise<AgentConnection> =>
    ipcRenderer.invoke('agent:connection'),

  // Listen for messages from archd (forwarded by main process)
  onArchdMessage: (callback: (msg: WsMessage) => void) => {
    ipcRenderer.on('archd:message', (_event, msg) => callback(msg))
  },

  removeArchdListener: (callback: (msg: WsMessage) => void) => {
    ipcRenderer.removeListener('archd:message', (_event: Electron.IpcRendererEvent, msg: WsMessage) => callback(msg))
  },
})

export interface AgentConnection {
  command: string
  args: string[]
  /** False when this install has no MCP entry point on disk. */
  available: boolean
  path: string
  /** A ready-to-paste `mcpServers` entry for this machine. */
  config: string
}

// Type declaration for the renderer
declare global {
  interface Window {
    axiom: {
      openProjectDialog: () => Promise<ProjectConfig | null>
      openProject: (config: ProjectConfig) => Promise<ProjectConfig>
      chooseDirectory: () => Promise<string | null>
      createProject: (parentDir: string, name: string) => Promise<ProjectConfig>
      listRecentProjects: () => Promise<ProjectConfig[]>
      removeProject: (projectId: string) => Promise<void>
      sendMutationIntent: (intent: unknown) => void
      saveNodePosition: (id: string, x: number, y: number, projectId: string) => void
      listDir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; path: string }>>
      showInFolder: (filePath: string) => void
      openFile: (filePath: string) => void
      getAppInfo: () => Promise<{ version: string; dataDir: string; platform: string; mcpPath: string; archdApiUrl: string; archdWsUrl: string; isPackaged: boolean }>
      getAgentConnection: () => Promise<AgentConnection>
      onArchdMessage: (callback: (msg: WsMessage) => void) => void
      removeArchdListener: (callback: (msg: WsMessage) => void) => void
    }
  }
}
