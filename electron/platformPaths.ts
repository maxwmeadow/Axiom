import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { execSync } from 'child_process'

export interface PlatformPaths {
  homeDir: string
  appDataDir: string
  configDir: string
  isMac: boolean
  isWin: boolean
  isLinux: boolean
}

/**
 * Normalizes OS-specific application data and configuration directories.
 * - macOS: ~/Library/Application Support
 * - Windows: %APPDATA% (AppData/Roaming)
 * - Linux: $XDG_CONFIG_HOME or ~/.config
 */
export function getPlatformPaths(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): PlatformPaths {
  const isMac = platform === 'darwin'
  const isWin = platform === 'win32'
  const isLinux = !isMac && !isWin

  const appDataDir = isWin
    ? (process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'))
    : isMac
      ? join(homeDir, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(homeDir, '.config'))

  const configDir = isWin
    ? appDataDir
    : isMac
      ? join(homeDir, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? join(homeDir, '.config'))

  return { homeDir, appDataDir, configDir, isMac, isWin, isLinux }
}

/**
 * Returns the platform-specific path for Claude Desktop's MCP configuration.
 */
export function getClaudeDesktopConfigPath(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  explicitAppDataDir?: string,
): string {
  const paths = getPlatformPaths(homeDir, platform)
  const appData = explicitAppDataDir ?? paths.appDataDir
  return join(appData, 'Claude', 'claude_desktop_config.json')
}

/**
 * Returns the platform-specific path for VS Code User-level global mcp.json.
 */
export function getVsCodeUserMcpPath(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  insiders = false,
  explicitAppDataDir?: string,
): string {
  const paths = getPlatformPaths(homeDir, platform)
  const appData = explicitAppDataDir ?? paths.appDataDir
  const appFolder = insiders ? 'Code - Insiders' : 'Code'
  return join(appData, appFolder, 'User', 'mcp.json')
}

/**
 * Returns the platform-specific path for Zed's settings.json.
 */
export function getZedConfigPath(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  explicitAppDataDir?: string,
): string {
  const paths = getPlatformPaths(homeDir, platform)
  if (paths.isWin) {
    return join(explicitAppDataDir ?? paths.appDataDir, 'Zed', 'settings.json')
  }
  // Zed deviates from the platform convention on macOS: it reads ~/.config/zed,
  // not Application Support. Redirect it in tests through homeDir.
  if (paths.isMac) {
    return join(homeDir, '.config', 'zed', 'settings.json')
  }
  // Linux honours $XDG_CONFIG_HOME, which configDir already resolves.
  return join(explicitAppDataDir ?? paths.configDir, 'zed', 'settings.json')
}

/**
 * Finds all installed JetBrains product configuration directories.
 * e.g. ~/Library/Application Support/JetBrains/IntelliJIdea2025.2
 */
export function findJetBrainsDirectories(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  explicitAppDataDir?: string,
): string[] {
  const paths = getPlatformPaths(homeDir, platform)
  const appData = explicitAppDataDir ?? paths.appDataDir
  const jetbrainsRoot = join(appData, 'JetBrains')
  if (!existsSync(jetbrainsRoot)) return []

  try {
    const entries = readdirSync(jetbrainsRoot, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name.toLowerCase() !== 'options')
      .map(entry => join(jetbrainsRoot, entry.name))
  } catch {
    return []
  }
}

/**
 * Highest-versioned Node installed under a version manager's versions directory,
 * e.g. ~/.nvm/versions/node/v22.5.1/bin/node. Returns null when none is usable.
 */
function newestManagedNode(versionsDir: string): string | null {
  if (!existsSync(versionsDir)) return null
  try {
    const parsed = readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => ({
        name: entry.name,
        parts: entry.name.replace(/^v/, '').split('.').map(Number),
      }))
      .filter(candidate => candidate.parts.length > 0 && candidate.parts.every(Number.isFinite))
      .sort((a, b) =>
        (b.parts[0] - a.parts[0]) || (b.parts[1] - a.parts[1]) || (b.parts[2] - a.parts[2]))

    for (const candidate of parsed) {
      const binary = join(versionsDir, candidate.name, 'bin', 'node')
      if (existsSync(binary)) return binary
    }
  } catch {
    // An unreadable directory just means this manager cannot answer.
  }
  return null
}

/**
 * Resolves the absolute path to `node` for GUI applications.
 *
 * GUI desktop apps on macOS/Linux launched outside a shell often run with a
 * stripped system PATH (/usr/bin:/bin:/usr/sbin:/sbin) and cannot locate `node`
 * if it was installed by a version manager. Every manager listed here is
 * actually probed - fnm, nvm, Volta, asdf - plus Homebrew (both Apple Silicon
 * and Intel prefixes) and the system package.
 */
export function resolveNodeCommand(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  // Windows GUI apps inherit a usable PATH, and node.exe is not laid out this way.
  if (platform === 'win32') return 'node'

  const candidates = [
    // fnm: the `default` alias tracks whatever `fnm default` last selected.
    join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'),
    join(homeDir, '.fnm', 'aliases', 'default', 'bin', 'node'),
    join(homeDir, '.fnm', 'current', 'bin', 'node'),
    // nvm and asdf keep versions side by side; take the newest installed.
    newestManagedNode(join(homeDir, '.nvm', 'versions', 'node')),
    // Volta and asdf both expose a stable shim directory.
    join(homeDir, '.volta', 'bin', 'node'),
    join(homeDir, '.asdf', 'shims', 'node'),
    newestManagedNode(join(homeDir, '.asdf', 'installs', 'nodejs')),
    // Homebrew: Apple Silicon prefix first, then Intel, then the system.
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((candidate): candidate is string => typeof candidate === 'string')

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Last resort. This only helps when Axiom was launched from a shell that
  // already had node on PATH - in which case bare `node` would have worked
  // anyway - but it costs nothing and covers layouts not listed above.
  try {
    const found = execSync('command -v node 2>/dev/null', { encoding: 'utf8' }).trim()
    if (found && existsSync(found)) return found
  } catch {
    // No shell, or no node: fall through to the bare command.
  }

  return 'node'
}
