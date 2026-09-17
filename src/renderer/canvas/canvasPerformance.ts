/**
 * Above this size, painting a temporary all-root file scene costs more than it
 * communicates. Large fresh indexes wait for classification to produce stable
 * containment (or for indexing to finish) before materializing the Floor.
 */
export const LARGE_SCENE_NODE_COUNT = 150

/**
 * Threshold at which React Flow starts culling off-screen DOM nodes during
 * pan/zoom. At 40+ nodes, off-screen DOM savings outweigh the bounding-box
 * calculation overhead. Kept distinct from LARGE_SCENE_NODE_COUNT (150).
 */
export const VIEWPORT_CULLING_NODE_COUNT = 40


/** Keep individual settle choreography for ordinary incremental changes only. */
export function shouldAnimateIndividualClassification(changeCount: number): boolean {
  return changeCount <= LARGE_SCENE_NODE_COUNT
}

export interface CanvasMaterializationState {
  isIndexing: boolean
  fileCount: number
  classifiedFileCount: number
  systemCount: number
  floorLayoutCount: number
}

export function shouldDeferCanvasMaterialization({
  isIndexing,
  fileCount,
  classifiedFileCount,
  systemCount,
  floorLayoutCount,
}: CanvasMaterializationState): boolean {
  return isIndexing &&
    floorLayoutCount === 0 &&
    fileCount > LARGE_SCENE_NODE_COUNT &&
    (classifiedFileCount < fileCount || systemCount === 0)
}
