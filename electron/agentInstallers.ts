import { join } from 'path'
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
  /** Where its slash commands live, if it has them. */
  commandPath?: () => string
  /** The command a user types once installed. */
  command?: string
  install: (command: string, args: string[], brief: string) => InstallResult
}

const home = () => os.homedir()

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

export function buildHosts(): HostDescriptor[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: () => join(home(), '.claude.json'),
      commandPath: () => join(home(), '.claude', 'commands', 'axiom-map.md'),
      command: '/axiom-map',
      install: (command, args, brief) => {
        const result = installJsonServer(join(home(), '.claude.json'), 'mcpServers', command, args, 'Claude Code')
        if (!result.ok) return result
        const cmd = installCommandFile(join(home(), '.claude', 'commands', 'axiom-map.md'), brief)
        return {
          ok: true,
          detail: 'Added Axiom and installed /axiom-map. Restart Claude Code.',
          paths: [...result.paths, cmd],
        }
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      configPath: () => join(home(), '.codex', 'config.toml'),
      commandPath: () => join(home(), '.codex', 'prompts', 'axiom-map.md'),
      command: '/axiom-map',
      install: (command, args, brief) => {
        const path = join(home(), '.codex', 'config.toml')
        fs.mkdirSync(join(home(), '.codex'), { recursive: true })
        const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : ''
        const block = [
          '[mcp_servers.axiom]',
          `command = ${JSON.stringify(command)}`,
          `args = [${args.map(a => JSON.stringify(a)).join(', ')}]`,
        ].join('\n')
        // TOML has no safe generic merge without a parser, so an existing
        // section is replaced in place and anything else is left untouched.
        const next = /\[mcp_servers\.axiom\][^\[]*/.test(existing)
          ? existing.replace(/\[mcp_servers\.axiom\][^\[]*/, block + '\n\n')
          : (existing.trimEnd() + (existing.trim() ? '\n\n' : '') + block + '\n')
        fs.writeFileSync(path, next, 'utf8')
        const cmd = installCommandFile(join(home(), '.codex', 'prompts', 'axiom-map.md'), brief)
        return {
          ok: true,
          detail: 'Added Axiom and installed /axiom-map. Restart Codex.',
          paths: [path, cmd],
        }
      },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: () => join(home(), '.cursor', 'mcp.json'),
      install: (command, args) =>
        installJsonServer(join(home(), '.cursor', 'mcp.json'), 'mcpServers', command, args, 'Cursor'),
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      configPath: () => join(home(), '.vscode', 'mcp.json'),
      commandPath: () => join(home(), '.vscode', 'prompts', 'axiom-map.prompt.md'),
      command: '/axiom-map',
      install: (command, args, brief) => {
        // VS Code takes servers under `servers`, not `mcpServers`.
        const result = installJsonServer(join(home(), '.vscode', 'mcp.json'), 'servers', command, args, 'GitHub Copilot')
        if (!result.ok) return result
        const cmd = installCommandFile(join(home(), '.vscode', 'prompts', 'axiom-map.prompt.md'), brief)
        return {
          ok: true,
          detail: 'Added Axiom and installed the axiom-map prompt. Reload VS Code.',
          paths: [...result.paths, cmd],
        }
      },
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      configPath: () => join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
      install: (command, args) =>
        installJsonServer(
          join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
          'mcpServers', command, args, 'Windsurf',
        ),
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      configPath: () => join(home(), '.antigravity', 'mcp_config.json'),
      install: (command, args) =>
        installJsonServer(
          join(home(), '.antigravity', 'mcp_config.json'),
          'mcpServers', command, args, 'Antigravity',
        ),
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
    seen[host.id] = fs.existsSync(dir) || fs.existsSync(host.configPath())
  }
  return seen
}
