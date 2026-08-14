import { join, resolve } from 'path'
import os from 'os'
import fs from 'fs'

/**
 * Installing Axiom into an agent, per host, as an action rather than an
 * instruction.
 *
 * Every host reads a different file in a different format, and the slash
 * command — where the host has such a thing — is a second file somewhere else
 * again. Handing a user a JSON blob and a paragraph is how a working connection
 * becomes a support problem: they must find the file, know whether it merges or
 * replaces, and get the escaping right on a Windows path.
 *
 * So each host describes where its things live and how to write them, and the
 * app writes them. Anything already configured is merged, never overwritten:
 * these files belong to the user and usually contain other servers.
 *
 * A host Axiom cannot write to is not a failure — it reports what it would have
 * done and where, which is strictly better than the paragraph it replaces.
 */

export interface InstallResult {
  ok: boolean
  /** What was done, in the user's terms. */
  detail: string
  /** Files touched, so the user can see and undo. */
  paths: string[]
}

export interface HostDescriptor {
  id: string
  label: string
  /** Where this host keeps MCP servers, used both to detect and to install. */
  configPath: () => string
  /** Every user or workspace MCP configuration this host can read. */
  serverLocations: (projectRoot?: string) => ServerLocation[]
  /** Where its reusable workflow lives, if this host supports one. */
  commandPath?: (projectRoot?: string) => string | null
  /** The command a user types once installed. */
  command?: string
  install: (command: string, args: string[], brief: string, projectRoot?: string) => InstallResult
}

type ServerLocation =
  | { format: 'json'; path: string; keyPath: string[] }
  | { format: 'toml'; path: string }

export interface HostConfigurationStatus {
  configured: boolean
  /** Configuration files containing an Axiom MCP entry. */
  configuredPaths: string[]
  /** Existing files that could not be safely inspected. */
  unreadablePaths: string[]
  /** Whether the host-specific reusable workflow is present. */
  workflowInstalled: boolean
  workflowPath: string | null
}

const home = () => os.homedir()

function projectPathVariants(projectRoot: string): string[] {
  const absolute = resolve(projectRoot)
  return [...new Set([
    projectRoot,
    absolute,
    absolute.replaceAll('\\', '/'),
    absolute.replaceAll('/', '\\'),
  ])]
}

/** Read JSON that may be absent or damaged without destroying it. */
function readJson(path: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(path)) return {}
    const raw = fs.readFileSync(path, 'utf8').trim()
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, any>
  } catch {
    // Damaged or hand-edited into something we do not understand. Refusing is
    // right: rewriting it would destroy configuration we cannot read.
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

/** Merge an `axiom` entry into a host's JSON config under the given key. */
function installJsonServer(
  path: string,
  key: string,
  command: string,
  args: string[],
  label: string,
): InstallResult {
  const existing = readJson(path)
  if (existing === null) {
    return {
      ok: false,
      detail: `${path} could not be read as JSON. Fix or move it, then try again — Axiom will not overwrite configuration it cannot understand.`,
      paths: [path],
    }
  }
  const servers = (existing[key] ?? {}) as Record<string, unknown>
  existing[key] = { ...servers, axiom: { command, args } }
  writeJson(path, existing)
  return { ok: true, detail: `Added Axiom to ${label}.`, paths: [path] }
}

function installCommandFile(path: string, brief: string): string {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, brief, 'utf8')
  return path
}

function removeGeneratedFile(path: string, expectedContents: string): boolean {
  if (!fs.existsSync(path)) return false
  try {
    const actual = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd()
    if (actual !== expectedContents.replaceAll('\r\n', '\n').trimEnd()) return false
    fs.rmSync(path)
    return true
  } catch {
    return false
  }
}

function installAgentSkill(path: string, brief: string): string {
  const instructions = [
    '---',
    'name: axiom-map',
    'description: Map the current codebase into a semantic system architecture in Axiom. Use when asked to map, name, or propose this project architecture in Axiom.',
    '---',
    '',
    brief,
  ].join('\n')
  return installCommandFile(path, instructions)
}

function identifiedArgs(args: string[], hostId: string): string[] {
  return [...args, `--axiom-host=${hostId}`]
}

