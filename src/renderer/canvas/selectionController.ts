/**
 * Every rule about what is selected on the canvas.
 *
 * There is exactly ONE authoritative set. Nothing else may add to it on the way
 * to the screen — a projection that ORs in some other notion of a "current"
 * node is how a node stays highlighted after the user has moved on, and how a
 * later drag silently picks it up and moves it too.
 *
 * The rules below are the ones every other tool on the machine follows, so they
 * need no learning:
 *
 *   plain click on a node    → that node alone
 *   modifier click on a node → toggle it, keeping the rest
 *   drag an unselected node  → that node alone, then move it
 *   drag a selected node     → keep the whole group and move all of it
 *   click empty canvas       → nothing selected
 *   lasso                    → whatever it enclosed
 *   reveal from elsewhere    → that node alone
 *
 * The first two are React Flow's, applied on pointer DOWN and arriving here as
 * ordered select changes. Axiom must reconcile them, never recompute them:
 * deriving the modifier toggle a second time in the click handler undid the
 * first one, so a modifier click appeared to do nothing while a plain click —
 * which lands in the same place however many times it is applied — looked fine.
 * The rest of the rules are Axiom's, and live here as pure functions.
 */
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

/**
 * True when the press carries a modifier meaning "add to what I already have".
 *
 * Must agree with the keys React Flow is configured to treat as multi-select,
 * since React Flow is what actually performs the toggle. This is used to tell a
 * selection-building press apart from the start of a fresh gesture.
 */
export function isAdditiveEvent(event: {
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): boolean {
  return Boolean(event.ctrlKey || event.metaKey || event.shiftKey)
}

/**
 * Beginning a drag. Grabbing something that was not part of the selection makes
 * it the selection — you are acting on that node, not on whatever you last
 * touched. Grabbing something already in a multi-selection keeps the group, so
 * dragging one member moves them all.
 *
 * Without this rule the previously dragged node stayed selected, joined the
 * next gesture's group, and was carried along by a drag the user never aimed
 * at it.
 */
export function selectionAfterDragStart(
  current: ReadonlySet<string>,
  nodeId: string,
): Set<string> {
  return current.has(nodeId) ? new Set(current) : singleNodeSelection(nodeId)
}

/**
 * Paint the authoritative set onto the projected scene.
 *
 * Takes the set and nothing else. It used to accept a second "primary" node
 * that was force-selected on top, which meant a node revealed from the search
 * bar or the agent log could never be deselected by any canvas gesture: every
 * rebuild put the highlight back. A reveal now writes the selection instead of
 * riding alongside it.
 */
export function stampSelection(nodes: Node[], selectedIds: ReadonlySet<string>): Node[] {
  return nodes.map(node => ({
    ...node,
    selected: selectedIds.has(node.id),
  }))
}

export function selectedNodeIds(nodes: Node[]): string[] {
  return nodes.filter(node => node.selected).map(node => node.id)
}
