import fs from 'fs'
import { dirname } from 'path'
import { removeAgentRule } from './agentRules.ts'
import {
  inboxSkillPath,
  buildSkillPath,
  inspectHostConfiguration,
  readJson,
  writeJson,
  type HostDescriptor,
  type InstallResult,
} from './agentInstallers.ts'

// Undo what the installers wrote: the `axiom` MCP entry in each place a host
// reads, and the axiom-map / axiom-inbox / axiom-build workflow files. Nothing else in a
// host's configuration is touched, and a file Axiom cannot parse is left
// alone and reported rather than rewritten.

const AXIOM_TOML_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:axiom|"axiom"|'axiom')(?:\s*\.[^\]]*)?\s*\]\s*(?:#.*)?$/
const TOML_TABLE = /^\s*\[[^\]]+\]\s*(?:#.*)?$/

/** A TOML document without Axiom's `[mcp_servers.axiom]` table (and subtables). */
export function removeTomlAxiomTable(source: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (TOML_TABLE.test(line)) skipping = AXIOM_TOML_TABLE.test(line)
    if (!skipping) kept.push(line)
  }
  return kept.join(newline).replace(/(\r?\n){3,}/g, `${newline}${newline}`)
}

/** A JetBrains MCP server XML document without the `axiom` entry. */
export function removeXmlAxiomEntry(source: string): string {
  return source.replace(/[ \t]*<entry key="axiom">[\s\S]*?<\/entry>\r?\n?/, '')
}

function removeJsonEntry(path: string, keyPath: string[]): 'removed' | 'absent' | 'unreadable' {
  const config = readJson(path)
  if (config === null) return 'unreadable'
  let servers: unknown = config
  for (const key of keyPath) {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'absent'
    servers = (servers as Record<string, unknown>)[key]
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'absent'
  if (!Object.prototype.hasOwnProperty.call(servers, 'axiom')) return 'absent'
  delete (servers as Record<string, unknown>).axiom
  writeJson(path, config)
  return 'removed'
}

function removeWorkflowFile(path: string): boolean {
  // Only files in Axiom's own skill folders, and only if they still look like
  // ours - a user who rewrote the file keeps it.
  if (!/axiom-(map|inbox|build)/.test(path) || !fs.existsSync(path)) return false
  try {
    if (!/axiom/i.test(fs.readFileSync(path, 'utf8'))) return false
    fs.rmSync(path)
    const folder = dirname(path)
    if (/axiom-(map|inbox|build)$/.test(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    return true
  } catch {
    return false
  }
}

/**
 * Remove Axiom from one agent. `others` are the remaining hosts: a workflow
 * folder shared with a host that is still configured (Copilot's VS Code and
 * CLI surfaces share one) is kept.
 */
export function uninstallHost(host: HostDescriptor, projectRoot: string | undefined, others: HostDescriptor[] = []): InstallResult {
  const removed: string[] = []
  const unreadable: string[] = []

  // A file another remaining agent also reads (VS Code Copilot reads the
  // Copilot CLI's config) is left for that agent.
  const sharedPaths = new Set(others
    .filter(other => other.id !== host.id)
    .flatMap(other => other.serverLocations(projectRoot).map(location => location.path)))

  for (const location of host.serverLocations(projectRoot)) {
    if (!fs.existsSync(location.path) || sharedPaths.has(location.path)) continue
    try {
      if (location.format === 'json') {
        const outcome = removeJsonEntry(location.path, location.keyPath)
        if (outcome === 'removed') removed.push(location.path)
        if (outcome === 'unreadable') unreadable.push(location.path)
      } else {
        const source = fs.readFileSync(location.path, 'utf8')
        const next = location.format === 'toml' ? removeTomlAxiomTable(source) : removeXmlAxiomEntry(source)
        if (next !== source) {
          fs.writeFileSync(location.path, next, 'utf8')
          removed.push(location.path)
        }
      }
    } catch {
      unreadable.push(location.path)
    }
  }

  const workflows = [host.commandPath?.(projectRoot), ...(host.additionalCommandPaths?.() ?? [])].filter((path): path is string => !!path)
  for (const workflow of workflows) {
    const stillShared = others.some(other =>
      other.id !== host.id &&
      [other.commandPath?.(projectRoot), ...(other.additionalCommandPaths?.() ?? [])].includes(workflow) &&
      inspectHostConfiguration(other, projectRoot).configured)
    if (!stillShared) {
      for (const file of [workflow, inboxSkillPath(workflow), buildSkillPath(workflow)]) {
        if (removeWorkflowFile(file)) removed.push(file)
      }
    }
  }

  for (const rule of host.ruleFiles?.(projectRoot) ?? []) {
    const shared = others.some(other => other.id !== host.id &&
      (other.ruleFiles?.(projectRoot) ?? []).some(candidate => candidate.path === rule.path) &&
      inspectHostConfiguration(other, projectRoot).configured)
    if (!shared) {
      try { if (removeAgentRule(rule)) removed.push(rule.path) } catch { unreadable.push(rule.path) }
    }
  }

  if (unreadable.length > 0) {
    return {
      ok: false,
      detail: `Removed Axiom where it could, but could not read ${unreadable.join(', ')}; remove the "axiom" entry there by hand.`,
      paths: [...removed, ...unreadable],
    }
  }
  return {
    ok: true,
    detail: removed.length > 0 ? `Removed Axiom from ${host.modalityLabel || host.label}.` : `Axiom was not installed in ${host.modalityLabel || host.label}.`,
    paths: removed,
  }
}

/** Remove Axiom from every agent it knows about. */
export function uninstallAll(hosts: HostDescriptor[], projectRoot?: string): InstallResult {
  const results = hosts.map((host, index) => ({ host, result: uninstallHost(host, projectRoot, hosts.slice(index + 1)) }))
  const failed = results.filter(entry => !entry.result.ok)
  const touched = results.filter(entry => entry.result.paths.length > 0 && entry.result.ok)
  return {
    ok: failed.length === 0,
    detail: failed.length > 0
      ? failed.map(entry => entry.result.detail).join(' ')
      : touched.length > 0
        ? `Removed Axiom from ${touched.map(entry => entry.host.modalityLabel || entry.host.label).join(', ')}.`
        : 'Axiom was not installed in any agent.',
    paths: results.flatMap(entry => entry.result.paths),
  }
}