function upsertTomlTable(source: string, table: RegExp, block: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const tableHeader = /^\s*\[[^\]]+\]\s*(?:#.*)?$/
  const start = lines.findIndex(line => table.test(line))

  if (start < 0) {
    return source.trimEnd() + (source.trim() ? newline + newline : '') + block.replaceAll('\n', newline) + newline
  }

  let end = start + 1
  while (end < lines.length && !tableHeader.test(lines[end])) end += 1
  lines.splice(start, end - start, ...block.split('\n'), '')
  return lines.join(newline)
}

/**
 * Inspect the same configuration locations the installer writes.
 *
 * This intentionally checks for an `axiom` server entry rather than comparing
 * its command line with this build. A different Axiom build is still an
 * existing configuration and should be presented as such; reinstall remains
 * available when the user wants to refresh it.
 */
export function inspectHostConfiguration(
  host: HostDescriptor,
  projectRoot?: string,
): HostConfigurationStatus {
  const configuredPaths = new Set<string>()
  const unreadablePaths = new Set<string>()

  for (const location of host.serverLocations(projectRoot)) {
    if (!fs.existsSync(location.path)) continue

    if (location.format === 'json') {
      const config = readJson(location.path)
      if (config === null) {
        unreadablePaths.add(location.path)
        continue
      }
      let servers: unknown = config
      for (const key of location.keyPath) {
        if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
          servers = undefined
          break
        }
        servers = (servers as Record<string, unknown>)[key]
      }
      if (
        servers !== null &&
        typeof servers === 'object' &&
        !Array.isArray(servers) &&
        Object.prototype.hasOwnProperty.call(servers, 'axiom')
      ) {
        configuredPaths.add(location.path)
      }
      continue
    }

    try {
      const config = fs.readFileSync(location.path, 'utf8')
      if (/^\s*\[\s*mcp_servers\s*\.\s*(?:axiom|"axiom"|'axiom')\s*\]\s*(?:#.*)?$/m.test(config)) {
        configuredPaths.add(location.path)
      }
    } catch {
      unreadablePaths.add(location.path)
    }
  }

  return {
    configured: configuredPaths.size > 0,
    configuredPaths: [...configuredPaths],
    unreadablePaths: [...unreadablePaths],
    workflowInstalled: (() => {
      const path = host.commandPath?.(projectRoot)
      return path ? fs.existsSync(path) : false
    })(),
    workflowPath: host.commandPath?.(projectRoot) ?? null,
  }
}

