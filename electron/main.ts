import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, session, clipboard, screen, crashReporter } from 'electron'
import { readWindowState, restorableBounds, writeWindowState } from './windowState'
import { initUpdates } from './updates'
import { chooseEditor, detectEditors, isInside, safeForSystemOpen } from './fileAccess'
import { estimateScope } from './scopeEstimate'
import { parseAxiomUrl, parseLaunchArgs, type LaunchRequest } from './launchRequests'
import { installCliLauncher } from './cliLauncher'
import { changelogSection, shouldShowWhatsNew } from './whatsNew'
import { applyApplicationMenu, runMenuRole, type MenuState } from './appMenu'
import { clampZoom, normalizeSettings, patchSettings, UI_ZOOM_STEP, type AppSettings } from '../src/shared/appSettings'
import type { SystemRole } from '../src/shared/appMenu'
import { format } from 'util'
import { createLogs, formatDiagnostics, timestamped } from './logging'
import { readDaemonToken } from './daemonAuth'
import { dirname, join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import os from 'os'
import fs from 'fs'
import type { ProjectConfig, WsMessage } from '../src/shared/types'
import { completeSourceBoundaries, mergePersistedProjectConfig } from '../src/shared/projectLifecycle'
import { buildHosts, detectHosts, inspectHostConfiguration, installFamily } from './agentInstallers'
import { uninstallAll, uninstallHost } from './agentUninstall'
import { resolveNodeCommand } from './platformPaths'
import { readOverrides, setOverride, clearOverride } from './agentOverrides'
import { DeliveryRunner, deliveryTargets, deliveryArguments, checkDeliveryMessage } from './agentDelivery'
import { workOrderHandoff } from '../src/shared/workOrderHandoff'
import type { DeliveryRequest } from '../src/shared/agentDelivery'
import {
  createProjectId,
  exportManifest,
  findProjectByRoot,
  importedProjectConfig,
  listTrash,
  migrateIndexedProjectLifecycle,
  purgeExpiredTrash,
  restoreTrash,
  trashEntryPath,
  writeTrashMeta,
  refreshProjectDiskState,
  relocateProjectConfig,
  readResumeProjectId,
  removeProjectData,
  writeResumeProjectId,
} from './projectRegistry'

// electron-vite injects ELECTRON_RENDERER_URL in dev. The name matters: this
// used to read VITE_DEV_SERVER_URL, which is vite-plugin-electron's variable
// and one electron-vite never sets - so IS_DEV was always false and `npm run
// dev` silently served the last `npm run build` output from disk instead of
// the dev server. A stale out/renderer therefore rendered an arbitrarily old
// UI, and hot reload never worked at all.
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL
const IS_DEV = !!DEV_SERVER_URL
const IS_E2E = process.env.AXIOM_E2E === '1'
const IS_E2E_HOME = process.env.AXIOM_E2E_HOME === '1'  // route straight to the launcher for capture
const CONFIG_DIR = join(os.homedir(), '.axiom')
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json')
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')
const DATA_DIR = join(os.homedir(), '.axiom', 'data')
const LOG_DIR = join(CONFIG_DIR, 'logs')
const deliveryRunner = new DeliveryRunner(join(CONFIG_DIR, 'delivery'))
const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json')
// Where "Report a Bug" leads. Update alongside the repository if it moves.
const ISSUES_URL = 'https://github.com/maxwmeadow/Axiom/issues/new'
// archd prefers these ports and falls back to free ones if another program
// holds them (-auto-ports). The ports actually in use come from daemon.json.
interface ArchdPorts { api: number; ws: number; runtime: number }
const PREFERRED_PORTS: ArchdPorts = { api: 7743, ws: 7744, runtime: 7745 }
let archdPorts: ArchdPorts = { ...PREFERRED_PORTS }

function setArchdPorts(next: ArchdPorts): void {
  if (next.api === archdPorts.api && next.ws === archdPorts.ws && next.runtime === archdPorts.runtime) return
  archdPorts = next
  console.log(`[main] archd ports: api ${next.api}, ws ${next.ws}, runtime ${next.runtime}`)
  mainWindow?.webContents.send('archd:ports', archdPorts)
}

// Everything the main process says also lands in ~/.axiom/logs, so a user
// who hits a problem has something to look at, or to attach to a report.
const logs = createLogs(LOG_DIR)
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    original(...args)
    logs.main.write(timestamped(level === 'log' ? 'info' : level, format(...args)))
  }
}

// Crashes are kept on this machine (Electron minidumps) and counted in
// diagnostics. Nothing is uploaded: an opt-in upload needs a destination
// Axiom does not have yet (see WORK.md).
crashReporter.start({ uploadToServer: false })
process.on('uncaughtException', error => console.error('[main] uncaught exception:', error))
process.on('unhandledRejection', reason => console.error('[main] unhandled rejection:', reason))

let mainWindow: BrowserWindow | null = null
let archdProcess: ChildProcess | null = null
let tray: Tray | null = null
// Set once the app is really leaving, so archd exiting then is expected.
let quitting = false
// The project the window has open, re-registered with archd after a restart
// so its file watchers come back without the user doing anything.
let activeProject: ProjectConfig | null = null
const archdRestarts: number[] = []
const ARCHD_RESTART_LIMIT = 5
const ARCHD_RESTART_WINDOW_MS = 60_000
let archdRecentStderr: string[] = []

// ─── Load/save recent projects ─────────────────────────────────────────────

function loadRecentProjects(): ProjectConfig[] {
  try {
    const data = fs.readFileSync(PROJECTS_FILE, 'utf8')
    const stored = JSON.parse(data) as ProjectConfig[]
    const migrated = stored.map(project => migrateIndexedProjectLifecycle(project, DATA_DIR))
    if (migrated.some((project, index) => project !== stored[index])) {
      try { saveRecentProjects(migrated) } catch { /* still return the readable registry */ }
    }
    return migrated
  } catch {
    return []
  }
}

