import type { AgentAction, AgentActionKind } from '../../shared/types.ts'

/**
 * Who is allowed to animate what.
 *
 * Axiom now has two live streams arriving at the canvas at the same time:
 *
 *   1. The SEMANTIC stream — `graph:patch`, `call:trace`, `data:flow`,
 *      `runtime:*`, `planned:upserted`. This is consequence: something in the
 *      model actually changed, or a real path was resolved.
 *   2. The ACTION stream — `agent:action`. This is activity: what an agent did,
 *      including reads that change nothing.
 *
 * They overlap almost completely. An agent calling `edit_systems` produces an
 * action AND a `system:upserted` patch. `get_call_path` produces an action AND
 * a `call:trace`. If both streams animated, every agent write and every trace
 * would fire twice — two pulses, two flows, doubled timing, and a canvas that
 * looks broken.
 *
 * THE RULE: one consequence, one animation.
 *
 *   The semantic stream OWNS animation. It is closer to the truth (it fires
 *   whether the change came from an agent, from you, or from git) and it
 *   already carries the geometry and choreography.
 *
 *   The action stream OWNS attribution and the log. Its only original visual
 *   is the read/attention signal, because a read produces no consequence and
 *   therefore no semantic broadcast — nothing else can show it.
 *
 * Adding a new action kind means answering one question: does a broadcast
 * already exist for its consequence? If yes, it must not animate here.
 */

/** What already animates each kind, and therefore why the action stream must not. */
const COVERED_BY: Record<AgentActionKind, string | null> = {
  // Nothing changes on a read, so nothing else can possibly show it.
  read: null,
  trace: 'call:trace / data:flow',
  write: 'graph:patch (system:upserted, file:assigned, infra:*)',
  plan: 'graph:patch (planned:upserted, planned:edge)',
  debug: 'runtime:* (watch, call, return, exception, inject)',
  narrate: 'work:session',
}

/**
 * True only when the action stream is the sole source of this signal.
 * Everything else defers to the semantic broadcast that already animates it.
 */
export function actionOwnsAnimation(kind: AgentActionKind): boolean {
  return COVERED_BY[kind] === null
}

/** Why a kind does not animate here — used by tests and diagnostics. */
export function animationOwner(kind: AgentActionKind): string {
  return COVERED_BY[kind] ?? 'agent:action'
}

/** A transient "the agent is looking here" signal. */
export interface AgentAttention {
  targets: string[]
  tool: string
  summary: string
  key: number
}

/**
 * Projects an action into an attention signal, or null when the semantic
 * stream is already showing it.
 *
 * A failed action never glows: the agent looked and got nothing, and lighting
 * up nodes it never actually read would be a lie.
 */
export function agentAttentionFor(
  action: AgentAction,
  key: number,
): AgentAttention | null {
  if (!actionOwnsAnimation(action.kind)) return null
  if (action.status === 'error') return null
  if (!action.targets || action.targets.length === 0) return null
  return {
    targets: action.targets,
    tool: action.tool,
    summary: action.summary,
    key,
  }
}

/**
 * Merges a new attention signal into the active set, keyed by node.
 *
 * An agent reading the same region repeatedly should deepen one signal rather
 * than stack several — the canvas must never accumulate overlapping glows on
 * one node.
 */
export function mergeAttention(
  current: Record<string, AgentAttention>,
  next: AgentAttention | null,
): Record<string, AgentAttention> {
  if (!next) return current
  const merged = { ...current }
  for (const target of next.targets) {
    merged[target] = next
  }
  return merged
}

/** Drops an expired signal, but only if a newer one has not replaced it. */
export function expireAttention(
  current: Record<string, AgentAttention>,
  key: number,
): Record<string, AgentAttention> {
  const remaining: Record<string, AgentAttention> = {}
  let changed = false
  for (const [id, signal] of Object.entries(current)) {
    if (signal.key === key) {
      changed = true
      continue
    }
    remaining[id] = signal
  }
  return changed ? remaining : current
}
