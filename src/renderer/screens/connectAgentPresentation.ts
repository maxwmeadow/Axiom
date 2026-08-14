import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'

export type AgentHostState = 'missing' | 'available' | 'repair' | 'installed' | 'live'

export interface AgentHostPresentation {
  state: AgentHostState
  detail: string
  action: 'none' | 'install' | 'repair' | 'reinstall'
}

/**
 * Collapse the installer's detailed evidence into one honest, inspectable
 * signal. The row stays quiet; hover/focus on the signal reveals the evidence.
 */
export function presentAgentHost(
  host: AgentHostInfo,
  result: AgentInstallResult | undefined,
  connectedNow: boolean,
): AgentHostPresentation {
  if (connectedNow) {
    return {
      state: 'live',
      detail: `${host.label} is connected to this Axiom project right now.`,
      action: 'reinstall',
    }
  }

  if (result?.ok || (host.configured && host.workflowInstalled)) {
    return {
      state: 'installed',
      detail: `Axiom MCP and the ${host.command ?? 'mapping'} workflow are installed correctly for ${host.label}.`,
      action: 'reinstall',
    }
  }

  if (host.unreadablePaths.length > 0) {
    return {
      state: 'repair',
      detail: `${host.label}'s configuration could not be read safely. Axiom will not overwrite it.`,
      action: 'repair',
    }
  }

  if (host.configured && !host.workflowInstalled) {
    return {
      state: 'repair',
      detail: `Axiom MCP is configured for ${host.label}, but its reusable mapping workflow is missing.`,
      action: 'repair',
    }
  }

  if (!host.detected) {
    return {
      state: 'missing',
      detail: `${host.label} was not found on this machine. Install it before adding Axiom.`,
      action: 'none',
    }
  }

  return {
    state: 'available',
    detail: `${host.label} is installed on this machine, but Axiom has not been added yet.`,
    action: 'install',
  }
}

export function commandKind(command: string): 'slash command' | 'skill command' | 'instruction' {
  if (command.startsWith('/')) return 'slash command'
  if (command.startsWith('$')) return 'skill command'
  return 'instruction'
}
