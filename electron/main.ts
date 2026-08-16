import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import os from 'os'
import fs from 'fs'
import type { ProjectConfig, WsMessage } from '../src/shared/types'
import { completeSourceBoundaries, mergePersistedProjectConfig } from '../src/shared/projectLifecycle'
import { buildHosts, detectHosts, inspectHostConfiguration } from './agentInstallers'
import {
  createProjectId,
  findProjectByRoot,
  refreshProjectDiskState,
  removeProjectData,
} from './projectRegistry'

// electron-vite sets VITE_DEV_SERVER_URL in dev/preview mode only
const IS_DEV = !!process.env.VITE_DEV_SERVER_URL
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const IS_E2E = process.env.AXIOM_E2E === '1'
const IS_E2E_HOME = process.env.AXIOM_E2E_HOME === '1'  // route straight to the launcher for capture
const CONFIG_DIR = join(os.homedir(), '.axiom')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const DATA_DIR = join(os.homedir(), '.axiom', 'data')
const ARCHD_API_PORT = 7743
const ARCHD_WS_PORT = 7744

let mainWindow: BrowserWindow | null = null
let archdProcess: ChildProcess | null = null
let tray: Tray | null = null

// ─── Load/save recent projects ─────────────────────────────────────────────

function loadRecentProjects(): ProjectConfig[] {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

function saveRecentProjects(projects: ProjectConfig[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2))
}

function upsertRecentProject(config: ProjectConfig): void {
  const projects = loadRecentProjects()
  const idx = projects.findIndex(p => p.id === config.id)
  if (idx >= 0) projects[idx] = mergePersistedProjectConfig(projects[idx], config)
  else projects.unshift(config)
  saveRecentProjects(projects.slice(0, 20))
}

// Turn a user-typed project name into a safe folder name: drop path-invalid
// characters, collapse whitespace to hyphens, and trim stray separators.
function sanitizeProjectName(name: string): string {
  return (name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
}

// ─── archd daemon lifecycle ─────────────────────────────────────────────────

function archdBinaryPath(): string {
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return join(process.resourcesPath, `archd${ext}`)
  }
  // Dev: binary lives at <project-root>/archd-go/archd[.exe]
  // __dirname = out/main/ so we go up two levels to reach the project root
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(__dirname, '..', '..', 'archd-go', 'archd' + ext)
}

function startArchd(): void {
  if (archdProcess) return

  const binary = archdBinaryPath()
  if (!fs.existsSync(binary)) {
    console.warn(`[main] archd binary not found at ${binary} - run: npm run build:archd`)
    return
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })

  console.log('[main] spawning archd at:', binary)
  try {
    archdProcess = spawn(binary, [
      '-data', DATA_DIR,
      '-api-port', String(ARCHD_API_PORT),
      '-ws-port', String(ARCHD_WS_PORT),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    reportArchdLaunchError(binary, error)
    archdProcess = null
    return
  }

  archdProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write('[archd] ' + chunk.toString())
  })

  // Read newline-delimited JSON responses from archd stdout
  let buf = ''
  archdProcess.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        mainWindow?.webContents.send('archd:message', msg)
      } catch {
        console.error('[main] archd stdout parse error:', line)
      }
    }
  })

  archdProcess.on('error', (error) => {
    reportArchdLaunchError(binary, error)
    archdProcess = null
  })
  archdProcess.on('exit', (code) => {
    console.log(`[main] archd exited with code ${code}`)
    archdProcess = null
  })

  console.log('[main] archd started, pid:', archdProcess.pid)
}

