import type { FrameGeometry } from './frameGeometry.ts'

export interface FramePlacementCandidate {
  id: string
  parentId: string | null
  /**
   * Persisted geometry must be registered before other authored positions,
   * and every authored position must be registered before an incoming node is
   * packed into the remaining space.
   */
  placementPriority: 0 | 1 | 2
}

export function canPersistGeneratedFrame(
  nodeType: 'system' | 'file' | 'infra',
  semanticParentId: string | null,
): boolean {
  return nodeType !== 'file' || semanticParentId !== null
}

/**
 * Produce a deterministic placement order without relying on API/database
 * insertion order. This is essential for incremental indexing: an incoming
 * node must see every persisted sibling as occupied even when that sibling
 * appears later in the semantic snapshot.
 */
export function orderFramePlacementCandidates<T extends FramePlacementCandidate>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const leftParent = left.parentId ?? ''
    const rightParent = right.parentId ?? ''
    return leftParent.localeCompare(rightParent) ||
      left.placementPriority - right.placementPriority ||
      left.id.localeCompare(right.id)
  })
}

/**
 * Containers keep their authored dimensions as a minimum, but grow when a
 * newly indexed child would otherwise be clipped or stacked outside them.
 * Existing children never cause a persisted frame to shrink or move.
 */
export function growFrameToContainChildren(
  frame: FrameGeometry,
  children: readonly FrameGeometry[],
  padding: number,
): FrameGeometry {
  // Children are authored in the frame's CONTENT space; the frame's own width
  // and height are in its own. A compressed interior genuinely occupies less of
  // the frame, so the child extents convert before they are compared.
  const interior = frame.interiorScale > 0 ? frame.interiorScale : 1
  let right = 0
  let bottom = 0
  for (const child of children) {
    right = Math.max(right, (child.x + child.width * child.scale) * interior)
    bottom = Math.max(bottom, (child.y + child.height * child.scale) * interior)
  }
  return {
    ...frame,
    width: Math.max(frame.width, right + padding),
    height: Math.max(frame.height, bottom + padding),
  }
}
