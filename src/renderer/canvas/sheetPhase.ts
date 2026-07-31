import { useEffect, useRef, useState } from 'react'

/**
 * Sheet mode has to outlive its own exit.
 *
 * The first version animated entry and snapped on exit, and the reason is worth
 * writing down because it is easy to repeat: the sheet chrome lives on
 * pseudo-elements that only exist while the mode class is applied. A CSS
 * `animation` on a conditionally-present element can only ever play IN — the
 * instant the class is removed the element is gone, and there is nothing left
 * to animate out.
 *
 * So the mode is a PHASE, not a boolean. It stays applied through `leaving`,
 * long enough for the exit to play, and only then unmounts. Everything is
 * driven by transitions on a presence value rather than by keyframes, which
 * makes both directions symmetric by construction and makes an interrupted
 * switch resolve to a real value instead of snapping.
 */

export type SheetPhase = 'entering' | 'active' | 'leaving' | null

/** Must match the longest transition in the sheet chrome. */
export const SHEET_PHASE_MS = 460

export interface SheetPhaseState {
  phase: SheetPhase
  /** The sheet whose chrome is on screen — kept during `leaving`. */
  sheetId: string | null
}

export const IDLE_PHASE: SheetPhaseState = { phase: null, sheetId: null }

/**
 * The next phase for an observed sheet id.
 *
 * Pure, so the ordering rules are testable without timers:
 *   - arriving at a sheet from nothing begins `entering`
 *   - switching directly between two sheets re-enters rather than leaving,
 *     because the board never goes away and a fade-out/fade-in would read as
 *     a flicker
 *   - dropping to no sheet begins `leaving` and KEEPS the id, so the chrome
 *     it belongs to is still there to animate
 */
export function nextSheetPhase(
  current: SheetPhaseState,
  activeSheetId: string | null,
): SheetPhaseState {
  if (activeSheetId) {
    if (current.sheetId === activeSheetId && current.phase === 'active') return current
    if (current.sheetId === activeSheetId && current.phase === 'entering') return current
    return { phase: 'entering', sheetId: activeSheetId }
  }

  // Already gone, or already going.
  if (current.phase === null) return current
  if (current.phase === 'leaving') return current
  return { phase: 'leaving', sheetId: current.sheetId }
}

/** The phase that follows `entering` once a frame has been painted at 0. */
export function settledPhase(current: SheetPhaseState): SheetPhaseState {
  return current.phase === 'entering'
    ? { phase: 'active', sheetId: current.sheetId }
    : current
}

/** The phase that follows `leaving` once the exit has played. */
export function clearedPhase(current: SheetPhaseState): SheetPhaseState {
  return current.phase === 'leaving' ? IDLE_PHASE : current
}

/**
 * Tracks sheet mode as a phase.
 *
 * `entering` exists for exactly one frame so the browser paints the chrome at
 * zero presence before it transitions to one. Without that frame the element
 * mounts already at its final value and there is nothing to transition from —
 * which is the same bug as the missing exit, from the other end.
 */
export function useSheetPhase(activeSheetId: string | null): SheetPhaseState {
  const [state, setState] = useState<SheetPhaseState>(IDLE_PHASE)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setState(current => nextSheetPhase(current, activeSheetId))
  }, [activeSheetId])

  useEffect(() => {
    if (state.phase === 'entering') {
      const frame = requestAnimationFrame(() => setState(settledPhase))
      return () => cancelAnimationFrame(frame)
    }
    if (state.phase === 'leaving') {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setState(clearedPhase), SHEET_PHASE_MS)
      return () => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
      }
    }
    return undefined
  }, [state.phase, state.sheetId])

  return state
}
