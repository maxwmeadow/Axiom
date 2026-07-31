/**
 * Sheet transitions.
 *
 * Switching between the Floor and a sheet is the moment the idea lands: you
 * watch the same architecture rearrange itself into the alternative you drew,
 * and rearrange back when you leave. A cut between two static layouts throws
 * that away — you cannot tell what moved, what the sheet added, what it took
 * out, or that it is even the same map.
 *
 * One rule decides everything:
 *
 *   A NODE FADES WHEN IT EXISTS IN ONE WORLD AND NOT THE OTHER.
 *   A NODE GLIDES WHEN IT EXISTS IN BOTH.
 *
 * So:
 *
 *   MOVES     live in both worlds, so they glide and never fade. Fading one
 *             would say "created" or "destroyed", which is a lie about a file
 *             that exists either way.
 *   ADDITIONS live only on the sheet: they appear on entry, depart on exit.
 *   REMOVALS  live only on the Floor: they depart on entry, appear on exit —
 *             the same vocabulary, inverted, because a removal is an addition
 *             seen from the other side.
 *
 * Live nodes the sheet says nothing about do neither. They are already in the
 * right place, and animating them would imply an opinion the sheet never had.
 */

export type SheetTransitionDirection = 'enter' | 'leave'

/** Long enough to read as one coordinated rearrangement, short enough to feel instant. */
export const SHEET_MOVE_MS = 520
/** Presence resolves faster, so movement reads as the primary event. */
export const SHEET_FADE_MS = 320
/**
 * Things arriving wait for the rearrangement to be underway, so the eye follows
 * movement first. Things leaving go immediately, so they are out of the way
 * before the map settles.
 */
export const SHEET_APPEAR_DELAY_MS = 160

export interface SheetTransitionPlan {
  direction: SheetTransitionDirection
  /** Node IDs gliding between two positions. */
  movingIds: string[]
  /** Node IDs coming into this world. */
  appearingIds: string[]
  /** Node IDs leaving this world. */
  departingIds: string[]
  /** Total time before the transition is settled. */
  durationMs: number
}

export interface SheetTransitionInputs {
  direction: SheetTransitionDirection
  /** Live nodes the sheet repositions. */
  movedIds: readonly string[]
  /** Elements that exist only on the sheet. */
  sheetOnlyIds: readonly string[]
  /** Live nodes the sheet proposes removing — they exist only on the Floor. */
  removedIds?: readonly string[]
}

export function planSheetTransition(inputs: SheetTransitionInputs): SheetTransitionPlan {
  const movingIds = [...new Set(inputs.movedIds)]
  const moving = new Set(movingIds)
  const exclusive = (ids: readonly string[]) =>
    [...new Set(ids)].filter(id => !moving.has(id))

  const additions = exclusive(inputs.sheetOnlyIds)
  const removals = exclusive(inputs.removedIds ?? [])

  // Entering the sheet, its additions arrive and its removals go. Leaving, the
  // Floor takes its removed nodes back and the additions go with the sheet.
  const appearingIds = inputs.direction === 'enter' ? additions : removals
  const departingIds = inputs.direction === 'enter' ? removals : additions

  const moveTime = movingIds.length > 0 ? SHEET_MOVE_MS : 0
  const appearTime = appearingIds.length > 0 ? SHEET_APPEAR_DELAY_MS + SHEET_FADE_MS : 0
  const departTime = departingIds.length > 0 ? SHEET_FADE_MS : 0

  return {
    direction: inputs.direction,
    movingIds,
    appearingIds,
    departingIds,
    durationMs: Math.max(moveTime, appearTime, departTime),
  }
}

interface TransitionableNode {
  id: string
  style?: Record<string, unknown>
  data?: Record<string, unknown>
}

/**
 * Stamps the transition onto nodes as a projection — never as canvas state, so
 * a layout, zoom or selection pass cannot strand a node mid-flight, and ending
 * the transition restores the untouched nodes.
 *
 * `progress` runs 0 → 1. Opacity is driven from it directly rather than from a
 * CSS keyframe, so an interrupted transition (switching sheets mid-flight)
 * resolves to a real value instead of snapping to wherever the animation
 * happened to be.
 */
export function applySheetTransition<T extends TransitionableNode>(
  nodes: T[],
  plan: SheetTransitionPlan | null,
  progress: number,
): T[] {
  if (!plan) return nodes

  const moving = new Set(plan.movingIds)
  const appearing = new Set(plan.appearingIds)
  const departing = new Set(plan.departingIds)
  if (moving.size === 0 && appearing.size === 0 && departing.size === 0) return nodes

  const clamped = Math.max(0, Math.min(1, progress))

  let touched = false
  const projected = nodes.map(node => {
    if (moving.has(node.id)) {
      touched = true
      return {
        ...node,
        style: {
          ...node.style,
          // Position is driven by React Flow; only the easing belongs here.
          transition: `transform ${SHEET_MOVE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        },
        data: { ...node.data, sheetMoving: true },
      }
    }

    const isAppearing = appearing.has(node.id)
    if (!isAppearing && !departing.has(node.id)) return node

    touched = true
    const opacity = isAppearing ? clamped : 1 - clamped
    return {
      ...node,
      style: {
        ...node.style,
        opacity,
        transition: `opacity ${SHEET_FADE_MS}ms ease-out ${
          isAppearing ? SHEET_APPEAR_DELAY_MS : 0}ms`,
        // A half-faded node must not swallow clicks meant for the map.
        pointerEvents: opacity < 0.5 ? ('none' as const) : undefined,
      },
      data: { ...node.data, sheetDeparting: !isAppearing || undefined },
    }
  })

  return touched ? projected : nodes
}

/**
 * Merges a new transition over one already running.
 *
 * Switching sheets mid-flight is normal, and the previous plan's arrivals must
 * not be abandoned part-way: anything it was bringing in that the new plan does
 * not mention still has to be taken back out, or it is stranded half-visible
 * forever.
 */
export function supersedeTransition(
  previous: SheetTransitionPlan | null,
  next: SheetTransitionPlan,
): SheetTransitionPlan {
  if (!previous) return next

  const accountedFor = new Set([
    ...next.movingIds, ...next.appearingIds, ...next.departingIds,
  ])
  const stranded = previous.appearingIds.filter(id => !accountedFor.has(id))
  if (stranded.length === 0) return next

  return {
    ...next,
    departingIds: [...next.departingIds, ...stranded],
    durationMs: Math.max(next.durationMs, SHEET_FADE_MS),
  }
}
