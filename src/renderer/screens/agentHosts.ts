/**
 * How each agent is told about Axiom.
 *
 * Every host speaks MCP, but none of them are configured the same way: Claude
 * Code has a CLI that writes its own config, Codex keeps servers in a TOML
 * file, the editors want JSON in a project file. Handing everyone the same
 * JSON blob and wishing them luck is where a working connection turns into a
 * support problem, so each host gets the thing you actually paste, in the
 * format that host accepts.
 *
 * What happens *after* connecting is identical everywhere, and that is the
 * point of doing it this way: Axiom publishes `/axiom:name-architecture` as an
 * MCP prompt, so any host that supports prompts surfaces it as a slash command.
 * The user runs one command in a fresh session and the agent is briefed by the
 * server — no prompt to copy, no instructions to keep in sync with the product.
 */

export interface AgentHost {
  id: string
  label: string
  /** How this host is told about an MCP server, in one line. */
  how: string
  /** The exact thing to paste or run. */
  snippet: (command: string, args: string[]) => string
  /** Where it goes, if it is a file rather than a command. */
  location?: string
  /**
   * How this host exposes an MCP prompt as a slash command. Hosts disagree:
   * Claude Code namespaces them `/mcp__<server>__<prompt>`, others use
   * `/<server>:<prompt>`. Telling everyone the same syntax sends most of them
   * looking for a command that does not exist in their client.
   */
  command: string
}

const jsonEntry = (command: string, args: string[]) =>
  JSON.stringify({ mcpServers: { axiom: { command, args } } }, null, 2)

export const AGENT_HOSTS: AgentHost[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    how: 'Run this in your terminal — Claude Code writes its own configuration.',
    snippet: (command, args) => `claude mcp add axiom -- ${command} ${args.map(quote).join(' ')}`,
    command: '/mcp__axiom__name-architecture',
  },
  {
    id: 'codex',
    label: 'Codex',
    how: 'Add this to your Codex configuration.',
    location: '~/.codex/config.toml',
    command: '/axiom:name-architecture',
    snippet: (command, args) =>
      `[mcp_servers.axiom]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map(a => JSON.stringify(a)).join(', ')}]`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    how: 'Add this to your project’s MCP configuration.',
    location: '.cursor/mcp.json',
    command: '/axiom:name-architecture',
    snippet: jsonEntry,
  },
  {
    id: 'other',
    label: 'Anything else',
    how: 'Most hosts take a server entry in this shape.',
    command: '/axiom:name-architecture',
    snippet: jsonEntry,
  },
]

/** Windows paths carry spaces often enough that an unquoted argument is a bug. */
function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}