function reportArchdLaunchError(binary: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[main] archd launch failed at ${binary}:`, error)
  dialog.showErrorBox(
    'Axiom backend failed to start',
    `${message}\n\nRebuild the Windows daemon with:\nnpm run build:archd`,
  )
}

function stopArchd(): void {
  if (archdProcess) {
    // SIGTERM is ignored on Windows; use taskkill to ensure the process tree is killed
    const pid = archdProcess.pid
    archdProcess.kill()
    if (pid && process.platform === 'win32') {
      require('child_process').spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { detached: true, stdio: 'ignore' })
    }
    archdProcess = null
  }
}

function sendToArchd(msg: unknown): void {
  if (!archdProcess?.stdin) return
  archdProcess.stdin.write(JSON.stringify(msg) + '\n')
}

// ─── Window creation ────────────────────────────────────────────────────────

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // On Windows: overlay native window controls on top of the custom toolbar
    ...(isWin ? {
      titleBarOverlay: {
        color: '#202b29',
        symbolColor: '#f2f1eb',
        height: 34,
      },
    } : {}),
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Axiom',
    show: false,
    // E2E windows render offscreen and never enter the taskbar. They are shown
    // with showInactive() below because Chromium will not consider screenshots
    // geometrically stable while a BrowserWindow remains fully hidden.
    skipTaskbar: IS_E2E,
  })

  if (IS_DEV && DEV_SERVER_URL) {
    const rendererUrl = new URL(DEV_SERVER_URL)
    if (IS_E2E) rendererUrl.searchParams.set('e2e', '1')
    if (IS_E2E_HOME) rendererUrl.searchParams.set('home', '1')
    mainWindow.loadURL(rendererUrl.toString())
    if (!IS_E2E) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      IS_E2E ? { query: IS_E2E_HOME ? { e2e: '1', home: '1' } : { e2e: '1' } } : undefined,
    )
  }

  if (IS_E2E) {
    const showForAutomation = () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
      // Keep a conventionally rendered window (required for reliable canvas
      // screenshots) far outside every practical desktop, and never activate
      // it. Unlike show(), showInactive() cannot take keyboard focus.
      mainWindow.setPosition(-32000, -32000, false)
      mainWindow.showInactive()
    }
    mainWindow.once('ready-to-show', showForAutomation)
    mainWindow.webContents.once('did-finish-load', showForAutomation)
  } else {
    // Show as soon as the renderer is usable. ready-to-show alone is NOT
    // reliable on Windows (it can simply never fire for initially-hidden
    // windows on some GPU/driver combos - the app stays invisible while
    // everything else runs). did-finish-load always fires, so show on
    // whichever comes first, with a timed fallback as the last resort.
    const showOnce = (source: string) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log(`[main] showing window (${source})`)
        mainWindow.maximize()
        mainWindow.show()
      }
    }
    mainWindow.once('ready-to-show', () => showOnce('ready-to-show'))
    mainWindow.webContents.once('did-finish-load', () => showOnce('did-finish-load'))
    setTimeout(() => showOnce('fallback-timer'), 5000)
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] renderer failed to load: ${code} ${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer process gone:', details.reason, details.exitCode)
  })
  mainWindow.on('unresponsive', () => {
    console.error('[main] renderer is unresponsive')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────

function setupIPC(): void {
  // Open a project directory - returns config only; caller is responsible for sending to archd
  ipcMain.handle('project:open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Open Project',
    })
    if (result.canceled || !result.filePaths[0]) return null

    const rootPath = result.filePaths[0]
    const existing = findProjectByRoot(loadRecentProjects(), rootPath)
    const id = existing?.id ?? createProjectId()
    const freshConfig: ProjectConfig = {
      id,
      name: rootPath.split(/[/\\]/).pop() ?? 'Project',
      rootPath,
      creationSource: 'open-codebase',
      rootIsEmpty: fs.readdirSync(rootPath).length === 0,
      ignoredPaths: [],
      languageOverrides: {},
      layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
      openedAt: Date.now(),
    }
    let config = mergePersistedProjectConfig(existing, freshConfig)
    // An empty codebase has no source scope to choose, but it still follows the
    // Open Codebase journey because the launcher action is authoritative.
    if (config.rootIsEmpty) {
      config = completeSourceBoundaries(config, [])
    }
    upsertRecentProject(config)
    return config
  })

  // Open a specific project path directly
  ipcMain.handle('project:open', async (_event, config: ProjectConfig) => {
    const currentConfig = refreshProjectDiskState({ ...config, openedAt: Date.now() })
    upsertRecentProject(currentConfig)
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      join(DATA_DIR, 'active_project.json'),
      JSON.stringify({ workspaceId: currentConfig.id, name: currentConfig.name, rootPath: currentConfig.rootPath }, null, 2)
    )
    sendToArchd({ type: 'open:project', payload: currentConfig })
    return currentConfig
  })

  // Choose a directory to hold a new project (New Project flow → location).
  ipcMain.handle('dialog:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a location for the new project',
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // Create a project from scratch: make an empty folder that an agent (or the
  // user) can build into, then hand back a config the renderer opens like any
  // other project. The live Floor then materializes files as they appear.
  ipcMain.handle('project:create', async (_event, { parentDir, name }: { parentDir: string; name: string }) => {
    const safe = sanitizeProjectName(name)
    if (!safe) throw new Error('Project name is empty or contains only invalid characters.')
    if (!parentDir) throw new Error('No location was chosen for the project.')
    const rootPath = join(parentDir, safe)
    if (fs.existsSync(rootPath) && fs.readdirSync(rootPath).length > 0) {
      throw new Error(`A non-empty folder named "${safe}" already exists here.`)
    }
    fs.mkdirSync(rootPath, { recursive: true })
    const id = createProjectId()
    const config: ProjectConfig = completeSourceBoundaries({
      id,
      name: safe,
      rootPath,
      creationSource: 'new-project',
      rootIsEmpty: true,
      ignoredPaths: [],
      languageOverrides: {},
      layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
      openedAt: Date.now(),
    }, [])
    upsertRecentProject(config)
    return config
  })

  // Get recent projects
  ipcMain.handle('project:list-recent', () => loadRecentProjects().map(refreshProjectDiskState))

  // Deleting is a verified lifecycle boundary. Keep the recent entry if any
  // daemon or filesystem step fails so the UI cannot claim data was removed.
  ipcMain.handle('project:remove', async (_event, projectId: string) => {
    await removeProjectData({ projectId, dataDir: DATA_DIR, apiPort: ARCHD_API_PORT })
    saveRecentProjects(loadRecentProjects().filter(project => project.id !== projectId))
  })

  // Send a mutation intent to archd
  ipcMain.handle('mutation:intent', (_event, intent) => {
    sendToArchd({ type: 'mutation:intent', payload: intent })
  })

  // Save node position
  ipcMain.handle('node:save-position', (_event, { id, x, y, projectId }) => {
    // Positions are saved by archd via the store
    sendToArchd({ type: 'node:position', payload: { id, x, y, projectId } })
  })

  // List directory contents for project setup screen
  ipcMain.handle('fs:list-dir', (_event, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: join(dirPath, e.name),
      }))
    } catch {
      return []
    }
  })

  // Show item in Finder/Explorer
  ipcMain.handle('shell:show-item', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // Open file in default editor
  ipcMain.handle('shell:open-file', (_event, filePath: string) => {
    shell.openPath(filePath)
  })

  // Get app info (includes archd ports so renderer can connect)
  ipcMain.handle('app:info', () => {
    const isPackaged = app.isPackaged
    const mcpPath = isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.js')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    return {
      version: app.getVersion(),
      dataDir: join(os.homedir(), '.axiom'),
      platform: process.platform,
      archdApiUrl: `http://127.0.0.1:${ARCHD_API_PORT}`,
      archdWsUrl: `ws://127.0.0.1:${ARCHD_WS_PORT}/ws`,
      mcpPath,
      isPackaged,
    }
  })

  // Which agents are on this machine, and what each install would touch.
  ipcMain.handle('agent:hosts', (_event, projectRoot?: string) => {
    const present = detectHosts()
    return buildHosts().map(host => {
      const configuration = inspectHostConfiguration(host, projectRoot)
      return {
        id: host.id,
        label: host.label,
        detected: present[host.id] === true,
        configPath: host.configPath(),
        command: host.command ?? null,
        ...configuration,
      }
    })
  })

  // Install Axiom into one agent: its MCP server entry and reusable workflow
  // where the host supports one. An action, not an instruction.
  ipcMain.handle('agent:install', (_event, hostId: string, projectRoot?: string) => {
    const host = buildHosts().find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".`, paths: [] }
    const mcpPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.js')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    if (!fs.existsSync(mcpPath)) {
      return { ok: false, detail: `This Axiom install has no MCP server at ${mcpPath}.`, paths: [] }
    }
    try {
      return host.install('node', [mcpPath], NAME_ARCHITECTURE_COMMAND, projectRoot)
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        paths: [host.configPath()],
      }
    }
  })

  // How an agent actually connects. Axiom speaks MCP over stdio, so the thing a
  // user needs is a server entry naming this install - never a URL. The old
  // invitation copied http://127.0.0.1:7743/mcp, which archd does not serve and
  // never did, so following the app's own instruction could not work.
  ipcMain.handle('agent:connection', () => {
    const mcpPath = app.isPackaged
      ? join(process.resourcesPath, 'mcp', 'axiom-mcp.js')
      : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
    const args = [mcpPath]
    return {
      command: 'node',
      args,
      // Reported rather than assumed: a missing entry point is the difference
      // between "paste this" and "your install is incomplete", and the user
      // should be told which one they are looking at.
      available: fs.existsSync(mcpPath),
      path: mcpPath,
      config: JSON.stringify(
        { mcpServers: { axiom: { command: 'node', args } } },
        null,
        2,
      ),
    }
  })
}


