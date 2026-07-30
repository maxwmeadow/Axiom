export type LivingFlowDiagnosticStage =
  | 'renderer-intake'
  | 'renderer-ignored'
  | 'renderer-coalesced'
  | 'renderer-scheduled'
  | 'renderer-arrival'
  | 'renderer-arrival-skipped'
  | 'renderer-expired'
  | 'paint-start'
  | 'paint-end'
  | 'paint-cancel'

export interface LivingFlowDiagnostic {
  timestamp: string
  elapsedMs: number
  stage: LivingFlowDiagnosticStage
  traceId: string
  key?: number
  route?: string
  semanticRoute?: string
  relationship?: string
  change?: string
  reason?: string
  eventCount?: number
  active?: string[]
  delayMs?: number
  travelMs?: number
  paintAttempt?: number
  screenLength?: number
}

type LivingDiagnosticGlobal = typeof globalThis & {
  __axiomLivingFlowLog?: LivingFlowDiagnostic[]
}

const MAX_DIAGNOSTICS = 500
const paintAttempts = new Map<number, number>()

function diagnosticGlobal(): LivingDiagnosticGlobal {
  return globalThis as LivingDiagnosticGlobal
}

function diagnosticSummary(entry: LivingFlowDiagnostic): string {
  return [
    `[living-flow] stage=${entry.stage}`,
    `trace=${entry.traceId}`,
    entry.key === undefined ? '' : `key=${entry.key}`,
    entry.paintAttempt === undefined ? '' : `attempt=${entry.paintAttempt}`,
    entry.route ? `route=${entry.route}` : '',
    entry.semanticRoute ? `semantic=${entry.semanticRoute}` : '',
    entry.relationship ? `relationship=${entry.relationship}/${entry.change ?? '?'}` : '',
    entry.eventCount === undefined ? '' : `events=${entry.eventCount}`,
    entry.reason ? `reason=${entry.reason}` : '',
    entry.active ? `active=[${entry.active.join(',')}]` : '',
  ].filter(Boolean).join(' ')
}

/**
 * Structured, bounded diagnostics for the one pipeline that can create a
 * visible travelling pulse. In DevTools, run:
 *   copy(window.__axiomLivingFlowLog)
 * to capture the complete correlated lifecycle without unrelated canvas logs.
 */
export function recordLivingFlowDiagnostic(
  stage: LivingFlowDiagnosticStage,
  fields: Omit<LivingFlowDiagnostic, 'timestamp' | 'elapsedMs' | 'stage'>,
): LivingFlowDiagnostic {
  const entry: LivingFlowDiagnostic = {
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(
      typeof performance === 'undefined' ? 0 : performance.now(),
    ),
    stage,
    ...fields,
  }
  const owner = diagnosticGlobal()
  const log = owner.__axiomLivingFlowLog ?? []
  log.push(entry)
  if (log.length > MAX_DIAGNOSTICS) {
    log.splice(0, log.length - MAX_DIAGNOSTICS)
  }
  owner.__axiomLivingFlowLog = log
  console.info(diagnosticSummary(entry))
  return entry
}

export function nextLivingPaintAttempt(key: number): number {
  const attempt = (paintAttempts.get(key) ?? 0) + 1
  paintAttempts.set(key, attempt)
  return attempt
}

export function activeLivingFlowDiagnostics(
  events: ReadonlyArray<{
    key: number
    traceId?: string
    src: string
    dst: string
  }>,
): string[] {
  return events.map(event =>
    `${event.key}:${event.traceId ?? 'legacy'}:${event.src}->${event.dst}`,
  )
}