function saveRecentProjects(projects: ProjectConfig[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const temp = `${PROJECTS_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify(projects, null, 2))
  fs.renameSync(temp, PROJECTS_FILE)
  // File → Open Recent mirrors the registry.
  if (app.isReady()) refreshApplicationMenu()
}

function recentForMenu(): Array<{ id: string; name: string; rootPath: string }> {
  return loadRecentProjects()
    .filter(project => !project.hiddenFromRecents)
    .sort((left, right) => (right.openedAt ?? 0) - (left.openedAt ?? 0))
    .slice(0, 10)
    .map(project => ({ id: project.id, name: project.name, rootPath: project.rootPath }))
}

function refreshApplicationMenu(): void {
  const recent = recentForMenu()
  applyApplicationMenu(() => mainWindow, menuState, recent)
  // Recent projects where the OS keeps them: the dock menu on macOS, the
  // jump list on Windows (whose entries relaunch Axiom with the folder).
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate(recent.slice(0, 8).map(project => ({
      label: project.name,
      click: () => { void handleLaunchRequest({ kind: 'project', projectId: project.id }, 'cli') },
    }))))
  }
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      app.setJumpList(recent.length === 0 ? null : [{
        type: 'custom',
        name: 'Recent Projects',
        items: recent.slice(0, 8).map(project => ({
          type: 'task' as const,
          title: project.name,
          description: project.rootPath,
          program: process.execPath,
          args: `"${project.rootPath}"`,
          iconPath: process.execPath,
          iconIndex: 0,
        })),
      }])
    } catch (error) {
      console.warn('[main] could not update the jump list:', error)
    }
  }
}

function upsertRecentProject(config: ProjectConfig): void {
  const projects = loadRecentProjects()
  const idx = projects.findIndex(p => p.id === config.id)
  if (idx >= 0) projects[idx] = mergePersistedProjectConfig(projects[idx], config)
  else projects.unshift(config)
  // No cap: every project is local, and dropping one from this registry used
  // to orphan its index in DATA_DIR with no way back to it. How many appear
  // as "recent" is the launcher's decision, not the registry's.
  saveRecentProjects(projects)
}

function updateRegistryProject(projectId: string, update: (project: ProjectConfig) => ProjectConfig): ProjectConfig {
  const projects = loadRecentProjects()
  const index = projects.findIndex(project => project.id === projectId)
  if (index < 0) throw new Error('Project is missing from the project registry.')
  projects[index] = update(projects[index])
  saveRecentProjects(projects)
  return projects[index]
}

// Turn a user-typed project name into a safe folder name: drop path-invalid
// characters, collapse whitespace to hyphens, and trim stray separators.
function sanitizeProjectName(name: string): string {
  return (name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
}

function projectRoots(): string[] {
  return loadRecentProjects().map(project => project.rootPath)
}

// Only web pages leave for the browser; file:, javascript:, custom schemes
// and anything else a document might link to are ignored.
function openExternalIfWeb(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href)
  } catch { /* not a URL */ }
}

/** The project for a folder chosen by the user, registering it if new. */
function registerFolder(rootPath: string): ProjectConfig {
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
}

// ─── Opening from outside the app ───────────────────────────────────────────
//
// `axiom .`, a folder dropped on the window or dock icon, the dock menu, the
// Windows jump list and axiom:// links all arrive here. A path inside a known
// project opens that project; a new folder is added like File → Open Folder.

let pendingOpen: ProjectConfig | null = null

async function resolveLaunchRequest(request: LaunchRequest, confirmNewFolders: boolean): Promise<ProjectConfig | null> {
  const projects = loadRecentProjects()
  if (request.kind === 'project') return projects.find(project => project.id === request.projectId) ?? null
  let folder = request.path
  try {
    if (!fs.statSync(folder).isDirectory()) folder = dirname(folder)
  } catch {
    return null
  }
  // The most specific known project containing the path wins.
  const owner = projects
    .filter(project => isInside(folder, [project.rootPath]))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0]
  if (owner) return owner
  if (confirmNewFolders && mainWindow) {
    // A link from a web page or another app may not be the user's idea.
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Open this folder in Axiom?',
      detail: folder,
    })
    if (answer.response !== 0) return null
  }
  return registerFolder(folder)
}

async function handleLaunchRequest(request: LaunchRequest | null, source: 'cli' | 'link' | 'drop'): Promise<void> {
  if (!request) return
  const config = await resolveLaunchRequest(request, source === 'link')
  if (!config) return
  pendingOpen = config
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('app:open-request')
  }
}

// ─── App settings ────────────────────────────────────────────────────────────

function readSettingsFile(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function readAppSettings(): AppSettings {
  return normalizeSettings(readSettingsFile())
}

function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = patchSettings(readAppSettings(), patch)
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  // settings.json also holds the resume marker; keep every key we don't own.
  const temp = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ ...readSettingsFile(), ...next }, null, 2))
  fs.renameSync(temp, SETTINGS_FILE)
  return next
}

// Chromium reads this switch once, at launch, so "always reduce motion"
// takes effect on the next start. The CSS already honours the OS setting.
if (readAppSettings().reduceMotion === 'always') {
  app.commandLine.appendSwitch('force-prefers-reduced-motion')
}

function writeSettingsKey(key: string, value: unknown): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const temp = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ ...readSettingsFile(), [key]: value }, null, 2))
  fs.renameSync(temp, SETTINGS_FILE)
}

function changelogPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'CHANGELOG.md') : join(__dirname, '..', '..', 'CHANGELOG.md')
}

function releaseNotes(version: string): string | null {
  try { return changelogSection(fs.readFileSync(changelogPath(), 'utf8'), version) } catch { return null }
}

// Decided once per launch: an update since the last run shows its notes.
let pendingWhatsNew: { version: string; notes: string } | null = null
function checkWhatsNew(): void {
  const current = app.getVersion()
  const raw = readSettingsFile().lastSeenVersion
  const lastSeen = typeof raw === 'string' ? raw : null
  if (shouldShowWhatsNew(current, lastSeen)) {
    const notes = releaseNotes(current)
    if (notes) pendingWhatsNew = { version: current, notes }
  }
  if (lastSeen !== current) {
    try { writeSettingsKey('lastSeenVersion', current) } catch { /* shown again next time */ }
  }
}

const menuState: MenuState = { projectOpen: false, developer: !app.isPackaged || readAppSettings().developerMenu }

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

function mcpServerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'axiom-mcp.mjs')
    : join(__dirname, '..', '..', 'mcp', 'axiom-mcp.ts')
}

/**
 * How an agent starts Axiom's MCP server. A packaged install runs it on
 * Axiom's own bundled runtime through `archd mcp-run`, so nobody has to
 * install Node. A development checkout keeps using the developer's Node,
 * which runs the TypeScript source directly.
 */
function mcpLaunchSpec(): { command: string; args: string[] } {
  if (app.isPackaged) {
    return { command: archdBinaryPath(), args: ['mcp-run', process.execPath, mcpServerPath()] }
  }
  return { command: resolveNodeCommand(), args: [mcpServerPath()] }
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
      '-api-port', String(PREFERRED_PORTS.api),
      '-ws-port', String(PREFERRED_PORTS.ws),
      '-runtime-port', String(PREFERRED_PORTS.runtime),
      '-auto-ports',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    reportArchdLaunchError(binary, error)
    archdProcess = null
    return
  }

  archdRecentStderr = []
  archdProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    process.stderr.write('[archd] ' + text)
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines) logs.archd.write(line)
    archdRecentStderr = [...archdRecentStderr, ...lines].slice(-40)
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
  archdProcess.on('exit', (code, signal) => {
    console.log(`[main] archd exited with code ${code}${signal ? ` (${signal})` : ''}`)
    archdProcess = null
    if (quitting) return
    // Exit 3: another archd already holds this data folder (an agent started
    // one a moment earlier). Use it rather than treating this as a crash.
    const running = code === 3 ? readDaemonFile() : null
    if (running && processAlive(running.pid)) {
      console.log(`[main] archd pid ${running.pid} already owns the data folder; attaching`)
      attachedDaemon = running
      setArchdPorts(running.ports)
      watchAttachedDaemon()
      return
    }
    handleArchdCrash(code)
  })

  console.log('[main] archd started, pid:', archdProcess.pid)
  void adoptSpawnedPorts(archdProcess.pid)
}

// ─── Attaching to a daemon that is already running ─────────────────────────
//
// An agent can start archd headless while Axiom is closed (see daemonAuth.ts).
// When the app then opens it uses that daemon instead of starting a second
// one that would lose the race for the ports. A daemon from another Axiom
// version is asked to step aside first.

interface RunningDaemon { pid: number; version: string; headless: boolean; ports: ArchdPorts }

let attachedDaemon: RunningDaemon | null = null
let attachedWatch: ReturnType<typeof setInterval> | null = null

function readDaemonFile(): RunningDaemon | null {
  try {
    const info = JSON.parse(fs.readFileSync(join(DATA_DIR, 'daemon.json'), 'utf8')) as {
      pid?: unknown; version?: unknown; headless?: unknown; apiPort?: unknown; wsPort?: unknown; runtimePort?: unknown
    }
    const port = (value: unknown, fallback: number) => (typeof value === 'number' && value > 0 ? value : fallback)
    return typeof info.pid === 'number'
      ? {
        pid: info.pid,
        version: String(info.version ?? ''),
        headless: Boolean(info.headless),
        ports: {
          api: port(info.apiPort, PREFERRED_PORTS.api),
          ws: port(info.wsPort, PREFERRED_PORTS.ws),
          runtime: port(info.runtimePort, PREFERRED_PORTS.runtime),
        },
      }
      : null
  } catch { return null }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function daemonAnswers(ports: ArchdPorts = archdPorts): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${ports.api}/api/daemon/info`, {
      headers: { Authorization: `Bearer ${readDaemonToken()}` },
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch { return false }
}

async function startOrAttachArchd(): Promise<void> {
  const running = readDaemonFile()
  if (running && processAlive(running.pid) && await daemonAnswers(running.ports)) {
    if (running.version === app.getVersion()) {
      console.log(`[main] attaching to running archd pid ${running.pid}${running.headless ? ' (started by an agent)' : ''}`)
      attachedDaemon = running
      setArchdPorts(running.ports)
      watchAttachedDaemon()
      return
    }
    console.log(`[main] archd ${running.version} is running; asking it to stop for ${app.getVersion()}`)
    try {
      await fetch(`http://127.0.0.1:${running.ports.api}/api/daemon/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${readDaemonToken()}` },
        signal: AbortSignal.timeout(2000),
      })
    } catch { /* it may already be going */ }
    const deadline = Date.now() + 5000
    while (processAlive(running.pid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  startArchd()
}

// An attached daemon is not our child, so its exit is noticed by polling. If
// it goes away, start our own and bring the open project back.
function watchAttachedDaemon(): void {
  if (attachedWatch) clearInterval(attachedWatch)
  let misses = 0
  attachedWatch = setInterval(() => {
    void daemonAnswers().then(ok => {
      misses = ok ? 0 : misses + 1
      if (misses < 2 || quitting) return
      if (attachedWatch) clearInterval(attachedWatch)
      attachedWatch = null
      attachedDaemon = null
      console.warn('[main] attached archd stopped answering; starting our own')
      sendArchdStatus({ state: 'restarting', attempt: 1 })
      startArchd()
      void reattachActiveProject()
    })
  }, 5000)
}

// The daemon we just started publishes the ports it actually bound.
async function adoptSpawnedPorts(pid: number | undefined): Promise<void> {
  if (!pid) return
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const running = readDaemonFile()
    if (running?.pid === pid) {
      setArchdPorts(running.ports)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function reportArchdLaunchError(binary: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[main] archd launch failed at ${binary}:`, error)
  // Written for the person using Axiom. Only a development checkout gets the
  // build instruction, because only there is it something they can do.
  dialog.showErrorBox(
    'Axiom could not start its background service',
    app.isPackaged
      ? `${message}\n\nYour code is untouched. Reinstalling Axiom usually fixes this; if it keeps happening, please report it with "Report a bug" at the bottom of the Axiom launcher.`
      : `${message}\n\nBuild the daemon with:\nnpm run build:archd`,
  )
}

type ArchdStatus =
  | { state: 'restarting'; attempt: number }
  | { state: 'running' }
  | { state: 'failed'; reason: string; detail: string }

function sendArchdStatus(status: ArchdStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('archd:status', status)
}

function archdFailureReason(): { reason: string; detail: string } {
  const log = archdRecentStderr.join('\n')
  if (/address already in use|only one usage of each socket address/i.test(log)) {
    return {
      reason: 'port-in-use',
      detail: `Another program is using Axiom's local ports (${PREFERRED_PORTS.api}/${PREFERRED_PORTS.ws}). ` +
        'Quit any other copy of Axiom, or the program holding those ports, then restart Axiom.',
    }
  }
  return {
    reason: 'crashed',
    detail: 'Axiom\'s background service stopped repeatedly. Your code is untouched. ' +
      'Restart Axiom; if it keeps happening, please report it with the diagnostics attached.',
  }
}

// archd owns indexing, watching and the MCP-facing API. When it dies the
// window used to keep showing a map that silently stopped updating. Restart it
// with backoff, and only give up - loudly - when it will not stay up.
function handleArchdCrash(code: number | null): void {
  if (IS_E2E) return
  const now = Date.now()
  while (archdRestarts.length > 0 && now - archdRestarts[0] > ARCHD_RESTART_WINDOW_MS) archdRestarts.shift()
  if (archdRestarts.length >= ARCHD_RESTART_LIMIT) {
    const failure = archdFailureReason()
    console.error(`[main] archd will not stay up (last exit ${code}); giving up: ${failure.reason}`)
    sendArchdStatus({ state: 'failed', ...failure })
    return
  }
  archdRestarts.push(now)
  const attempt = archdRestarts.length
  const delay = Math.min(500 * 2 ** (attempt - 1), 8000)
  sendArchdStatus({ state: 'restarting', attempt })
  setTimeout(() => {
    if (quitting) return
    startArchd()
    void reattachActiveProject()
  }, delay)
}

/** Resolves once archd answers HTTP at all; a 401 still proves it is listening. */
async function waitForArchd(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!archdProcess && !attachedDaemon) return false
    try {
      await fetch(`http://127.0.0.1:${archdPorts.api}/api/workspace-scope/health`, { signal: AbortSignal.timeout(1000) })
      return true
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  return false
}

async function reattachActiveProject(): Promise<void> {
  if (!(await waitForArchd())) return
  const project = activeProject
  if (project) {
    try {
      await fetch(`http://127.0.0.1:${archdPorts.api}/api/workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readDaemonToken()}` },
        body: JSON.stringify({
          workspaceId: project.id,
          name: project.name,
          rootPath: project.rootPath,
          ignoredPaths: project.ignoredPaths,
          sourceBoundariesReviewedAt: project.sourceBoundariesReviewedAt,
        }),
      })
    } catch (error) {
      console.error('[main] could not reattach the open project after restarting archd:', error)
    }
  }
  sendArchdStatus({ state: 'running' })
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

  // Reopen where the user left the window. First launch (or a monitor that
  // is gone) falls back to a maximized window, as before.
  const savedState = IS_E2E ? null : readWindowState(WINDOW_STATE_FILE)
  const savedBounds = restorableBounds(
    savedState,
    screen.getAllDisplays().map(display => display.workArea),
    { width: 900, height: 600 },
  )
  const startMaximized = !savedBounds || Boolean(savedState?.maximized)

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1400,
    height: savedBounds?.height ?? 900,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {
      trafficLightPosition: { x: 14, y: 10 },
    } : {}),
    // On Windows: overlay native window controls on top of the custom toolbar
    ...(isWin ? {
      titleBarOverlay: {
        color: '#26332f',
        symbolColor: '#f2f1eb',
        height: 34,
      },
    } : {}),
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer shows content from the user's repositories (documents,
      // source, agent messages). If any of it ever became script, the OS
      // sandbox keeps it away from the machine.
      sandbox: true,
      webviewTag: false,
    },
    title: 'Axiom',
    show: false,
    // E2E windows render offscreen and never enter the taskbar. They are shown
    // with showInactive() below because Chromium will not consider screenshots
    // geometrically stable while a BrowserWindow remains fully hidden.
    skipTaskbar: IS_E2E,
  })

  if (!IS_E2E) {
    const window = mainWindow
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const saveState = () => {
      if (window.isDestroyed() || window.isMinimized()) return
      writeWindowState(WINDOW_STATE_FILE, {
        // Normal bounds, so un-maximizing next time restores a real size.
        ...window.getNormalBounds(),
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
      })
    }
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(saveState, 500)
    }
    window.on('resize', scheduleSave)
    window.on('move', scheduleSave)
    window.on('close', () => { if (saveTimer) clearTimeout(saveTimer); saveState() })
  }

  // No second windows, and links leave the app for the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-change', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-change', false)
  })

  if (IS_DEV && DEV_SERVER_URL) {
    const rendererUrl = new URL(DEV_SERVER_URL)
    if (IS_E2E) rendererUrl.searchParams.set('e2e', '1')
    if (IS_E2E_HOME) rendererUrl.searchParams.set('home', '1')
    if (IS_E2E && process.env.AXIOM_E2E_FIXTURE) rendererUrl.searchParams.set('fixture', process.env.AXIOM_E2E_FIXTURE)
    mainWindow.loadURL(rendererUrl.toString())
    if (!IS_E2E) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      IS_E2E ? { query: { e2e: '1', ...(IS_E2E_HOME ? { home: '1' } : {}), ...(process.env.AXIOM_E2E_FIXTURE ? { fixture: process.env.AXIOM_E2E_FIXTURE } : {}) } } : undefined,
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
        if (startMaximized) mainWindow.maximize()
        mainWindow.show()
      }
    }
    mainWindow.once('ready-to-show', () => showOnce('ready-to-show'))
    mainWindow.webContents.once('did-finish-load', () => showOnce('did-finish-load'))
    setTimeout(() => showOnce('fallback-timer'), 5000)
  }

  // Renderer warnings and errors are kept; routine console chatter is not.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    const source = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''
    logs.renderer.write(timestamped(level === 2 ? 'warn' : 'error', `${message}${source}`))
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomFactor(readAppSettings().uiZoom)
  })

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

    return registerFolder(result.filePaths[0])
  })

  // Open a specific project path directly
  ipcMain.handle('project:open', async (_event, config: ProjectConfig) => {
    // Opening a project is the clearest signal it is recent again.
    const currentConfig = refreshProjectDiskState({ ...config, openedAt: Date.now(), hiddenFromRecents: false })
    upsertRecentProject(currentConfig)
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      join(DATA_DIR, 'active_project.json'),
      JSON.stringify({ workspaceId: currentConfig.id, name: currentConfig.name, rootPath: currentConfig.rootPath }, null, 2)
    )
    sendToArchd({ type: 'open:project', payload: currentConfig })
    activeProject = currentConfig
    // The OS recent list (macOS Recent Items, Windows recent documents).
    try { app.addRecentDocument(currentConfig.rootPath) } catch { /* not supported here */ }
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

  // A project folder was moved or renamed. Repoint the project at its new
  // location so its map, layout and history come along, rather than making
  // the user start over. Axiom never moves the user's files.
  ipcMain.handle('project:relocate', async (_event, projectId: string) => {
    const project = loadRecentProjects().find(candidate => candidate.id === projectId)
    if (!project) throw new Error('Project is missing from the project registry.')
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: `Locate the folder for ${project.name}`,
      buttonLabel: 'Use This Folder',
    })
    if (result.canceled || !result.filePaths[0]) return null
    const newRoot = result.filePaths[0]
    const owner = findProjectByRoot(loadRecentProjects(), newRoot)
    if (owner && owner.id !== projectId) {
      throw new Error(`That folder already belongs to the project "${owner.name}".`)
    }
    const token = readDaemonToken()
    const response = await fetch(`http://127.0.0.1:${archdPorts.api}/api/workspace-relocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: projectId, fromPath: project.rootPath, toPath: newRoot }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Axiom could not move the project map to the new folder${detail ? `: ${detail}` : '.'}`)
    }
    return refreshProjectDiskState(updateRegistryProject(projectId, current => relocateProjectConfig(current, newRoot)))
  })

  // Project Settings saved from the launcher, for a project that is not open.
  // An open project is saved by reopening it, which also re-scopes archd.
  ipcMain.handle('project:update', (_event, projectId: string, patch: Partial<Pick<ProjectConfig, 'name' | 'ignoredPaths' | 'sourceBoundariesReviewedAt'>>) =>
    updateRegistryProject(projectId, project => ({
      ...project,
      ...(typeof patch?.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...(Array.isArray(patch?.ignoredPaths) ? { ignoredPaths: patch.ignoredPaths.filter(path => typeof path === 'string') } : {}),
      ...(typeof patch?.sourceBoundariesReviewedAt === 'number' ? { sourceBoundariesReviewedAt: patch.sourceBoundariesReviewedAt } : {}),
    })))

  // File → Open Recent → Clear Recently Opened: hides every project from the
  // recent list. Nothing is deleted; "Show all" on the launcher still has them.
  // The renderer collects whatever is waiting to open (see handleLaunchRequest).
  ipcMain.handle('app:take-open-request', () => {
    const config = pendingOpen
    pendingOpen = null
    return config
  })
  ipcMain.handle('app:take-whats-new', () => {
    const notes = pendingWhatsNew
    pendingWhatsNew = null
    return notes
  })
  // Help → What's New, any time.
  ipcMain.handle('app:whats-new', () => {
    const version = app.getVersion()
    const notes = releaseNotes(version) ?? (app.isPackaged ? null : releaseNotes('Unreleased'))
    return notes ? { version: releaseNotes(version) ? version : 'Unreleased', notes } : null
  })

  // Settings → Privacy & Data → Delete all Axiom data. Confirmed natively,
  // because it cannot be undone; the app restarts as if freshly installed.
  ipcMain.handle('app:clear-all-data', async () => {
    if (!mainWindow) return false
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Delete Everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Delete all Axiom data?',
      detail: 'Every project map, layout, sheet and change history, your settings, and the logs are deleted from this computer, and Axiom restarts. Your code is not touched. Agent connections stay until you remove them in Settings → Agents.',
    })
    if (answer.response !== 0) return false
    quitting = true
    if (attachedDaemon) {
      try {
        await fetch(`http://127.0.0.1:${archdPorts.api}/api/daemon/shutdown`, {
          method: 'POST', headers: { Authorization: `Bearer ${readDaemonToken()}` }, signal: AbortSignal.timeout(2000),
        })
      } catch { /* already gone */ }
      const deadline = Date.now() + 5000
      while (processAlive(attachedDaemon.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    }
    stopArchd()
    await new Promise(resolve => setTimeout(resolve, 500))
    for (const target of [DATA_DIR, PROJECTS_FILE, SETTINGS_FILE, WINDOW_STATE_FILE, LOG_DIR, join(CONFIG_DIR, 'bin')]) {
      try { fs.rmSync(target, { recursive: true, force: true }) } catch (error) { console.error('[main] could not delete', target, error) }
    }
    app.relaunch()
    app.exit(0)
    return true
  })

  // Settings → Advanced → Install the axiom command.
  ipcMain.handle('cli:install', () => {
    if (!app.isPackaged) {
      return { ok: false, detail: 'The axiom command is installed from a packaged build; in development run the app with npm run dev.' }
    }
    try {
      return installCliLauncher({
        executable: process.env.APPIMAGE ?? process.execPath,
        configDir: CONFIG_DIR,
        home: os.homedir(),
      })
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  })

  // A folder or file dropped on the window.
  ipcMain.handle('app:open-path', (_event, path: string) => {
    if (typeof path !== 'string' || !path) return
    void handleLaunchRequest({ kind: 'path', path }, 'drop')
  })

  ipcMain.handle('project:clear-recent', () => {
    saveRecentProjects(loadRecentProjects().map(project => ({ ...project, hiddenFromRecents: true })))
  })

  // Hiding is not deleting: the project and its map stay, it just leaves the
  // launcher's recent list until it is opened again.
  ipcMain.handle('project:set-hidden', (_event, projectId: string, hidden: boolean) =>
    updateRegistryProject(projectId, project => ({ ...project, hiddenFromRecents: Boolean(hidden) })))

  // Get recent projects
  ipcMain.handle('project:list-recent', () => loadRecentProjects().map(refreshProjectDiskState))

  ipcMain.handle('project:get-resume-id', () =>
    readAppSettings().reopenLastProject ? readResumeProjectId(SETTINGS_FILE) : null)
  ipcMain.handle('project:set-resume-id', (_event, projectId: string | null) => {
    // Clearing the resume marker is how the renderer leaves a project.
    if (projectId === null) activeProject = null
    if (projectId !== null && !loadRecentProjects().some(project => project.id === projectId)) {
      throw new Error('Cannot resume a project outside the recent-project registry.')
    }
    writeResumeProjectId(SETTINGS_FILE, projectId)
  })
  ipcMain.handle('project:complete-lifecycle', (_event, projectId: string, milestone: 'agentSetupCompletedAt' | 'reviewCompletedAt') => {
    if (milestone !== 'agentSetupCompletedAt' && milestone !== 'reviewCompletedAt') {
      throw new Error('Invalid project lifecycle milestone.')
    }
    return updateRegistryProject(projectId, project => ({ ...project, [milestone]: Date.now() }))
  })

  // Deleting is a verified lifecycle boundary. Keep the recent entry if any
  // daemon or filesystem step fails so the UI cannot claim data was removed.
  // The map goes to Recently Deleted for 30 days rather than away for good.
  ipcMain.handle('project:remove', async (_event, projectId: string) => {
    const token = readDaemonToken()
    const project = loadRecentProjects().find(candidate => candidate.id === projectId)
    const trashPath = await removeProjectData({ projectId, dataDir: DATA_DIR, apiPort: archdPorts.api, trash: true,
      request: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }),
    })
    if (trashPath && project) {
      try { writeTrashMeta(trashPath, project) } catch (error) { console.error('[main] could not label trashed map', error) }
    }
    saveRecentProjects(loadRecentProjects().filter(project => project.id !== projectId))
    if (readResumeProjectId(SETTINGS_FILE) === projectId) writeResumeProjectId(SETTINGS_FILE, null)
  })

  // ─── Recently Deleted ────────────────────────────────────────────────────
  ipcMain.handle('project:list-trash', () => listTrash(DATA_DIR))
  ipcMain.handle('project:restore-trash', (_event, trashId: string) => {
    const entry = listTrash(DATA_DIR).find(candidate => candidate.trashId === trashId)
    if (!entry) throw new Error('That map is no longer in Recently Deleted.')
    const owner = findProjectByRoot(loadRecentProjects(), entry.config.rootPath)
    if (owner && owner.id !== entry.config.id) {
      throw new Error(`Its folder now belongs to the project "${owner.name}". Delete that project first, then restore this one.`)
    }
    const config = restoreTrash(DATA_DIR, trashId)
    upsertRecentProject({ ...config, openedAt: Date.now(), hiddenFromRecents: false })
    return refreshProjectDiskState(loadRecentProjects().find(project => project.id === config.id)!)
  })
  ipcMain.handle('project:purge-trash', (_event, trashId: string) => {
    fs.rmSync(trashEntryPath(DATA_DIR, trashId), { recursive: true, force: true })
  })

  // ─── Backups, export and import ──────────────────────────────────────────
  const archdJson = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`http://127.0.0.1:${archdPorts.api}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readDaemonToken()}` },
    })
    const text = await response.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = { error: text } }
    return { status: response.status, body }
  }
  const failure = (what: string, body: any) =>
    new Error(`${what}${typeof body?.error === 'string' && body.error ? `: ${body.error}` : '.'}`)

  ipcMain.handle('project:list-backups', async (_event, projectId: string) => {
    const { status, body } = await archdJson(`/api/workspace-backups?workspace=${encodeURIComponent(projectId)}`)
    if (status !== 200) throw failure('Axiom could not list the backups', body)
    return Array.isArray(body) ? body : []
  })

  ipcMain.handle('project:restore-backup', async (_event, projectId: string, name: string) => {
    if (!mainWindow) return false
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Restore this backup?',
      detail: 'The map goes back to how it was when the backup was taken. The current map is kept as a backup first, so this can be undone. Your code is not touched.',
    })
    if (answer.response !== 0) return false
    const { status, body } = await archdJson('/api/workspace-restore-backup', {
      method: 'POST', body: JSON.stringify({ workspaceId: projectId, name }),
    })
    if (status !== 200) throw failure('Axiom could not restore the backup', body)
    return true
  })

  ipcMain.handle('project:export', async (_event, projectId: string) => {
    const project = loadRecentProjects().find(candidate => candidate.id === projectId)
    if (!project || !mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `Export the map for ${project.name}`,
      defaultPath: join(app.getPath('documents'), `${sanitizeProjectName(project.name) || 'project'}.axiommap`),
      filters: [{ name: 'Axiom map', extensions: ['axiommap'] }],
    })
    if (result.canceled || !result.filePath) return null
    // Written beside the target and moved into place, so a failed export
    // never leaves a half-written map where the user expects one.
    const partial = `${result.filePath}.partial`
    fs.rmSync(partial, { force: true })
    const { status, body } = await archdJson('/api/workspace-export', {
      method: 'POST', body: JSON.stringify({ workspaceId: projectId, path: partial, manifest: exportManifest(project, app.getVersion()) }),
    })
    if (status !== 200) {
      fs.rmSync(partial, { force: true })
      throw failure(status === 404 ? 'This project has no map to export yet' : 'Axiom could not export the map', status === 404 ? null : body)
    }
    fs.renameSync(partial, result.filePath)
    return result.filePath
  })

  ipcMain.handle('project:import', async () => {
    if (!mainWindow) return null
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a map',
      properties: ['openFile'],
      filters: [{ name: 'Axiom map', extensions: ['axiommap'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const path = picked.filePaths[0]
    let { status, body } = await archdJson('/api/workspace-import', { method: 'POST', body: JSON.stringify({ path, replace: false }) })
    if (status === 409 && body?.error === 'exists') {
      const name = loadRecentProjects().find(project => project.id === body.manifest?.workspaceId)?.name ?? body.manifest?.name ?? 'this project'
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Replace the map for ${name}?`,
        detail: 'This computer already has a map for this project. The current one moves to Recently Deleted, where it stays for 30 days.',
      })
      if (answer.response !== 0) return null
      ;({ status, body } = await archdJson('/api/workspace-import', { method: 'POST', body: JSON.stringify({ path, replace: true }) }))
    }
    if (status === 409) throw new Error('This map was exported by a newer version of Axiom. Update Axiom, then import it again.')
    if (status !== 200) throw failure('Axiom could not import the map', body)
    const manifest = body.manifest as Record<string, string>
    const id = manifest.workspaceId
    // The replaced map went to Recently Deleted; label it so it is listed there.
    const replaced = loadRecentProjects().find(project => project.id === id)
    if (typeof body.replacedTrashPath === 'string' && body.replacedTrashPath && replaced) {
      try { writeTrashMeta(body.replacedTrashPath, replaced) } catch (error) { console.error('[main] could not label replaced map', error) }
    }

    // Where does the code live on this computer? The exported location if it
    // is here and free; otherwise ask. Without an answer the map is still
    // imported and asks for its folder like a moved project.
    const ownedByOther = (root: string) => {
      const owner = findProjectByRoot(loadRecentProjects(), root)
      return owner && owner.id !== id ? owner : null
    }
    const exportedRoot = manifest.rootPath ?? ''
    let rootPath = exportedRoot
    let located = Boolean(exportedRoot) && fs.existsSync(exportedRoot) && !ownedByOther(exportedRoot)
    let prompt = `Where is the code for ${manifest.name || 'this project'}?`
    while (!located) {
      const chosen = await dialog.showOpenDialog(mainWindow, { title: prompt, properties: ['openDirectory'], buttonLabel: 'Use This Folder' })
      const folder = chosen.filePaths[0]
      if (chosen.canceled || !folder) break
      const owner = ownedByOther(folder)
      if (owner) { prompt = `That folder belongs to "${owner.name}". Choose the code for ${manifest.name || 'this project'}`; continue }
      rootPath = folder
      located = true
    }
    if (!located && (!exportedRoot || ownedByOther(exportedRoot))) {
      // Nowhere to put it. Undo the import rather than orphan the map.
      await removeProjectData({ projectId: id, dataDir: DATA_DIR, apiPort: archdPorts.api,
        request: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${readDaemonToken()}` } }),
      })
      return null
    }
    const config = importedProjectConfig(manifest, rootPath)
    if (located && manifest.rootPath && config.rootPath !== manifest.rootPath) {
      const moved = await archdJson('/api/workspace-relocate', {
        method: 'POST', body: JSON.stringify({ workspaceId: id, fromPath: manifest.rootPath, toPath: config.rootPath }),
      })
      if (moved.status !== 200) throw failure('The map was imported, but Axiom could not point it at the new folder', moved.body)
    }
    const existing = loadRecentProjects().find(project => project.id === id)
    const next = existing ? { ...existing, ...config } : config
    if (existing) updateRegistryProject(id, () => next)
    else upsertRecentProject(next)
    return refreshProjectDiskState(next)
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
    // Only inside projects Axiom knows; the setup screen browses a project the
    // user just chose in the system folder dialog, which registered it.
    if (typeof dirPath !== 'string' || !isInside(dirPath, projectRoots())) return []
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
  ipcMain.handle('fs:estimate-scope', (_event, rootPath: string, ignored: string[]) => {
    if (typeof rootPath !== 'string' || !isInside(rootPath, projectRoots())) return null
    return estimateScope(rootPath, Array.isArray(ignored) ? ignored.filter(item => typeof item === 'string') : [])
  })

  ipcMain.handle('shell:show-item', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !isInside(filePath, [...projectRoots(), CONFIG_DIR])) return
    shell.showItemInFolder(filePath)
  })

  // "Open in Editor". Source files go to the user's code editor; only plain
  // documents may go to the OS default app, because the default "open" for a
  // script can be to run it (a .js file on Windows runs under Script Host).
  ipcMain.handle('shell:open-file', async (_event, filePath: string): Promise<{ ok: boolean; detail: string }> => {
    if (typeof filePath !== 'string' || !isInside(filePath, projectRoots()) || !fs.existsSync(filePath)) {
      return { ok: false, detail: 'That file is not part of an open project.' }
    }
    const editor = chooseEditor(readAppSettings().editor, detectEditors())
    if (editor) {
      try {
        spawn(editor.command, [filePath], { detached: true, stdio: 'ignore', shell: false, windowsHide: false }).unref()
        return { ok: true, detail: `Opened in ${editor.label}.` }
      } catch (error) {
        console.warn('[main] could not start editor', editor.command, error)
      }
    }
    if (safeForSystemOpen(filePath)) {
      const failure = await shell.openPath(filePath)
      return failure ? { ok: false, detail: failure } : { ok: true, detail: 'Opened.' }
    }
    shell.showItemInFolder(filePath)
    return { ok: false, detail: 'No code editor found, so Axiom showed the file in its folder instead. Choose an editor in Settings → General.' }
  })

  ipcMain.handle('editors:list', () => detectEditors().map(({ id, label }) => ({ id, label })))

  // Get app info (includes archd ports so renderer can connect)
  ipcMain.handle('app:info', () => {
    const isPackaged = app.isPackaged
    const mcpPath = mcpServerPath()
    return {
      version: app.getVersion(),
      dataDir: join(os.homedir(), '.axiom'),
      platform: process.platform,
      archdApiUrl: `http://127.0.0.1:${archdPorts.api}`,
      archdWsUrl: `ws://127.0.0.1:${archdPorts.ws}/ws`,
      mcpPath,
      isPackaged,
    }
  })

  // Which agents are on this machine, and what each install would touch.
  ipcMain.handle('agent:hosts', (_event, projectRoot?: string) => {
    const overrides = readOverrides(CONFIG_DIR)
    const present = detectHosts(undefined, undefined, process.platform, overrides)
    return buildHosts(undefined, undefined, process.platform, overrides).map(host => {
      const configuration = inspectHostConfiguration(host, projectRoot)
      return {
        id: host.id,
        label: host.label,
        familyId: host.familyId,
        familyLabel: host.familyLabel,
        modality: host.modality,
        modalityLabel: host.modalityLabel,
        sharedSurfaces: host.sharedSurfaces ?? [],
        detected: present[host.id] === true,
        configPath: host.configPath(),
        configOverride: overrides[host.id] ?? null,
        command: host.command ?? null,
        triggerKind: host.triggerKind,
        promptText: host.promptText,
        restartAction: host.restartAction,
        restartDetail: host.restartDetail,
        ...configuration,
      }
    })
  })

  ipcMain.handle('agent:delivery-hosts', () => deliveryTargets(buildHosts()).map(({ launcher: _launcher, ...host }) => host))
  ipcMain.handle('agent:delivery-runs', (_event, workspaceId: string) => {
    if (typeof workspaceId !== 'string' || !loadRecentProjects().some(project => project.id === workspaceId)) return []
    return deliveryRunner.list(workspaceId)
  })
  ipcMain.handle('agent:delivery-stop', (_event, workspaceId: string, key: string) => {
    if (typeof workspaceId !== 'string' || typeof key !== 'string') throw new Error('Invalid agent run.')
    deliveryRunner.stop(workspaceId, key)
  })
  ipcMain.handle('agent:deliver', async (_event, request: DeliveryRequest) => {
    if (!request || ![request.workspaceId, request.messageId, request.hostId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) throw new Error('Invalid work-order destination.')
    const project = loadRecentProjects().find(item => item.id === request.workspaceId)
    if (!project || !fs.existsSync(project.rootPath)) throw new Error('This project is unavailable. Open or relocate it before sending work.')
    const { status, body } = await archdJson(`/api/canvas/message?workspace=${encodeURIComponent(project.id)}&messageId=${encodeURIComponent(request.messageId)}`, { signal: AbortSignal.timeout(10000) })
    if (status !== 200 || body?.workspaceId !== project.id || body?.id !== request.messageId) throw failure('Could not find this work order in this project', body)
    checkDeliveryMessage(body, project.id, request.messageId)
    const target = deliveryTargets(buildHosts()).find(host => host.id === request.hostId)
    if (!target || !target.available) throw new Error(target?.detail ?? 'Unknown agent host.')
    const prompt = workOrderHandoff(project.name, project.id, project.rootPath, request.messageId)
    if (target.route !== 'run') {
      clipboard.writeText(prompt)
      if (!target.launcher) return { detail: `Handoff copied for ${target.label}. Paste it into the chat you choose.` }
      const launcher = target.launcher
      const args = request.hostId === 'claude-desktop' ? launcher.args : [...launcher.args, project.rootPath]
      try {
        await new Promise<void>((resolveLaunch, rejectLaunch) => {
          const child = spawn(launcher.command, args, { cwd: project.rootPath, shell: false, detached: true, stdio: 'ignore' })
          child.once('error', rejectLaunch)
          child.once('spawn', () => { child.unref(); resolveLaunch() })
        })
        return { detail: `Handoff copied and ${target.label} opened. Paste it into the chat you choose; work has not started yet.` }
      } catch { return { detail: `Handoff copied, but ${target.label} could not open. Open it yourself and paste into the chat you choose.` } }
    }
    if (!fs.existsSync(mcpServerPath())) throw new Error('This Axiom install has no MCP server. Repair the installation before starting an agent.')
    const run = await deliveryRunner.start({ ...request, rootPath: project.rootPath, revision: body.review?.id ?? 'initial', launcher: target.launcher!, args: deliveryArguments(request.hostId, mcpLaunchSpec(), project.id, prompt), prompt })
    return { detail: run.detail, run }
  })

  // Install Axiom into one agent modality.
  ipcMain.handle('agent:install', (_event, hostId: string, projectRoot?: string) => {
    const host = buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR))
      .find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".`, paths: [] }
    const mcpPath = mcpServerPath()
    if (!fs.existsSync(mcpPath)) {
      return { ok: false, detail: `This Axiom install has no MCP server at ${mcpPath}.`, paths: [] }
    }
    const launch = mcpLaunchSpec()
    try {
      return host.install(launch.command, launch.args, NAME_ARCHITECTURE_COMMAND, projectRoot)
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        paths: [host.configPath()],
      }
    }
  })

  // Install Axiom into all detected modalities for an agent family in one action.
  ipcMain.handle('agent:install-family', (_event, familyId: string, projectRoot?: string) => {
    const mcpPath = mcpServerPath()
    if (!fs.existsSync(mcpPath)) {
      return { ok: false, detail: `This Axiom install has no MCP server at ${mcpPath}.`, paths: [] }
    }
    const launch = mcpLaunchSpec()
    try {
      return installFamily(familyId, launch.command, launch.args, NAME_ARCHITECTURE_COMMAND, projectRoot)
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        paths: [],
      }
    }
  })

  // How an agent actually connects. Axiom speaks MCP over stdio, so the thing a
  // user needs is a server entry naming this install - never a URL. The old
  // invitation copied http://127.0.0.1:7743/mcp, which archd does not serve and
  // never did, so following the app's own instruction could not work.
  // Point Axiom at a configuration file it could not find on its own.
  ipcMain.handle('agent:locate', async (_event, hostId: string) => {
    const host = buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR))
      .find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".` }

    const suggested = host.configPath()
    const extension = suggested.split('.').pop() ?? ''
    const result = await dialog.showOpenDialog({
      title: `Locate the configuration file for ${host.modalityLabel || host.label}`,
      defaultPath: fs.existsSync(join(suggested, '..')) ? join(suggested, '..') : os.homedir(),
      properties: ['openFile', 'showHiddenFiles'],
      filters: extension
        ? [{ name: `${extension.toUpperCase()} files`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'All files', extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, detail: 'Cancelled.' }
    }
    return setOverride(CONFIG_DIR, hostId, result.filePaths[0])
  })

  // Undo the installers: remove Axiom's MCP entry and workflow files from one
  // agent, or from every agent Axiom knows about.
  ipcMain.handle('agent:uninstall', (_event, hostId: string, projectRoot?: string) => {
    const hosts = buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR))
    const host = hosts.find(candidate => candidate.id === hostId)
    if (!host) return { ok: false, detail: `Unknown agent "${hostId}".`, paths: [] }
    return uninstallHost(host, projectRoot, hosts)
  })
  ipcMain.handle('agent:uninstall-all', (_event, projectRoot?: string) =>
    uninstallAll(buildHosts(undefined, undefined, process.platform, readOverrides(CONFIG_DIR)), projectRoot))

  ipcMain.handle('agent:clear-override', (_event, hostId: string) => clearOverride(CONFIG_DIR, hostId))

  ipcMain.handle('agent:connection', () => {
    const mcpPath = mcpServerPath()
    const { command, args } = mcpLaunchSpec()
    return {
      command,
      args,
      // Reported rather than assumed: a missing entry point is the difference
      // between "paste this" and "your install is incomplete", and the user
      // should be told which one they are looking at.
      available: fs.existsSync(mcpPath),
      path: mcpPath,
      config: JSON.stringify(
        { mcpServers: { axiom: { command, args } } },
        null,
        2,
      ),
    }
  })

  // The user asked to try again after archd gave up: start with a clean
  // backoff budget.
  ipcMain.handle('archd:restart', async () => {
    archdRestarts.length = 0
    if (!archdProcess && !attachedDaemon) startArchd()
    await reattachActiveProject()
  })

  // Diagnostics are always user-initiated: copied to the clipboard for the
  // user to read and paste, never sent anywhere by Axiom.
  ipcMain.handle('diagnostics:copy', () => {
    const text = buildDiagnostics(200)
    clipboard.writeText(text)
    return text
  })
  ipcMain.handle('clipboard:write', (_event, text: string) => { clipboard.writeText(String(text ?? '')) })
  ipcMain.handle('diagnostics:open-logs', () => shell.openPath(LOG_DIR))
  ipcMain.handle('diagnostics:report-bug', async () => {
    // The issue carries the environment summary only; logs are too long for
    // a URL, so they go on the clipboard for the user to paste if they wish.
    const summary = buildDiagnostics(0)
    clipboard.writeText(buildDiagnostics(200))
    const body = [
      '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '1. ', '',
      summary, '',
      '_Axiom copied fuller diagnostics, including recent log lines, to your clipboard. Paste them here if you are comfortable sharing them - check them first._',
    ].join('\n')
    await shell.openExternal(`${ISSUES_URL}?${new URLSearchParams({ body }).toString()}`)
  })

  // Settings. Changes apply immediately where they can; reduce-motion needs a
  // restart because Chromium reads it at launch.
  ipcMain.handle('settings:get', () => readAppSettings())
  ipcMain.handle('settings:set', (_event, patch: Partial<AppSettings>) => {
    const next = writeAppSettings(patch ?? {})
    mainWindow?.webContents.setZoomFactor(next.uiZoom)
    const developer = !app.isPackaged || next.developerMenu
    if (developer !== menuState.developer) {
      menuState.developer = developer
      refreshApplicationMenu()
    }
    mainWindow?.webContents.send('settings:changed', next)
    return next
  })

  // Menus. The renderer reports what is open so project commands enable and
  // disable in the native menu, and runs system roles for the menu it draws
  // on Windows and Linux.
  ipcMain.handle('menu:state', (_event, state: { projectOpen: boolean }) => {
    if (menuState.projectOpen === Boolean(state?.projectOpen)) return
    menuState.projectOpen = Boolean(state?.projectOpen)
    refreshApplicationMenu()
  })
  ipcMain.handle('menu:role', (_event, role: SystemRole) => runMenuRole(mainWindow, role, menuState.developer))
  ipcMain.handle('menu:developer', () => menuState.developer)

  // Where archd is listening, read synchronously once at renderer start and
  // pushed as 'archd:ports' if it changes.
  ipcMain.on('archd:ports-sync', event => { event.returnValue = archdPorts })

  ipcMain.handle('window:zoom', (_event, action: 'in' | 'out' | 'reset') => {
    const current = readAppSettings().uiZoom
    const target = action === 'reset' ? 1 : clampZoom(current + (action === 'in' ? UI_ZOOM_STEP : -UI_ZOOM_STEP))
    const next = writeAppSettings({ uiZoom: target })
    mainWindow?.webContents.setZoomFactor(next.uiZoom)
    mainWindow?.webContents.send('settings:changed', next)
    return next.uiZoom
  })
  ipcMain.handle('window:toggle-fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })

  // Help links. A fixed set, so the renderer can never open arbitrary URLs.
  ipcMain.handle('help:open', (_event, topic: 'docs' | 'privacy' | 'license' | 'releases' | 'source') => {
    const base = 'https://github.com/maxwmeadow/Axiom'
    const urls = {
      docs: `${base}#readme`,
      privacy: `${base}/blob/main/PRIVACY.md`,
      license: `${base}/blob/main/LICENSE`,
      releases: `${base}/releases`,
      source: base,
    }
    const url = urls[topic]
    if (url) void shell.openExternal(url)
  })
  // Third-party notices, generated at package time (scripts/third-party-notices.mjs).
  ipcMain.handle('app:third-party-notices', () => {
    const file = app.isPackaged
      ? join(process.resourcesPath, 'licenses', 'THIRD_PARTY_NOTICES.txt')
      : join(__dirname, '..', 'licenses', 'THIRD_PARTY_NOTICES.txt')
    try { return fs.readFileSync(file, 'utf8') } catch {
      return 'Third-party notices are generated when Axiom is packaged. In a development checkout, run: npm run notices'
    }
  })

  ipcMain.handle('app:paths', () => ({ config: CONFIG_DIR, data: DATA_DIR, logs: LOG_DIR }))
  ipcMain.handle('shell:open-path', (_event, which: 'config' | 'data' | 'logs') => {
    const paths = { config: CONFIG_DIR, data: DATA_DIR, logs: LOG_DIR }
    if (paths[which]) return shell.openPath(paths[which])
  })

  // Window controls
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:set-title-bar-height', (_event, height: number) => {
    if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
      try {
        mainWindow.setTitleBarOverlay({
          color: '#26332f',
          symbolColor: '#f2f1eb',
          height,
        })
      } catch {
        // Ignore if unsupported
      }
    }
  })
}


