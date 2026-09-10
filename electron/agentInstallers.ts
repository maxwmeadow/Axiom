import { join, resolve } from 'path'
import os from 'os'
import fs from 'fs'
import {
  getPlatformPaths,
  getClaudeDesktopConfigCandidates,
  getClaudeDesktopConfigPath,
  getVsCodeUserMcpPath,
  getZedConfigPath,
  findJetBrainsDirectories,
} from './platformPaths.ts'

/**
 * Installing Axiom into an agent, per host and per modality, as an action
 * rather than an instruction.
 *
 * Every host reads a different file in a different format (JSON, TOML, XML),
 * across different operating systems (macOS, Windows, Linux) and modalities
 * (CLI, VS Code extension, dedicated desktop app, editor).
 */

export interface InstallResult {
  ok: boolean
  /** What was done, in the user's terms. */
  detail: string
  /** Files touched, so the user can see and undo. */
  paths: string[]
}

export type ModalityType = 'cli' | 'vscode' | 'desktop' | 'editor'
export type TriggerKind = 'slash command' | 'skill command' | 'instruction' | 'chat prompt'

export interface HostDescriptor {
  id: string
  label: string
  familyId: string
  familyLabel: string
  modality: ModalityType
  modalityLabel: string
  /** Where this host keeps MCP servers, used both to detect and to install. */
  configPath: () => string
  /** Every user or workspace MCP configuration this host can read. */
  serverLocations: (projectRoot?: string) => ServerLocation[]
  /**
   * Other surfaces that read this exact configuration. Installing the host
   * configures these too - they are listed so a user looking for "Claude Code
   * in VS Code" can see it is handled, rather than concluding it is missing.
   */
  sharedSurfaces?: { id: string; label: string }[]
  /**
   * Paths whose existence proves this host is installed, for hosts whose
   * config sits directly in the home directory and therefore has no
   * distinguishing parent folder of its own.
   */
  detectPaths?: () => string[]
  /** Where its reusable workflow lives, if this host supports one. */
  commandPath?: (projectRoot?: string) => string | null
  /** The command a user types once installed. */
  command?: string
  /** Type of trigger needed to invoke the mapping flow. */
  triggerKind: TriggerKind
  /** Prompt text for modalities without slash commands (e.g. Claude Desktop, JetBrains). */
  promptText?: string
  /** Restart action label and instructions. */
  restartAction: string
  restartDetail: string
  install: (command: string, args: string[], brief: string, projectRoot?: string) => InstallResult
}

