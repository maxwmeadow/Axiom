import type { AgentHostInfo, AgentInstallResult } from '../../../electron/preload'

export type AgentHostState = 'missing' | 'available' | 'repair' | 'installed' | 'live'

export interface AgentHostPresentation {
  state: AgentHostState
  detail: string
  action: 'none' | 'install' | 'repair' | 'reinstall'
}

export interface AgentFamilyPresentation {
  familyId: string
  familyLabel: string
  state: AgentHostState
  detail: string
  detectedCount: number
  installedCount: number
  totalCount: number
  canBatchInstall: boolean
  batchAction: 'install' | 'reinstall' | 'none'
}

/**
 * Intelligent light signal for an individual modality.
 */
export function presentAgentHost(
  host: AgentHostInfo,
  result: AgentInstallResult | undefined,
  connectedNow: boolean,
): AgentHostPresentation {
  if (connectedNow) {
    return {
      state: 'live',
      detail: `${host.modalityLabel || host.label} is connected to this Axiom project right now.`,
      action: 'reinstall',
    }
  }

  if (result?.ok || (host.configured && host.workflowInstalled)) {
    return {
      state: 'installed',
      detail: `Axiom MCP and the ${host.command ?? 'mapping'} workflow are installed correctly for ${host.modalityLabel || host.label}.`,
      action: 'reinstall',
    }
  }

  if (host.unreadablePaths.length > 0) {
    return {
      state: 'repair',
      detail: `${host.modalityLabel || host.label}'s configuration could not be read safely. Axiom will not overwrite it.`,
      action: 'repair',
    }
  }

  if (host.configured && !host.workflowInstalled) {
    return {
      state: 'repair',
      detail: `Axiom MCP is configured for ${host.modalityLabel || host.label}, but its reusable mapping workflow is missing.`,
      action: 'repair',
    }
  }

  if (!host.detected) {
    return {
      state: 'missing',
      detail: `${host.modalityLabel || host.label} was not found on this machine. Install it before adding Axiom.`,
      action: 'none',
    }
  }

  return {
    state: 'available',
    detail: `${host.modalityLabel || host.label} is installed on this machine, but Axiom has not been added yet.`,
    action: 'install',
  }
}

/**
 * Intelligent light signal aggregating across an entire agent family.
 *
 * A parent light summarises its children, so it has to surface the worst thing
 * underneath rather than the best. A family whose CLI is connected while its
 * desktop app has unreadable configuration is a family that needs attention -
 * showing green there hides the only state the user could act on.
 *
 * Precedence:
 * 1. repair: any modality has broken config or a missing workflow.
 * 2. live: at least one modality is connected right now.
 * 3. installed: at least one modality is configured and ready.
 * 4. available: a modality is detected on disk, ready to install.
 * 5. missing: nothing detected on this machine.
 */
export function presentAgentFamily(
  familyId: string,
  familyLabel: string,
  modalities: AgentHostInfo[],
  results: Record<string, AgentInstallResult | undefined>,
  liveHostIds: Set<string>,
): AgentFamilyPresentation {
  const presented = modalities.map(m => presentAgentHost(m, results[m.id], liveHostIds.has(m.id)))

  const isLive = presented.some(p => p.state === 'live')
  const isInstalled = presented.some(p => p.state === 'installed')
  const isRepair = presented.some(p => p.state === 'repair')
  const isAvailable = presented.some(p => p.state === 'available')

  const detectedCount = modalities.filter(m => m.detected).length
  const installedCount = presented.filter(p => p.state === 'installed' || p.state === 'live').length
  const totalCount = modalities.length

  let state: AgentHostState = 'missing'
  let detail = `No ${familyLabel} installations were found on this machine.`

  if (isRepair) {
    const broken = modalities.filter((_, index) => presented[index].state === 'repair')
    const brokenLabels = broken.map(m => m.modalityLabel || m.label).join(', ')
    const healthy = presented.filter(p => p.state === 'live' || p.state === 'installed').length
    state = 'repair'
    detail = healthy > 0
      ? `${brokenLabels} needs repair. The other ${healthy === 1 ? 'modality is' : `${healthy} modalities are`} fine.`
      : `${brokenLabels} needs repair.`
  } else if (isLive) {
    state = 'live'
    detail = `${familyLabel} is connected to this Axiom project right now.`
  } else if (isInstalled) {
    state = 'installed'
    detail = `${familyLabel} is installed and ready (${installedCount} of ${detectedCount || totalCount} modalities configured).`
  } else if (isRepair) {
    state = 'repair'
    detail = `${familyLabel} configuration needs repair.`
  } else if (isAvailable) {
    state = 'available'
    detail = `${familyLabel} is available on this machine (${detectedCount} ${detectedCount === 1 ? 'modality' : 'modalities'} detected).`
  }

  // "Install all detected" acts on the detected modalities, or on everything
  // when nothing is detected yet. Offering it for a single target duplicates
  // the per-modality button sitting next to it, so it appears only when it
  // would genuinely do more.
  const batchTargets = detectedCount > 0 ? modalities.filter(m => m.detected) : modalities
  const canBatchInstall = batchTargets.length > 1
  const hasUnconfiguredDetected = modalities.some((m, index) =>
    m.detected && presented[index].state !== 'installed' && presented[index].state !== 'live')
  const batchAction = hasUnconfiguredDetected ? 'install' : isInstalled ? 'reinstall' : 'none'

  return {
    familyId,
    familyLabel,
    state,
    detail,
    detectedCount,
    installedCount,
    totalCount,
    canBatchInstall,
    batchAction,
  }
}

export function commandKind(
  command: string,
  triggerKind?: string,
): 'slash command' | 'skill command' | 'chat prompt' | 'instruction' {
  if (triggerKind === 'chat prompt') return 'chat prompt'
  if (command.startsWith('/')) return 'slash command'
  if (command.startsWith('$')) return 'skill command'
  return 'instruction'
}