function countCrashReports(): number {
  const count = (dir: string): number => {
    let total = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) total += count(path)
        else if (entry.name.endsWith('.dmp')) total++
      }
    } catch { /* none */ }
    return total
  }
  return count(app.getPath('crashDumps'))
}

function buildDiagnostics(logLines: number): string {
  const now = Date.now()
  return formatDiagnostics({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    locale: app.getLocale(),
    packaged: app.isPackaged,
    archdRunning: archdProcess !== null || attachedDaemon !== null,
    archdRestartsLastMinute: archdRestarts.filter(at => now - at < 60_000).length,
    projectCount: loadRecentProjects().length,
    crashReports: countCrashReports(),
    logs: logLines > 0
      ? { main: logs.main.tail(logLines), archd: logs.archd.tail(logLines), renderer: logs.renderer.tail(logLines) }
      : {},
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

**Submit it incrementally** with Axiom's \`edit_systems\` tool. Call
\`begin_session\` once, then \`add_chunk\` for small groups of systems with a
stable chunkId per group. Each system takes a systemKey, name, description,
optional parentKey (which may refer to another chunk), and repository-relative
files. Set rootId on a system when its file paths are ambiguous across roots.
Call \`commit_session\` after the whole tree is submitted. If your
session is interrupted, use \`session_status\` and resume with the same
sessionId. A small map can still use \`op: "propose"\` in one call.

The human confirms, renames or rejects each system. Nothing reaches their map
until they do.
`

// ─── App lifecycle ──────────────────────────────────────────────────────────

// One Axiom per machine. A second copy would start a second archd that loses
// the race for the local ports and leaves one window silently disconnected.
// Launching again instead brings the existing window forward.
const hasInstanceLock = IS_E2E || app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    // `axiom <folder>` or an axiom:// link while Axiom is already running.
    const request = parseLaunchArgs(argv, workingDirectory, [app.getAppPath()])
    void handleLaunchRequest(request, argv.some(argument => argument.startsWith('axiom:')) ? 'link' : 'cli')
  })
}

