import type { Node, NodeChange } from '@xyflow/react'

export function singleNodeSelection(nodeId: string): Set<string> {
  return new Set([nodeId])
}

export function emptySelection(): Set<string> {
  return new Set()
}

/** Apply React Flow's ordered select changes to Axiom's authoritative ID set. */
export function selectionAfterNodeChanges(
  current: ReadonlySet<string>,
  changes: NodeChange[],
): Set<string> {
  const next = new Set(current)
  for (const change of changes) {
    if (change.type !== 'select') continue
    if (change.selected) next.add(change.id)
    else next.delete(change.id)
  }
  return next
}

export function stampSelection(
  nodes: Node[],
  selectedIds: ReadonlySet<string>,
  primaryNodeId: string | null = null,
): Node[] {
  return nodes.map(node => ({
    ...node,
    selected: selectedIds.has(node.id) || node.id === primaryNodeId,
  }))
}

export function selectedNodeIds(nodes: Node[]): string[] {
  return nodes.filter(node => node.selected).map(node => node.id)
}
