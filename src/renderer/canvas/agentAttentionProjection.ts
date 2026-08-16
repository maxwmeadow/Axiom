import type { Node } from '@xyflow/react'
import type { AgentAttention } from './agentActionVisual.ts'
import { livingVisibilityIndex, type LivingVisibilityOptions } from './livingVisibility.ts'

/**
 * Projects agent attention onto canvas nodes.
 *
 * Kept separate from the signal logic in `agentActionVisual.ts` so that module
 * stays free of canvas concerns and testable on plain objects.
 *
 * Like every other live signal in Axiom this is a PROJECTION, never canvas
 * state: layout, selection, zoom and sheet passes cannot overwrite an in-flight
 * attention glow, and when the signal expires the untouched nodes return.
 */

interface AttentionNode {
  id: string
  data?: Record<string, unknown>
}

export function applyAgentAttention<T extends AttentionNode>(
  nodes: T[],
  attention: Record<string, AgentAttention>,
): T[] {
  if (Object.keys(attention).length === 0) return nodes
  let touched = false
  const projected = nodes.map(node => {
    const signal = attention[node.id]
    if (!signal) return node
    touched = true
    return {
      ...node,
      data: {
        ...node.data,
        agentReading: true,
        agentReadingLabel: signal.summary,
        agentReadingKey: signal.key,
      },
    }
  })
  return touched ? projected : nodes
}

/**
 * Resolves attention to the nearest VISIBLE ancestor, the same way live
 * relationship flows do. An agent reading a file zoomed out of view should
 * still register on the system that contains it - otherwise sweeping a large
 * codebase looks like nothing is happening at all.
 */
export function surfaceAgentAttention(
  nodes: Node[],
  attention: Record<string, AgentAttention>,
  options?: LivingVisibilityOptions,
): Record<string, AgentAttention> {
  if (Object.keys(attention).length === 0) return attention
  const index = livingVisibilityIndex(nodes, options)
  const surfaced: Record<string, AgentAttention> = {}
  for (const [id, signal] of Object.entries(attention)) {
    const visible = index.visibleNodeId(id) ?? id
    // The newest signal wins a shared ancestor, so a sweep across many hidden
    // files reads as one steady glow on their container.
    const existing = surfaced[visible]
    if (!existing || signal.key > existing.key) surfaced[visible] = signal
  }
  return surfaced
}