// The body of Axiom's architecture-mapping workflow. Kept beside the installer
// so the workflow a user invokes and the instructions Axiom means to give are
// the same text, rather than two copies that drift.
const NAME_ARCHITECTURE_COMMAND = `# Axiom - map this codebase's architecture

Map this codebase's architecture for its owner, who is watching a spatial map
of it in Axiom. Produce a TREE OF SEMANTIC SYSTEMS.

**What a system is.** A responsibility - something the codebase does. Name it
the way an engineer would say it aloud explaining the project to a new
colleague.

A system is NOT a folder. Folders are for navigation; never use them as the
answer. Two files in different directories belong to the same system when they
serve the same responsibility, and one directory often holds several distinct
systems.

**Nesting is the point.** Every system may contain sub-systems, and those may
contain more. Go as deep as the code justifies - a large area earns four or
five levels, a small utility earns none. If a system holds more than about ten
files, ask whether it is really one thing or several. There may be hundreds of
systems in the tree; what must stay small is how many appear at any one level.

**Shape.** Around a dozen systems at the top - the parts you would list if
asked what this application is made of. For each: a name of two to four words,
one sentence saying what it is responsible for, and for leaf systems the files
that belong to it.

**How to work.** Start from the file tree only to orient yourself. Then READ.
Open entry points, the largest files, anything whose name suggests it
coordinates others. Do not infer from filenames - a file called utils.ts may be
the core of a system. Do not begin from the systems already on the map: those
were named automatically from word frequency and describe nothing.

**Submit it** with Axiom's \`edit_systems\` tool using \`op: "propose"\`, passing the
whole tree in one call: each entry takes a systemKey, name, description, an
optional parentKey naming another proposed system, and files (repository-relative
paths) for leaf systems.

The human confirms, renames or rejects each system. Nothing reaches their map
until they do.
`

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  setupIPC()
  if (!IS_E2E) startArchd()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopArchd()
    app.quit()
  }
})

app.on('before-quit', () => {
  stopArchd()
})

// Ensure archd is killed if the process is terminated via Ctrl+C or signal
process.on('SIGINT', () => { stopArchd(); process.exit(0) })
process.on('SIGTERM', () => { stopArchd(); process.exit(0) })

// Security: prevent navigation to external URLs
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    const devOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : null
    if (parsedUrl.origin !== devOrigin && !navigationUrl.startsWith('file://')) {
      event.preventDefault()
    }
  })
})