export function buildHosts(
  homeDir = home(),
  appDataDir = process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'),
): HostDescriptor[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: () => join(homeDir, '.claude.json'),
      serverLocations: projectRoot => [
        { format: 'json', path: join(homeDir, '.claude.json'), keyPath: ['mcpServers'] },
        ...(projectRoot ? [
          ...projectPathVariants(projectRoot).map(projectPath => ({
            format: 'json' as const,
            path: join(homeDir, '.claude.json'),
            keyPath: ['projects', projectPath, 'mcpServers'],
          })),
          {
            format: 'json' as const,
            path: join(projectRoot, '.mcp.json'),
            keyPath: ['mcpServers'],
          },
        ] : []),
      ],
      commandPath: () => join(homeDir, '.claude', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      install: (command, args, brief) => {
        const hostArgs = identifiedArgs(args, 'claude-code')
        const result = installJsonServer(join(homeDir, '.claude.json'), 'mcpServers', command, hostArgs, 'Claude Code')
        if (!result.ok) return result
        const cmd = installAgentSkill(join(homeDir, '.claude', 'skills', 'axiom-map', 'SKILL.md'), brief)
        return {
          ok: true,
          detail: 'Added Axiom and installed the /axiom-map skill. Restart Claude Code only if its skills folder was created after this session started.',
          paths: [...result.paths, cmd],
        }
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      configPath: () => join(homeDir, '.codex', 'config.toml'),
      serverLocations: projectRoot => [
        { format: 'toml', path: join(homeDir, '.codex', 'config.toml') },
        ...(projectRoot
          ? [{ format: 'toml' as const, path: join(projectRoot, '.codex', 'config.toml') }]
          : []),
      ],
      commandPath: () => join(homeDir, '.agents', 'skills', 'axiom-map', 'SKILL.md'),
      command: '$axiom-map',
      install: (command, args, brief) => {
        const path = join(homeDir, '.codex', 'config.toml')
        fs.mkdirSync(join(homeDir, '.codex'), { recursive: true })
        const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''
        const hostArgs = identifiedArgs(args, 'codex')
        const block = [
          '[mcp_servers.axiom]',
          `command = ${JSON.stringify(command)}`,
          `args = [${hostArgs.map(a => JSON.stringify(a)).join(', ')}]`,
        ].join('\n')
        // Replace complete TOML table lines, not text up to the next `[`:
        // `args = [...]` contains brackets too, so character-based matching
        // corrupts the file on reinstall.
        const next = upsertTomlTable(
          existing,
          /^\s*\[\s*mcp_servers\s*\.\s*(?:axiom|"axiom"|'axiom')\s*\]\s*(?:#.*)?$/,
          block,
        )
        fs.writeFileSync(path, next, 'utf8')
        const cmd = installAgentSkill(join(homeDir, '.agents', 'skills', 'axiom-map', 'SKILL.md'), brief)
        return {
          ok: true,
          detail: 'Added Axiom and installed the $axiom-map skill. Restart Codex if it is not visible yet.',
          paths: [path, cmd],
        }
      },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: () => join(homeDir, '.cursor', 'mcp.json'),
      serverLocations: projectRoot => [
        { format: 'json', path: join(homeDir, '.cursor', 'mcp.json'), keyPath: ['mcpServers'] },
        ...(projectRoot
          ? [{ format: 'json' as const, path: join(projectRoot, '.cursor', 'mcp.json'), keyPath: ['mcpServers'] }]
          : []),
      ],
      commandPath: () => join(homeDir, '.cursor', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      // Keep both user and project MCP scopes current so Cursor IDE and CLI can
      // resolve the same server regardless of how the workspace was opened.
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'cursor')
        const global = installJsonServer(join(homeDir, '.cursor', 'mcp.json'), 'mcpServers', command, hostArgs, 'Cursor')
        const paths = [...global.paths]
        let configured = global.ok
        if (projectRoot) {
          const local = installJsonServer(join(projectRoot, '.cursor', 'mcp.json'), 'mcpServers', command, hostArgs, 'Cursor')
          paths.push(...local.paths)
          configured = configured || local.ok
        }
        const skill = installAgentSkill(join(homeDir, '.cursor', 'skills', 'axiom-map', 'SKILL.md'), brief)
        paths.push(skill)
        return {
          ok: configured,
          detail: 'Added Axiom and installed the /axiom-map Agent Skill for Cursor. Start a new chat if it is not visible yet.',
          paths,
        }
      },
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      configPath: () => join(homeDir, '.copilot', 'mcp-config.json'),
      serverLocations: projectRoot => [
        { format: 'json', path: join(homeDir, '.copilot', 'mcp-config.json'), keyPath: ['mcpServers'] },
        ...(projectRoot ? [
          {
            format: 'json' as const,
            path: join(projectRoot, '.vscode', 'mcp.json'),
            keyPath: ['servers'],
          },
          {
            format: 'json' as const,
            path: join(projectRoot, '.mcp.json'),
            keyPath: ['mcpServers'],
          },
          {
            format: 'json' as const,
            path: join(projectRoot, '.mcp.json'),
            keyPath: [],
          },
          {
            format: 'json' as const,
            path: join(projectRoot, '.github', 'mcp.json'),
            keyPath: ['mcpServers'],
          },
          {
            format: 'json' as const,
            path: join(projectRoot, '.github', 'mcp.json'),
            keyPath: [],
          },
        ] : []),
      ],
      commandPath: () => join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      // ~/.copilot/mcp-config.json is the documented portable user config that
      // Copilot reads across VS Code and the CLI. The workspace file VS Code
      // reads is .vscode/mcp.json and it keys servers under `servers`, not
      // `mcpServers`; both are written so either path works.
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'copilot')
        const user = installJsonServer(
          join(homeDir, '.copilot', 'mcp-config.json'), 'mcpServers', command, hostArgs, 'GitHub Copilot',
        )
        const paths = [...user.paths]
        let configured = user.ok
        if (projectRoot) {
          const ws = installJsonServer(join(projectRoot, '.vscode', 'mcp.json'), 'servers', command, hostArgs, 'VS Code')
          paths.push(...ws.paths)
          configured = configured || ws.ok
          // Axiom versions before Agent Skills wrote this prompt file. Remove
          // it only when it is still byte-for-byte Axiom's generated content;
          // a user-edited file is theirs and must be preserved.
          const legacyPrompt = join(projectRoot, '.github', 'prompts', 'axiom-map.prompt.md')
          if (removeGeneratedFile(legacyPrompt, brief)) paths.push(legacyPrompt)
        }
        if (!configured) return { ...user, paths }
        paths.push(installAgentSkill(join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: true,
          detail: 'Added Axiom and installed the /axiom-map Agent Skill for Copilot. Reload VS Code or run /skills reload in Copilot CLI.',
          paths,
        }
      },
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      configPath: () => join(appDataDir, 'devin', 'mcp_config.json'),
      serverLocations: projectRoot => [
        {
          format: 'json',
          path: join(appDataDir, 'devin', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
        ...(projectRoot ? [{
          format: 'json' as const,
          path: join(projectRoot, '.devin', 'mcp_config.local.json'),
          keyPath: ['mcpServers'],
        }] : []),
        {
          format: 'json',
          path: join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
        {
          format: 'json',
          path: join(homeDir, '.codeium', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
      ],
      commandPath: () => join(appDataDir, 'devin', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      install: (command, args, brief) => {
        const hostArgs = identifiedArgs(args, 'windsurf')
        const current = installJsonServer(
          join(appDataDir, 'devin', 'mcp_config.json'),
          'mcpServers', command, hostArgs, 'Windsurf / Devin Local',
        )
        const legacy = installJsonServer(
          join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
          'mcpServers', command, hostArgs, 'Windsurf Cascade',
        )
        if (!current.ok) return { ...current, paths: [...current.paths, ...legacy.paths] }
        const paths = [...current.paths, ...legacy.paths]
        paths.push(installAgentSkill(join(appDataDir, 'devin', 'skills', 'axiom-map', 'SKILL.md'), brief))
        paths.push(installAgentSkill(join(homeDir, '.codeium', 'windsurf', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: true,
          detail: 'Added Axiom and installed its Agent Skill for current Windsurf / Devin Local and legacy Cascade.',
          paths,
        }
      },
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      configPath: () => join(homeDir, '.gemini', 'config', 'mcp_config.json'),
      serverLocations: projectRoot => [
        {
          format: 'json',
          path: join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
        // Older Antigravity IDE builds used this location. Inspect it so an
        // existing installation remains visible, but new installs target the
        // current shared Gemini configuration above.
        {
          format: 'json',
          path: join(homeDir, '.gemini', 'antigravity-ide', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
        ...(projectRoot ? [{
          format: 'json' as const,
          path: join(projectRoot, '.agents', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        }] : []),
      ],
      commandPath: () => join(homeDir, '.gemini', 'config', 'skills', 'axiom-map', 'SKILL.md'),
      command: 'Use the axiom-map skill',
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'antigravity')
        const global = installJsonServer(
          join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          'mcpServers', command, hostArgs, 'Antigravity',
        )
        const paths = [...global.paths]
        let configured = global.ok
        const legacyPath = join(homeDir, '.gemini', 'antigravity-ide', 'mcp_config.json')
        if (fs.existsSync(legacyPath)) {
          const legacy = installJsonServer(
            legacyPath, 'mcpServers', command, hostArgs, 'legacy Antigravity IDE',
          )
          paths.push(...legacy.paths)
        }
        if (projectRoot) {
          const local = installJsonServer(
            join(projectRoot, '.agents', 'mcp_config.json'),
            'mcpServers', command, hostArgs, 'Antigravity workspace',
          )
          paths.push(...local.paths)
          configured = configured || local.ok
        }
        if (!configured) return { ...global, paths }
        paths.push(installAgentSkill(join(homeDir, '.gemini', 'config', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: true,
          detail: 'Added Axiom and installed the axiom-map Agent Skill for Antigravity.',
          paths,
        }
      },
    },
  ]
}

/**
 * Which hosts look present on this machine.
 *
 * Presence is judged by the host's own directory rather than its MCP file,
 * because a host that has never been given a server has no such file yet — and
 * refusing to install for it would be exactly backwards.
 */
export function detectHosts(): Record<string, boolean> {
  const seen: Record<string, boolean> = {}
  for (const host of buildHosts()) {
    const dir = join(host.configPath(), '..')
    seen[host.id] = fs.existsSync(dir) ||
      fs.existsSync(host.configPath()) ||
      host.serverLocations().some(location => fs.existsSync(location.path))
  }
  return seen
}