export type ServerLocation =
  | { format: 'json'; path: string; keyPath: string[] }
  | { format: 'toml'; path: string }
  | { format: 'xml'; path: string }

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
  // Some hosts require fields beyond command/args before they will load a
  // server at all. Zed is the live example: see its descriptor below.
  extraEntryFields: Record<string, unknown> = {},
): InstallResult {
  const existing = readJson(path)
  if (existing === null) {
    return {
      ok: false,
      detail: `${path} could not be read as JSON. Fix or move it, then try again - Axiom will not overwrite configuration it cannot understand.`,
      paths: [path],
    }
  }
  const servers = (existing[key] ?? {}) as Record<string, unknown>
  existing[key] = { ...servers, axiom: { ...extraEntryFields, command, args } }
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
 * XML attribute values are user-controlled here: `command` is an absolute node
 * path and the args carry the MCP path and project root. A home directory
 * containing & or < is enough to corrupt a real IDE configuration file, so
 * every value is escaped rather than interpolated raw.
 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function upsertJetBrainsXml(
  path: string,
  command: string,
  args: string[],
): InstallResult {
  try {
    fs.mkdirSync(join(path, '..'), { recursive: true })
    const argsXml = args
      .map(arg => `<arg value="${escapeXmlAttribute(arg)}" />`)
      .join('\n              ')
    const axiomEntry = [
      '        <entry key="axiom">',
      '          <value>',
      `            <McpServerConfiguration name="axiom" command="${escapeXmlAttribute(command)}">`,
      '              <args>',
      `              ${argsXml}`,
      '              </args>',
      '            </McpServerConfiguration>',
      '          </value>',
      '        </entry>',
    ].join('\n')

    if (!fs.existsSync(path)) {
      const initialXml = [
        '<application>',
        '  <component name="LlmMcpServers">',
        '    <option name="servers">',
        '      <map>',
        axiomEntry,
        '      </map>',
        '    </option>',
        '  </component>',
        '</application>',
      ].join('\n')
      fs.writeFileSync(path, initialXml, 'utf8')
      return { ok: true, detail: 'Configured Axiom for JetBrains AI Assistant.', paths: [path] }
    }

    const existing = fs.readFileSync(path, 'utf8')
    let updated: string
    if (existing.includes('<entry key="axiom">')) {
      updated = existing.replace(/<entry key="axiom">[\s\S]*?<\/entry>/, axiomEntry.trim())
    } else if (existing.includes('<map>')) {
      updated = existing.replace('<map>', `<map>\n${axiomEntry}`)
    } else {
      updated = existing.replace(
        '</component>',
        `  <option name="servers">\n      <map>\n${axiomEntry}\n      </map>\n    </option>\n  </component>`,
      )
    }

    // Every branch above is a string replace, and a replace that matches
    // nothing returns the input untouched. Writing that back and reporting
    // success would tell the user Axiom was installed into a file it never
    // changed - so an unrecognised document is a failure, not a silent no-op.
    if (updated === existing) {
      return {
        ok: false,
        detail: `Could not find an MCP server section to update in ${path}. `
          + 'Add Axiom through Settings > Tools > AI Assistant > MCP Servers instead.',
        paths: [path],
      }
    }

    fs.writeFileSync(path, updated, 'utf8')
    return { ok: true, detail: 'Added Axiom to JetBrains AI Assistant.', paths: [path] }
  } catch (error) {
    return {
      ok: false,
      detail: `Could not write JetBrains configuration: ${error instanceof Error ? error.message : String(error)}`,
      paths: [path],
    }
  }
}

/**
 * Inspect the same configuration locations the installer writes.
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

    if (location.format === 'toml') {
      try {
        const config = fs.readFileSync(location.path, 'utf8')
        if (/^\s*\[\s*mcp_servers\s*\.\s*(?:axiom|"axiom"|'axiom')\s*\]\s*(?:#.*)?$/m.test(config)) {
          configuredPaths.add(location.path)
        }
      } catch {
        unreadablePaths.add(location.path)
      }
      continue
    }

    if (location.format === 'xml') {
      try {
        const content = fs.readFileSync(location.path, 'utf8')
        if (content.includes('key="axiom"') || content.includes('name="axiom"')) {
          configuredPaths.add(location.path)
        }
      } catch {
        unreadablePaths.add(location.path)
      }
    }
  }

  const isDesktopChat = host.triggerKind === 'chat prompt'

  return {
    configured: configuredPaths.size > 0,
    configuredPaths: [...configuredPaths],
    unreadablePaths: [...unreadablePaths],
    workflowInstalled: isDesktopChat || (() => {
      const path = host.commandPath?.(projectRoot)
      return path ? fs.existsSync(path) : false
    })(),
    workflowPath: host.commandPath?.(projectRoot) ?? null,
  }
}

/** A user-supplied config location for a host Axiom could not find itself. */
export type ConfigOverrides = Record<string, string>

export function buildHosts(
  homeDir = home(),
  explicitAppDataDir?: string,
  platform: NodeJS.Platform = process.platform,
  overrides: ConfigOverrides = {},
): HostDescriptor[] {
  const paths = getPlatformPaths(homeDir, platform)
  const appDataDir = explicitAppDataDir ?? paths.appDataDir

  // One resolver for both halves of a host. Detection, inspection and install
  // have to agree on the file: an override that moved only the first would
  // report a tool configured while writing somewhere it never reads.
  const primary = (hostId: string, fallback: string): string => overrides[hostId] ?? fallback

  const claudeCodeConfig = primary('claude-code', join(homeDir, '.claude.json'))
  const claudeDesktopConfig = primary(
    'claude-desktop', getClaudeDesktopConfigPath(homeDir, platform, appDataDir),
  )
  const copilotVsCodeConfig = primary('copilot', getVsCodeUserMcpPath(homeDir, platform, false, appDataDir))
  const copilotCliConfig = primary('copilot-cli', join(homeDir, '.copilot', 'mcp-config.json'))
  const codexConfig = primary('codex', join(homeDir, '.codex', 'config.toml'))
  const cursorConfig = primary('cursor', join(homeDir, '.cursor', 'mcp.json'))
  const windsurfConfig = primary('windsurf', join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'))
  const antigravityConfig = primary('antigravity', join(homeDir, '.gemini', 'config', 'mcp_config.json'))
  const zedConfig = primary('zed', getZedConfigPath(homeDir, platform, appDataDir))
  const jetbrainsDirectories = findJetBrainsDirectories(homeDir, platform, appDataDir)
  const jetbrainsConfig = primary(
    'jetbrains',
    jetbrainsDirectories[0]
      ? join(jetbrainsDirectories[0], 'options', 'llm.mcpServers.xml')
      : join(appDataDir, 'JetBrains', 'options', 'llm.mcpServers.xml'),
  )

  return [
    // ── Anthropic Claude Family ──────────────────────────────────────────────
    {
      id: 'claude-code',
      label: 'Claude Code (CLI)',
      familyId: 'claude',
      familyLabel: 'Claude',
      modality: 'cli',
      modalityLabel: 'Claude Code (CLI)',
      sharedSurfaces: [
        { id: 'claude-code-vscode', label: 'Claude Code in VS Code' },
        { id: 'claude-code-jetbrains', label: 'Claude Code in JetBrains' },
      ],
      configPath: () => claudeCodeConfig,
      // ~/.claude.json sits directly in the home directory, so its parent
      // proves nothing. The CLI's own ~/.claude directory is the real marker.
      detectPaths: () => [join(homeDir, '.claude')],
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
      triggerKind: 'slash command',
      restartAction: 'Restart CLI session',
      restartDetail: 'Close the existing terminal session and run claude in a new one, or run /skills reload.',
      install: (command, args, brief) => {
        const hostArgs = identifiedArgs(args, 'claude-code')
        const result = installJsonServer(claudeCodeConfig, 'mcpServers', command, hostArgs, 'Claude Code')
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
      id: 'claude-desktop',
      label: 'Claude Desktop',
      familyId: 'claude',
      familyLabel: 'Claude',
      modality: 'desktop',
      modalityLabel: 'Claude Desktop (App)',
      configPath: () => claudeDesktopConfig,
      serverLocations: () => [
        { format: 'json', path: getClaudeDesktopConfigPath(homeDir, platform, appDataDir), keyPath: ['mcpServers'] },
      ],
      command: 'Ask Claude in chat to map this project',
      triggerKind: 'chat prompt',
      promptText: "Use Axiom's tools (get_architecture, edit_systems) to map this codebase's architecture into a semantic system tree.",
      restartAction: 'Quit & Relaunch Claude Desktop',
      restartDetail: 'Fully quit Claude Desktop (Cmd+Q on macOS, Alt+F4 on Windows) and relaunch it.',
      install: (command, args) => {
        const hostArgs = identifiedArgs(args, 'claude-desktop')
        const target = claudeDesktopConfig
        const result = installJsonServer(target, 'mcpServers', command, hostArgs, 'Claude Desktop')
        if (!result.ok) return result
        return {
          ok: true,
          detail: 'Added Axiom to Claude Desktop. Quit and restart Claude Desktop to load the tools.',
          paths: result.paths,
        }
      },
    },

    // ── GitHub Copilot Family ────────────────────────────────────────────────
    {
      id: 'copilot',
      label: 'GitHub Copilot (VS Code)',
      familyId: 'copilot',
      familyLabel: 'GitHub Copilot',
      modality: 'vscode',
      modalityLabel: 'VS Code Extension',
      configPath: () => copilotVsCodeConfig,
      serverLocations: projectRoot => [
        { format: 'json', path: getVsCodeUserMcpPath(homeDir, platform, false, appDataDir), keyPath: ['servers'] },
        { format: 'json', path: getVsCodeUserMcpPath(homeDir, platform, true, appDataDir), keyPath: ['servers'] },
        ...(projectRoot ? [
          {
            format: 'json' as const,
            path: join(projectRoot, '.vscode', 'mcp.json'),
            keyPath: ['servers'],
          },
        ] : []),
        { format: 'json', path: join(homeDir, '.copilot', 'mcp-config.json'), keyPath: ['mcpServers'] },
      ],
      commandPath: () => join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      triggerKind: 'slash command',
      restartAction: 'Reload VS Code Window',
      restartDetail: 'Press Cmd+Shift+P (or Ctrl+Shift+P) and run "Developer: Reload Window".',
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'copilot')
        const userMcp = copilotVsCodeConfig
        const user = installJsonServer(userMcp, 'servers', command, hostArgs, 'VS Code User MCP')
        const paths = [...user.paths]
        let configured = user.ok

        if (projectRoot) {
          const ws = installJsonServer(join(projectRoot, '.vscode', 'mcp.json'), 'servers', command, hostArgs, 'Workspace VS Code')
          paths.push(...ws.paths)
          configured = configured || ws.ok

          const legacyPrompt = join(projectRoot, '.github', 'prompts', 'axiom-map.prompt.md')
          if (removeGeneratedFile(legacyPrompt, brief)) paths.push(legacyPrompt)
        }

        paths.push(installAgentSkill(join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: configured,
          detail: 'Added Axiom and installed the /axiom-map Agent Skill for Copilot in VS Code. Reload your window to apply.',
          paths,
        }
      },
    },
    {
      id: 'copilot-cli',
      label: 'GitHub Copilot (CLI)',
      familyId: 'copilot',
      familyLabel: 'GitHub Copilot',
      modality: 'cli',
      modalityLabel: 'Copilot CLI',
      configPath: () => copilotCliConfig,
      serverLocations: () => [
        { format: 'json', path: join(homeDir, '.copilot', 'mcp-config.json'), keyPath: ['mcpServers'] },
      ],
      commandPath: () => join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      triggerKind: 'slash command',
      restartAction: 'Restart CLI session',
      restartDetail: 'Run /skills reload in Copilot CLI, or exit and start a new terminal session.',
      install: (command, args, brief) => {
        const hostArgs = identifiedArgs(args, 'copilot-cli')
        const user = installJsonServer(copilotCliConfig, 'mcpServers', command, hostArgs, 'Copilot CLI')
        const paths = [...user.paths]
        paths.push(installAgentSkill(join(homeDir, '.copilot', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: user.ok,
          detail: 'Added Axiom and installed the /axiom-map Agent Skill for Copilot CLI.',
          paths,
        }
      },
    },

    // ── OpenAI Codex Family ──────────────────────────────────────────────────
    {
      id: 'codex',
      label: 'OpenAI Codex (CLI)',
      familyId: 'codex',
      // Product names, not vendor names: every other family is listed as the
      // thing itself. GitHub Copilot keeps its prefix only because that is the
      // product's own name and "Copilot" alone collides with Microsoft's.
      familyLabel: 'Codex',
      modality: 'cli',
      modalityLabel: 'Codex CLI',
      sharedSurfaces: [
        { id: 'codex-ide', label: 'Codex IDE extension' },
        { id: 'codex-app', label: 'Codex desktop app' },
      ],
      configPath: () => codexConfig,
      serverLocations: projectRoot => [
        { format: 'toml', path: codexConfig },
        ...(projectRoot
          ? [{ format: 'toml' as const, path: join(projectRoot, '.codex', 'config.toml') }]
          : []),
      ],
      commandPath: () => join(homeDir, '.agents', 'skills', 'axiom-map', 'SKILL.md'),
      command: '$axiom-map',
      triggerKind: 'skill command',
      restartAction: 'Start fresh Codex session',
      restartDetail: 'Exit the current terminal session and launch codex in your project.',
      install: (command, args, brief) => {
        const path = codexConfig
        fs.mkdirSync(join(homeDir, '.codex'), { recursive: true })
        const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''
        const hostArgs = identifiedArgs(args, 'codex')
        const block = [
          '[mcp_servers.axiom]',
          `command = ${JSON.stringify(command)}`,
          `args = [${hostArgs.map(a => JSON.stringify(a)).join(', ')}]`,
        ].join('\n')
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

    // ── Cursor Family ────────────────────────────────────────────────────────
    {
      id: 'cursor',
      label: 'Cursor (IDE)',
      familyId: 'cursor',
      familyLabel: 'Cursor',
      modality: 'desktop',
      modalityLabel: 'Cursor IDE',
      sharedSurfaces: [{ id: 'cursor-cli', label: 'cursor-agent CLI' }],
      configPath: () => cursorConfig,
      serverLocations: projectRoot => [
        { format: 'json', path: join(homeDir, '.cursor', 'mcp.json'), keyPath: ['mcpServers'] },
        ...(projectRoot
          ? [{ format: 'json' as const, path: join(projectRoot, '.cursor', 'mcp.json'), keyPath: ['mcpServers'] }]
          : []),
      ],
      commandPath: () => join(homeDir, '.cursor', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      triggerKind: 'slash command',
      restartAction: 'Reload Window in Cursor',
      restartDetail: 'Press Cmd+Shift+P (or Ctrl+Shift+P) and run "Developer: Reload Window" or restart Cursor.',
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'cursor')
        const global = installJsonServer(cursorConfig, 'mcpServers', command, hostArgs, 'Cursor')
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

    // ── Windsurf Family ──────────────────────────────────────────────────────
    {
      id: 'windsurf',
      label: 'Windsurf (Cascade)',
      familyId: 'windsurf',
      familyLabel: 'Windsurf',
      modality: 'desktop',
      modalityLabel: 'Windsurf IDE',
      configPath: () => windsurfConfig,
      serverLocations: projectRoot => [
        {
          format: 'json',
          path: join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
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
      ],
      commandPath: () => join(homeDir, '.codeium', 'windsurf', 'skills', 'axiom-map', 'SKILL.md'),
      command: '/axiom-map',
      triggerKind: 'slash command',
      restartAction: 'Restart Windsurf',
      restartDetail: 'Quit and relaunch Windsurf or click the Refresh icon in the MCP Cascade panel.',
      install: (command, args, brief) => {
        const hostArgs = identifiedArgs(args, 'windsurf')
        const cascade = installJsonServer(
          windsurfConfig,
          'mcpServers', command, hostArgs, 'Windsurf Cascade',
        )
        const devin = installJsonServer(
          join(appDataDir, 'devin', 'mcp_config.json'),
          'mcpServers', command, hostArgs, 'Windsurf / Devin Local',
        )
        const paths = [...cascade.paths, ...devin.paths]
        paths.push(installAgentSkill(join(homeDir, '.codeium', 'windsurf', 'skills', 'axiom-map', 'SKILL.md'), brief))
        paths.push(installAgentSkill(join(appDataDir, 'devin', 'skills', 'axiom-map', 'SKILL.md'), brief))
        return {
          ok: cascade.ok || devin.ok,
          detail: 'Added Axiom and installed its Agent Skill for Windsurf Cascade and Devin Local.',
          paths,
        }
      },
    },

    // ── Google Antigravity Family ────────────────────────────────────────────
    {
      id: 'antigravity',
      label: 'Antigravity (IDE)',
      familyId: 'antigravity',
      familyLabel: 'Antigravity',
      modality: 'desktop',
      modalityLabel: 'Antigravity IDE',
      sharedSurfaces: [{ id: 'antigravity-cli', label: 'Antigravity CLI (agy)' }],
      configPath: () => antigravityConfig,
      serverLocations: projectRoot => [
        {
          format: 'json',
          path: join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          keyPath: ['mcpServers'],
        },
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
      triggerKind: 'skill command',
      restartAction: 'Reload Window in Antigravity',
      restartDetail: 'Press Cmd+Shift+P (or Ctrl+Shift+P) and choose "Reload Window" or start a new agent chat.',
      install: (command, args, brief, projectRoot) => {
        const hostArgs = identifiedArgs(args, 'antigravity')
        const global = installJsonServer(
          antigravityConfig,
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

    // ── JetBrains IDE Family ─────────────────────────────────────────────────
    {
      id: 'jetbrains',
      label: 'JetBrains (AI Assistant)',
      familyId: 'jetbrains',
      familyLabel: 'JetBrains',
      modality: 'editor',
      modalityLabel: 'JetBrains AI Assistant',
      configPath: () => jetbrainsConfig,
      serverLocations: () => {
        const dirs = findJetBrainsDirectories(homeDir, platform, appDataDir)
        const fallback = join(appDataDir, 'JetBrains', 'options', 'llm.mcpServers.xml')
        const locations: ServerLocation[] = [
          ...dirs.map(dir => ({ format: 'xml' as const, path: join(dir, 'options', 'llm.mcpServers.xml') })),
          { format: 'xml' as const, path: fallback },
        ]
        return locations
      },
      command: 'Prompt AI Assistant in chat to map this project',
      triggerKind: 'chat prompt',
      promptText: "Use the Axiom MCP tools (get_architecture, edit_systems) to map this codebase's architecture into a tree of semantic systems.",
      restartAction: 'Restart JetBrains IDE',
      restartDetail: 'Restart your JetBrains IDE (IntelliJ, WebStorm, PyCharm) or open Settings > Tools > AI Assistant > MCP Servers.',
      install: (command, args) => {
        const hostArgs = identifiedArgs(args, 'jetbrains')
        // A user who pointed Axiom at a specific IDE profile means that one,
        // not every profile discovery happens to turn up.
        if (overrides.jetbrains) {
          const res = upsertJetBrainsXml(jetbrainsConfig, command, hostArgs)
          return {
            ok: res.ok,
            detail: res.ok
              ? `Configured Axiom for JetBrains AI Assistant at ${jetbrainsConfig}.`
              : res.detail,
            paths: res.paths,
          }
        }
        const dirs = jetbrainsDirectories
        const paths: string[] = []
        let ok = false

        if (dirs.length === 0) {
          const fallbackPath = join(appDataDir, 'JetBrains', 'options', 'llm.mcpServers.xml')
          const res = upsertJetBrainsXml(fallbackPath, command, hostArgs)
          paths.push(...res.paths)
          ok = res.ok
        } else {
          for (const dir of dirs) {
            const xmlPath = join(dir, 'options', 'llm.mcpServers.xml')
            const res = upsertJetBrainsXml(xmlPath, command, hostArgs)
            paths.push(...res.paths)
            if (res.ok) ok = true
          }
        }

        return {
          ok,
          detail: 'Configured Axiom for JetBrains AI Assistant. You can also click "Import from Claude Desktop" in Settings > Tools > AI Assistant > MCP Servers.',
          paths,
        }
      },
    },

    // ── Zed Editor Family ────────────────────────────────────────────────────
    {
      id: 'zed',
      label: 'Zed Editor',
      familyId: 'zed',
      familyLabel: 'Zed',
      modality: 'editor',
      modalityLabel: 'Zed Editor',
      configPath: () => zedConfig,
      serverLocations: () => [
        { format: 'json', path: getZedConfigPath(homeDir, platform, appDataDir), keyPath: ['context_servers'] },
      ],
      command: 'Ask Zed AI Assistant to map this project',
      triggerKind: 'chat prompt',
      promptText: "Use Axiom's tools to map this codebase's architecture into a semantic system tree.",
      restartAction: 'Restart Zed',
      restartDetail: 'Restart Zed or open Settings -> AI -> MCP Servers to verify the active connection.',
      install: (command, args) => {
        const hostArgs = identifiedArgs(args, 'zed')
        const target = zedConfig
        // Zed ignores a manually added context server unless it declares
        // source: "custom". Without this the write succeeds, the file looks
        // right, and Zed silently never loads Axiom.
        const result = installJsonServer(
          target, 'context_servers', command, hostArgs, 'Zed Editor',
          { source: 'custom' },
        )
        return {
          ok: result.ok,
          detail: 'Added Axiom to Zed settings.json context_servers.',
          paths: result.paths,
        }
      },
    },
  ]
}

/**
 * Which hosts look present on this machine.
 */
export function detectHosts(
  homeDir = home(),
  explicitAppDataDir?: string,
  platform: NodeJS.Platform = process.platform,
  overrides: ConfigOverrides = {},
): Record<string, boolean> {
  const seen: Record<string, boolean> = {}
  const homeResolved = resolve(homeDir)
  for (const host of buildHosts(homeDir, explicitAppDataDir, platform, overrides)) {
    const configPath = host.configPath()
    const parent = resolve(join(configPath, '..'))
    // A config folder of the host's own (~/.codex, ~/.cursor) is good evidence
    // the tool is installed. The home directory is not: it exists for
    // everyone, so counting it marks every such host present on every machine.
    const parentIsEvidence = parent !== homeResolved && fs.existsSync(parent)

    seen[host.id] = parentIsEvidence ||
      fs.existsSync(configPath) ||
      (host.detectPaths?.() ?? []).some(path => fs.existsSync(path)) ||
      host.serverLocations().some(location => fs.existsSync(location.path))
  }
  return seen
}

/**
 * Batch-installs Axiom into all detected modalities for an agent family,
 * or all modalities if none are detected yet.
 */
export function installFamily(
  familyId: string,
  command: string,
  args: string[],
  brief: string,
  projectRoot?: string,
  homeDir = home(),
  explicitAppDataDir?: string,
  platform: NodeJS.Platform = process.platform,
): InstallResult {
  const allHosts = buildHosts(homeDir, explicitAppDataDir, platform)
  const familyHosts = allHosts.filter(h => h.familyId === familyId)
  if (familyHosts.length === 0) {
    return { ok: false, detail: `Unknown agent family "${familyId}".`, paths: [] }
  }

  const detected = detectHosts(homeDir, explicitAppDataDir, platform)
  let targets = familyHosts.filter(h => detected[h.id] === true)
  if (targets.length === 0) {
    targets = familyHosts // Fallback to all modalities in the family
  }

  const touchedPaths: string[] = []
  let allOk = true
  const successes: string[] = []

  for (const target of targets) {
    const res = target.install(command, args, brief, projectRoot)
    touchedPaths.push(...res.paths)
    if (res.ok) {
      successes.push(target.modalityLabel)
    } else {
      allOk = false
    }
  }

  const familyLabel = familyHosts[0].familyLabel
  return {
    ok: allOk,
    detail: allOk
      ? `Installed Axiom into all detected ${familyLabel} modalities (${successes.join(', ')}).`
      : `Partially configured ${familyLabel}: ${successes.join(', ')} ready.`,
    paths: [...new Set(touchedPaths)],
  }
}
