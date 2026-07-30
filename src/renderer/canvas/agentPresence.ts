import type { Node } from '@xyflow/react'
import type { DeltaWorkSession } from '../../shared/types'
import type { AgentPresence } from './sceneTypes'

function presenceFor(session: DeltaWorkSession): AgentPresence {
  return {
    id: session.id,
    agent: session.agent?.trim() || 'agent',
    goal: session.goal,
  }
}

/**
 * Projects durable work-session scope onto the rendered scene. Presence is
 * deliberately derived rather than written into graph state, so switching
 * sheets, zooming, or rebuilding layout cannot leave stale badges behind.
 */
export function stampAgentPresence(
  nodes: Node[],
  sessions: DeltaWorkSession[],
): Node[] {
  if (sessions.length === 0) return nodes
  const byNode = new Map<string, AgentPresence[]>()
  for (const session of sessions) {
    if (session.endedAt !== 0) continue
    const presence = presenceFor(session)
    for (const id of new Set([
      ...(session.focusSystemIds ?? []),
      ...(session.focusFileIds ?? []),
    ])) {
      const existing = byNode.get(id)
      if (existing) existing.push(presence)
      else byNode.set(id, [presence])
    }
  }
  if (byNode.size === 0) return nodes
  return nodes.map(node => {
    const agentPresence = byNode.get(node.id)
    return agentPresence
      ? { ...node, data: { ...node.data, agentPresence } }
      : node
  })
}
