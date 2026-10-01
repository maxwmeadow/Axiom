import fs from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { DRAW_FIRST_WORKFLOW } from '../src/shared/agentWorkflow.ts'

export interface AgentRuleFile { path: string; prefix: string; shared: boolean }
const END = '<!-- /axiom:draw-first -->'
const START = /<!-- axiom:draw-first:v1 sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*?)<!-- \/axiom:draw-first -->/g
const hash = (text: string) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
const payload = DRAW_FIRST_WORKFLOW + '\n'
const block = `<!-- axiom:draw-first:v1 sha256=${hash(payload)} -->\n${payload}${END}`

/** Project-scoped rules; no global changes to unrelated coding sessions. */
export function agentRuleFiles(hostId: string, projectRoot?: string): AgentRuleFile[] {
  if (!projectRoot) return []
  const file = (path: string, prefix = '', shared = false): AgentRuleFile[] => [{ path: join(projectRoot, path), prefix, shared }]
  switch (hostId) {
    case 'claude-code': return file('.claude/rules/axiom-draw-first.md')
    case 'codex':
    case 'copilot-cli': return file('AGENTS.md', '', true)
    case 'copilot': return file('.github/copilot-instructions.md', '', true)
    case 'cursor': return file('.cursor/rules/axiom-draw-first.mdc', '---\nalwaysApply: true\n---\n\n')
    case 'windsurf': return [
      ...file('.windsurf/rules/axiom-draw-first.md', '---\ntrigger: always_on\n---\n\n'),
      ...file('.devin/rules/axiom-draw-first.md', '---\ntrigger: always_on\n---\n\n'),
    ]
    case 'antigravity': return file('.agents/rules/axiom-draw-first.md', '---\ntrigger: always_on\n---\n\n')
    case 'jetbrains': return file('.aiassistant/rules/axiom-draw-first.md', '---\ntype: always\n---\n\n')
    case 'zed': return file('.rules', '', true)
    default: return [] // Claude Desktop receives the same contract over MCP.
  }
}

function managedBlock(source: string) {
  const matches = [...source.matchAll(START)]
  if (matches.length !== 1 || source.split('<!-- axiom:draw-first:').length !== 2 || source.split(END).length !== 2 || hash(matches[0][2]) !== matches[0][1]) return null
  return matches[0]
}

export function ruleInstalled(file: AgentRuleFile): boolean {
  try {
    const source = fs.readFileSync(file.path, 'utf8').replaceAll('\r\n', '\n')
    return !!managedBlock(source) && source.includes(block) && source.startsWith(file.prefix)
  } catch { return false }
}

/** Keep authored text verbatim, and refuse to overwrite an edited managed block. */
export function installAgentRule(file: AgentRuleFile): void {
  const source = fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : ''
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const managed = managedBlock(source)
  let next: string
  if (source.includes('<!-- axiom:draw-first:') || source.includes(END)) {
    if (!managed || !source.replaceAll('\r\n', '\n').startsWith(file.prefix)) throw new Error(`Axiom's rule in ${file.path} was edited or is incomplete. Keep your edits and repair it manually.`)
    next = source.slice(0, managed.index) + block.replaceAll('\n', newline) + source.slice(managed.index! + managed[0].length)
  } else {
    if (!file.shared && source.trim()) throw new Error(`${file.path} already contains an authored rule. Axiom left it unchanged.`)
    next = source + (source ? (source.endsWith('\n') ? newline : newline + newline) : file.prefix) + block.replaceAll('\n', newline) + newline
  }
  fs.mkdirSync(dirname(file.path), { recursive: true })
  fs.writeFileSync(file.path, next, 'utf8')
}

export function removeAgentRule(file: AgentRuleFile): boolean {
  if (!fs.existsSync(file.path)) return false
  const source = fs.readFileSync(file.path, 'utf8')
  const managed = managedBlock(source)
  if (!managed) return false // User edits are theirs to keep.
  const remaining = source.slice(0, managed.index) + source.slice(managed.index! + managed[0].length)
  if (remaining.replaceAll('\r\n', '\n').trim() === file.prefix.trim()) fs.rmSync(file.path)
  else fs.writeFileSync(file.path, remaining, 'utf8')
  return true
}
