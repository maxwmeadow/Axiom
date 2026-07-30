import type { Node } from '@xyflow/react'

export interface CanvasNodeChangeLike {
  type: string
  id?: string
}

export interface SceneIntegrity {
  valid: boolean
  reason: 'empty' | 'canonical-mismatch' | 'no-root' | 'no-visible-root' | 'invalid-geometry' | null
  nodeCount: number
  rootCount: number
  visibleRootCount: number
  invalidNodeIds: string[]
}

const STRUCTURAL_CHANGE_TYPES = new Set(['add', 'remove', 'replace'])

function finiteDimension(node: Node, axis: 'width' | 'height'): boolean {
  // Match React Flow's nodeHasDimensions contract. CSS style dimensions size
  // the DOM but do not make a freshly-adopted node initialized; initialWidth /
  // initialHeight keep it visible until (and unless) measurement arrives.
  const initialAxis = axis === 'width' ? 'initialWidth' : 'initialHeight'
  const value = Number(node.measured?.[axis] ?? node[axis] ?? node[initialAxis] ?? 0)
  return Number.isFinite(value) && value > 0
}

function visiblyProjected(node: Node): boolean {
  if (node.hidden) return false
  const opacity = Number(node.style?.opacity ?? 1)
  return !Number.isFinite(opacity) || opacity > 0.1
}

/**
 * Canonical Floor structure belongs to Axiom's graph/layout stores. React Flow
 * may report interaction changes, but its local add/remove/replace operations
 * must never mutate that canonical projection.
 */
export function partitionCanvasNodeChanges<T extends CanvasNodeChangeLike>(
  changes: readonly T[],
): { interaction: T[]; rejectedStructural: T[] } {
  const interaction: T[] = []
  const rejectedStructural: T[] = []
  for (const change of changes) {
    if (STRUCTURAL_CHANGE_TYPES.has(change.type)) rejectedStructural.push(change)
    else interaction.push(change)
  }
  return { interaction, rejectedStructural }
}

/**
 * A populated canonical graph must always yield finite geometry and at least
 * one visible root. Descendants may be hidden by semantic zoom; roots may not.
 */
export function inspectFloorScene(
  nodes: readonly Node[],
  canonicalNodeCount: number,
  canonicalNodeIds?: ReadonlySet<string>,
): SceneIntegrity {
  if (canonicalNodeCount <= 0) {
    return {
      valid: true,
      reason: null,
      nodeCount: nodes.length,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }
  if (nodes.length === 0) {
    return {
      valid: false,
      reason: 'empty',
      nodeCount: 0,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }

  const nodeIds = new Set(nodes.map(node => node.id))
  if (canonicalNodeIds && (
    nodeIds.size !== canonicalNodeIds.size ||
    [...canonicalNodeIds].some(id => !nodeIds.has(id))
  )) {
    return {
      valid: false,
      reason: 'canonical-mismatch',
      nodeCount: nodes.length,
      rootCount: 0,
      visibleRootCount: 0,
      invalidNodeIds: [],
    }
  }
  const roots = nodes.filter(node => !node.parentId || !nodeIds.has(node.parentId))
  const visibleRoots = roots.filter(visiblyProjected)
  const invalidNodeIds = nodes
    .filter(node =>
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y) ||
      !finiteDimension(node, 'width') ||
      !finiteDimension(node, 'height'),
    )
    .map(node => node.id)

  const reason = roots.length === 0
    ? 'no-root'
    : visibleRoots.length === 0
      ? 'no-visible-root'
      : invalidNodeIds.length > 0
        ? 'invalid-geometry'
        : null
  return {
    valid: reason === null,
    reason,
    nodeCount: nodes.length,
    rootCount: roots.length,
    visibleRootCount: visibleRoots.length,
    invalidNodeIds,
  }
}
