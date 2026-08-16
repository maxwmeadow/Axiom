/**
 * The seam between the two canvases.
 *
 * The unsorted bin is a second React Flow instance, and a React Flow node drag
 * is a pointer gesture rather than an HTML5 drag - so a node dragged out of the
 * bin raises no drop event on the Floor. Rather than teach the bin how the
 * Floor's geometry works, the Floor registers one question it can answer about
 * a screen point, and the bin asks it.
 *
 * That direction matters. The Floor already owns the hit test that decides
 * which system a drop lands in; duplicating it here is how the two surfaces
 * would drift apart the first time containment rules changed.
 */

export interface FloorDropTarget {
  /** Innermost system under this screen point, or null for bare canvas. */
  systemAt: (clientX: number, clientY: number, explain?: boolean) => string | null
  /** Move a file into that system. Null unclassifies it. */
  place: (fileId: string, systemId: string | null) => void
  /** Put a file on the bare Floor at this point, belonging to no system. */
  placeLoose: (fileId: string, clientX: number, clientY: number) => void
  /** The Floor's own element, so the bin can tell "outside me" from "on it". */
  element: () => Element | null
}

let floor: FloorDropTarget | null = null

export function registerFloorDropTarget(target: FloorDropTarget): () => void {
  floor = target
  return () => {
    // Only clear if this registration is still the live one. A remount can
    // register the replacement before the old instance runs its cleanup, and
    // clearing unconditionally would leave no Floor registered at all.
    if (floor === target) floor = null
  }
}

/**
 * Would a drop here land somewhere? Lets the bin show, mid-drag, whether
 * releasing would actually place the file - so a refusal is visible before it
 * happens rather than felt afterwards as nothing happening.
 */
export function systemAtFloorPoint(clientX: number, clientY: number): string | null {
  if (!floor) return null
  const element = floor.element()
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right) return null
  if (clientY < rect.top || clientY > rect.bottom) return null
  return floor.systemAt(clientX, clientY)
}

/**
 * A node left the bin at this point. Returns true when the Floor accepted it,
 * so the bin can tell a real placement from a drag that went nowhere.
 */
export function dropOnFloorAt(fileId: string, clientX: number, clientY: number): boolean {
  const log = (stage: string, detail: Record<string, unknown> = {}) => {
    if ((window as unknown as { __axiomBinDragDebug?: boolean }).__axiomBinDragDebug !== false) {
      console.log(`[bins] drop/${stage}`, { fileId, clientX, clientY, ...detail })
    }
  }
  if (!floor) {
    log('no-floor-registered')
    return false
  }
  const element = floor.element()
  if (!element) {
    log('floor-has-no-element')
    return false
  }
  const rect = element.getBoundingClientRect()
  const overFloor = clientX >= rect.left && clientX <= rect.right
    && clientY >= rect.top && clientY <= rect.bottom
  if (!overFloor) {
    log('released-outside-floor', { rect: { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom } })
    return false
  }
  const systemId = floor.systemAt(clientX, clientY, true)
  if (!systemId) {
    // Bare Floor is a destination, not a refusal. The file leaves the bin and
    // sits where it was dropped, still belonging to no system - on the map, but
    // not yet part of the architecture.
    log('placing-loose')
    floor.placeLoose(fileId, clientX, clientY)
    return true
  }
  log('placing', { systemId })
  floor.place(fileId, systemId)
  return true
}
