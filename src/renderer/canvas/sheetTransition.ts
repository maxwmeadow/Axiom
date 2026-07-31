/**
 * Sheet transitions.
 *
 * Switching between the Floor and a sheet is the moment the idea lands: you
 * see the same architecture rearrange itself into the alternative you drew,
 * and rearrange back when you leave. A cut between two static layouts throws
 * that away — you cannot tell what moved, or that it is even the same map.
 *
 * So the transition carries two distinct signals, and they must not be
 * confused with each other:
 *
 *   MOVEMENT — live nodes the sheet has an opinion about glide between their
 *   Floor position and their sheet position. They never fade, because they
 *   exist in both worlds. Fading them would say "this is being created or
 *   destroyed", which is a lie.
 *
 *   PRESENCE — sheet-only additions fade in on entry and out on exit, because
 *   they genuinely do not exist on the Floor.
 *
 * Live nodes the sheet says nothing about do neither. They are already in the
 * right place, and animating them would imply the sheet had an opinion it does
 * not have.
 */

export type SheetTransitionDirection = 'enter' | 'leave'

/** Long enough to read as one coordinated rearrangement, short enough to feel instant. */
export const SHEET_MOVE_MS = 520
/** Additions resolve slightly faster, so movement reads as the primary event. */
export const SHEET_FADE_MS = 320
/**
 * Entering, additions appear only once the rearrangement is underway, so the
 * eye follows the movement first. Leaving, they clear out immediately so they
 * are gone before the map settles back.
 */
export const SHEET_FADE_DELAY_MS = 160

export interface SheetTransitionPlan {
  direction: SheetTransitionDirection
  /** Node IDs gliding between two positions. */
  movingIds: string[]
  /** Node IDs fading in or out. */
  fadingIds: string[]
  /** Total time before the transition is settled. */
  durationMs: number
}

export interface SheetTransitionInputs {
  direction: SheetTransitionDirection
  /** Live nodes the sheet repositions. */
  movedIds: string[]
  /** Elements that exist only on the sheet. */
  sheetOnlyIds: string[]
}

export function planSheetTransition(inputs: SheetTransitionInputs): SheetTransitionPlan {
  const movingIds = [...new Set(inputs.movedIds)]
  const fadingIds = [...new Set(inputs.sheetOnlyIds)].filter(id => !movingIds.includes(id))

  const moveTime = movingIds.length > 0 ? SHEET_MOVE_MS : 0
  const fadeTime = fadingIds.length > 0 ? SHEET_FADE_DELAY_MS + SHEET_FADE_MS : 0

  return {
    direction: inputs.direction,
    movingIds,
    fadingIds,
    durationMs: Math.max(moveTime, fadeTime),
  }
}

interface TransitionableNode {
  id: string
  style?: Record<string, unknown>
  data?: Record<string, unknown>
}

/**
 * Stamps the transition onto nodes as a projection — never as canvas state,
 * so a layout, zoom or selection pass cannot strand a node mid-flight and
 * ending the transition restores the untouched nodes.
 *
 * `progress` is 0 at the start and 1 once settled. Fading nodes are driven
 * from it directly rather than from a CSS keyframe, so an interrupted
 * transition (switching sheets mid-flight) resolves to a real opacity instead
 * of snapping to whatever the animation happened to be at.
 */
export function applySheetTransition<T extends TransitionableNode>(
  nodes: T[],
  plan: SheetTransitionPlan | null,
  progress: number,
): T[] {
  if (!plan) return nodes

  const moving = new Set(plan.movingIds)
  const fading = new Set(plan.fadingIds)
  if (moving.size === 0 && fading.size === 0) return nodes

  const clamped = Math.max(0, Math.min(1, progress))
  // Entering, additions arrive; leaving, they depart.
  const fadeOpacity = plan.direction === 'enter' ? clamped : 1 - clamped

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
    if (fading.has(node.id)) {
      touched = true
      return {
        ...node,
        style: {
          ...node.style,
          opacity: fadeOpacity,
          transition: `opacity ${SHEET_FADE_MS}ms ease-out ${
            plan.direction === 'enter' ? SHEET_FADE_DELAY_MS : 0}ms`,
          // A half-faded addition must not swallow clicks meant for the map.
          pointerEvents: fadeOpacity < 0.5 ? ('none' as const) : undefined,
        },
      }
    }
    return node
  })

  return touched ? projected : nodes
}

/**
 * Merges a new transition over one already running.
 *
 * Switching sheets mid-flight is normal, and the old plan's fading nodes must
 * not be abandoned part-way: anything the previous plan was showing that the
 * new one does not mention still needs to be taken out.
 */
export function supersedeTransition(
  previous: SheetTransitionPlan | null,
  next: SheetTransitionPlan,
): SheetTransitionPlan {
  if (!previous) return next
  const orphanedFades = previous.fadingIds.filter(
    id => !next.fadingIds.includes(id) && !next.movingIds.includes(id),
  )
  if (orphanedFades.length === 0) return next
  return {
    ...next,
    fadingIds: [...next.fadingIds, ...orphanedFades],
    durationMs: Math.max(next.durationMs, SHEET_FADE_MS),
  }
}
