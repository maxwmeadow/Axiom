import type { Point, Rect } from './frameGeometry.ts'

/**
 * Case 3 of the drop contract: the frame you aimed at has no free slot, at any
 * position, for the node you are dropping.
 *
 * The response is to compress the frame's INTERIOR — every child gets uniformly
 * smaller, together, in place. Nothing is rearranged, reordered or repacked,
 * because compression is a single multiplication applied to the coordinate
 * space the children already live in. Their relative arrangement is preserved
 * by construction rather than by careful bookkeeping, and it costs one database
 * row: the container's `interiorScale`.
 *
 * Crucially the container's OWN geometry does not participate. Its width,
 * height, position, chrome and presentation scale are not expressed in terms of
 * `interiorScale`, so none of them can react to a compression. That is why this
 * is a lever and not a cascade — nothing outside the frame is disturbed.
 */

/**
 * Children are stored in the frame's content space, whose size on screen is
 * `interiorScale` times the frame's own. Compressing therefore does not move
 * any child; it enlarges the content box the children are measured against.
 */
export function contentBoxAtCompression(ownContent: Rect, interiorScale: number): Rect {
  const scale = interiorScale > 0 ? interiorScale : 1
  return {
    x: ownContent.x / scale,
    y: ownContent.y / scale,
    width: ownContent.width / scale,
    height: ownContent.height / scale,
  }
}

/**
 * A child may not be compressed past the point where it stops being readable —
 * below that you are destroying information rather than saving space. Expressed
 * as a bound on a child's resulting WORLD scale so nested compressions compound
 * correctly: a frame inside an already-compressed frame gets less headroom, not
 * a fresh budget.
 *
 * The value is the world scale at which a leaf still reaches its detail reveal
 * (`DETAIL_REVEAL_EFFECTIVE_ZOOM`) about two comfortable wheel-steps in. Past
 * it, reading a file would mean zooming so far that the frame it lives in has
 * left the screen.
 */
export const INTERIOR_LEGIBILITY_MIN_WORLD_SCALE = 0.25

/**
 * Compression is quantized: if a drop needs any shrink at all, it takes at
 * least this much. Without it every drop nudges the whole interior by a few
 * pixels forever, which reads as the canvas being unstable. With it, a shrink
 * is a rare and explicable event and the next several drops need none.
 */
export const INTERIOR_COMPRESSION_STEP = 0.12

/** Compression factors below this are treated as no change at all. */
const NEGLIGIBLE = 0.001

export interface InteriorCompressionInput {
  /** Content box in the container's OWN canonical space. */
  ownContent: Rect
  /** Existing children, in the container's content space. Never modified. */
  occupied: readonly Rect[]
  /** The newcomer's size in the container's content space. */
  incoming: { width: number; height: number }
  /** Where the drop was aimed, in the container's content space. */
  origin: Point
  /** The container's current interior scale. */
  interiorScale: number
  /**
   * The smallest world scale any resident (or the newcomer) would have if
   * nothing were compressed. The legibility floor is applied against this, so
   * the deepest, smallest child is what limits the compression.
   */
  minChildWorldScale: number
  /** Clearance required between the newcomer and its neighbours. */
  gap: number
}

export interface InteriorCompressionPlan {
  /** The container's new absolute interior scale. */
  interiorScale: number
  /** What was applied this time. 1 means the interior was left alone. */
  factor: number
  /** Where the newcomer lands, in the container's content space. */
  placement: Point
  /**
   * True when the legibility floor stopped the compression before a slot
   * opened. The newcomer is still placed and the frame visibly overflows —
   * which is honest, because the frame really is over-full.
   */
  atFloor: boolean
}

/**
 * Finds a collision-free slot in `destination`, or null if there is none.
 * Returns the TRANSLATION to apply to `incoming`, not an absolute point.
 */
export type SlotFinder = (
  incoming: Rect,
  destination: Rect,
  occupied: readonly Rect[],
  gap: number,
) => Point | null

/**
 * Smallest compression that opens a slot for the newcomer, or the legibility
 * floor if none does.
 *
 * `findSlot` is injected rather than imported so this stays a pure statement
 * about compression and the drop path keeps a single placement implementation.
 */
export function planInteriorCompression(
  input: InteriorCompressionInput,
  findSlot: SlotFinder,
): InteriorCompressionPlan {
  const current = input.interiorScale > 0 ? input.interiorScale : 1
  const minChildWorldScale = input.minChildWorldScale > 0 ? input.minChildWorldScale : 1

  const slotAt = (factor: number): Point | null => {
    const box = contentBoxAtCompression(input.ownContent, current * factor)
    const offset = findSlot(
      { x: input.origin.x, y: input.origin.y, width: input.incoming.width, height: input.incoming.height },
      box,
      input.occupied,
      input.gap,
    )
    // The finder answers with a translation from the drop point, so the landing
    // position is the drop point plus that translation.
    return offset && { x: input.origin.x + offset.x, y: input.origin.y + offset.y }
  }

  const uncompressed = slotAt(1)
  if (uncompressed) {
    return { interiorScale: current, factor: 1, placement: uncompressed, atFloor: false }
  }

  // How far compression may go before the smallest child stops being readable.
  // Never above 1: this lever only ever shrinks an interior.
  const floorFactor = Math.min(1, INTERIOR_LEGIBILITY_MIN_WORLD_SCALE / minChildWorldScale)
  if (floorFactor >= 1 - NEGLIGIBLE) {
    // Already at or past the floor — compressing further would be illegible.
    return {
      interiorScale: current,
      factor: 1,
      placement: { x: input.origin.x, y: input.origin.y },
      atFloor: true,
    }
  }

  // A larger content box strictly contains a smaller one, so "a slot exists" is
  // monotone in the compression factor. Binary search for the LARGEST factor
  // (least compression) that still admits the newcomer.
  let low = floorFactor   // known to compress most; may or may not fit
  let high = 1            // known not to fit
  let bestFactor: number | null = slotAt(floorFactor) ? floorFactor : null
  if (bestFactor !== null) {
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2
      if (slotAt(mid)) {
        bestFactor = mid
        low = mid
      } else {
        high = mid
      }
    }
  }

  if (bestFactor === null) {
    // Even fully compressed there is no room. Place the newcomer at the floor
    // and let the frame overflow rather than lying about how full it is.
    const box = contentBoxAtCompression(input.ownContent, current * floorFactor)
    return {
      interiorScale: current * floorFactor,
      factor: floorFactor,
      placement: { x: Math.max(box.x, input.origin.x), y: Math.max(box.y, input.origin.y) },
      atFloor: true,
    }
  }

  // Quantize: take at least one full step so the next few drops need none.
  // Never below the floor, and never less compression than actually fits — the
  // search is monotone, so a slot at `bestFactor` is still a slot here.
  const factor = Math.max(floorFactor, Math.min(bestFactor, 1 - INTERIOR_COMPRESSION_STEP))
  const placement = slotAt(factor) ?? { x: input.origin.x, y: input.origin.y }
  return {
    interiorScale: current * factor,
    factor,
    placement,
    atFloor: factor <= floorFactor + NEGLIGIBLE,
  }
}