// macOS delivers dock drops and links as events, possibly before ready.
app.on('open-file', (event, path) => {
  event.preventDefault()
  void app.whenReady().then(() => handleLaunchRequest({ kind: 'path', path }, 'drop'))
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  void app.whenReady().then(() => handleLaunchRequest(parseAxiomUrl(url), 'link'))
})
if (app.isPackaged && !IS_E2E) app.setAsDefaultProtocolClient('axiom')

app.whenReady().then(() => {
  if (!hasInstanceLock) return
  // The capability stays in main; only requests to our fixed loopback daemon
  // receive it. Page scripts never receive the token through IPC or URLs.
  if (!IS_E2E) session.defaultSession.webRequest.onBeforeSendHeaders(
    // archd answers HTTP on both ports: the renderer's symbol and agent-lane
    // requests go to the WebSocket port (arcdApi.ts, symbolCache.ts), and
    // without the token there they fail as 401 and files show "No symbols".
    // The ports can move (see PREFERRED_PORTS), so match loopback broadly and
    // hand the token only to archd's current ports.
    { urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] },
    (details, callback) => {
      if (details.webContentsId !== mainWindow?.webContents.id) { callback({ requestHeaders: details.requestHeaders }); return }
      const port = Number(new URL(details.url).port)
      if (port !== archdPorts.api && port !== archdPorts.ws) { callback({ requestHeaders: details.requestHeaders }); return }
      const frameUrl = details.frame?.url
      if (frameUrl && !frameUrl.startsWith('file://') && !(DEV_SERVER_URL && new URL(frameUrl).origin === new URL(DEV_SERVER_URL).origin)) {
        callback({ requestHeaders: details.requestHeaders }); return
      }
      try { details.requestHeaders.Authorization = `Bearer ${readDaemonToken()}` } catch { /* daemon may still be starting */ }
      callback({ requestHeaders: details.requestHeaders })
    },
  )
  // Axiom needs no camera, microphone, location, notifications or similar.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  checkWhatsNew()
  // Recently Deleted keeps maps for 30 days.
  try { purgeExpiredTrash(DATA_DIR) } catch (error) { console.error('[main] trash purge failed', error) }
  createWindow()
  setupIPC()
  refreshApplicationMenu()
  initUpdates(() => mainWindow, app.isPackaged && !IS_E2E, () => readAppSettings().checkForUpdates)
  if (!IS_E2E) void startOrAttachArchd()
  // Launched as `axiom <folder>` or through a link (Windows/Linux pass both
  // on the command line). Development passes the app directory; skip it.
  if (app.isPackaged && !IS_E2E) {
    const request = parseLaunchArgs(process.argv, process.cwd(), [app.getAppPath()])
    void handleLaunchRequest(request, process.argv.some(argument => argument.startsWith('axiom:')) ? 'link' : 'cli')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitting = true
    stopArchd()
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
  deliveryRunner.stopAll()
  // An attached daemon was started by an agent and stays for it; it exits by
  // itself once idle. Only the daemon this app started is stopped.
  if (attachedWatch) clearInterval(attachedWatch)
  stopArchd()
})

// Ensure archd is killed if the process is terminated via Ctrl+C or signal
process.on('SIGINT', () => { quitting = true; deliveryRunner.stopAll(); stopArchd(); process.exit(0) })
process.on('SIGTERM', () => { quitting = true; deliveryRunner.stopAll(); stopArchd(); process.exit(0) })

// Security: the window only ever shows Axiom. A link that would navigate it
// elsewhere opens in the browser instead; embedded web views are refused.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    const devOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : null
    if (parsedUrl.origin !== devOrigin && !navigationUrl.startsWith('file://')) {
      event.preventDefault()
      openExternalIfWeb(navigationUrl)
    }
  })
  contents.on('will-attach-webview', event => event.preventDefault())
})
