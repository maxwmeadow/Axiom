import fs from 'fs'
import { join } from 'path'
import type { ConfigOverrides } from './agentInstallers'

/**
 * Where the user has told Axiom a host actually keeps its configuration.
 *
 * Detection is a set of educated guesses about paths, and it will be wrong:
 * tools move, ship second installers, or get installed somewhere unusual.
 * Rather than treat "not found" as final, a user can point Axiom at the file
 * and that answer is remembered here.
 */
const OVERRIDES_FILE = 'agent-config-overrides.json'

export function overridesFilePath(configDir: string): string {
  return join(configDir, OVERRIDES_FILE)
}

export function readOverrides(configDir: string): ConfigOverrides {
  try {
    const raw = fs.readFileSync(overridesFilePath(configDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: ConfigOverrides = {}
    for (const [hostId, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A path that has since been deleted is worse than no override: it would
      // pin the host to a file that cannot be read or written.
      if (typeof value === 'string' && value && fs.existsSync(value)) result[hostId] = value
    }
    return result
  } catch {
    // Absent or unreadable: fall back to detection, never to a crash.
    return {}
  }
}

function writeOverrides(configDir: string, overrides: ConfigOverrides): void {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(overridesFilePath(configDir), JSON.stringify(overrides, null, 2) + '\n', 'utf8')
}

export interface OverrideResult {
  ok: boolean
  detail: string
  path?: string
}

export function setOverride(configDir: string, hostId: string, configPath: string): OverrideResult {
  if (!fs.existsSync(configPath)) {
    return { ok: false, detail: `${configPath} does not exist.` }
  }
  if (!fs.statSync(configPath).isFile()) {
    return { ok: false, detail: 'Choose the configuration file itself, not a folder.' }
  }
  const overrides = readOverrides(configDir)
  overrides[hostId] = configPath
  writeOverrides(configDir, overrides)
  return { ok: true, detail: `Axiom will use ${configPath} for this agent.`, path: configPath }
}

export function clearOverride(configDir: string, hostId: string): OverrideResult {
  const overrides = readOverrides(configDir)
  delete overrides[hostId]
  writeOverrides(configDir, overrides)
  return { ok: true, detail: 'Axiom will detect this agent on its own again.' }
}
