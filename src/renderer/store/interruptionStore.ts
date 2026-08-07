// The one queue every attention-seeking surface goes through.
//
// Before this, each banner owned its own visibility and decided independently
// when to appear. Nothing could rank them, nothing could tell you how many were
// waiting, and two of them rendered at the same coordinates. Routing everything
// through one store means the ordering rules in shared/interruptions.ts are the
// only ordering rules, and adding a surface cannot reintroduce a collision.
import { create } from 'zustand'
import type { Interruption, InterruptionAction } from '../../shared/interruptions.ts'

/** How long a plain confirmation stays on screen before removing itself. */
const NOTICE_TTL_MS = 4000

interface InterruptionState {
  items: Interruption[]
  /**
   * Add or replace by id. Replacement is the point: a retry that fails ten
   * times is one interruption, and a condition that re-fires should refresh
   * its entry rather than stack duplicates.
   */
  raise: (item: Interruption) => void
  /** The user set it aside. */
  dismiss: (id: string) => void
  /**
   * The underlying condition resolved on its own — an agent withdrew a request,
   * a failed fetch finally succeeded. Distinct from dismiss so callers do not
   * have to pretend the user acted.
   */
  resolve: (id: string) => void
  /** Drop everything. Used when switching projects: a new workspace inherits nothing. */
  clear: () => void
}

// Each expiring entry owns its own removal timer.
//
// The lane used to schedule one timer at the soonest expiry and re-read on
// fire. That looked economical and was wrong: firing did not change `items`,
// so the effect never re-armed and only the FIRST of several notices ever
// expired. Per-entry timers cannot chain-fail, and they keep the store — not
// the component — the authority on what is still live.
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Removing an id that is not present must return the SAME state object.
 *
 * Callers resolve unconditionally — "whatever I might have raised, it no longer
 * applies" is the honest way to write those effects, and they run on every
 * render pass. Rebuilding `items` with filter() each time produced a new array
 * even when nothing was removed, so zustand notified every subscriber. During
 * mount that extra render lands inside React Flow's fitView window and shifts
 * the camera a few pixels — which is how a "no-op" cleanup call ended up
 * changing what the canvas looked like.
 */
function removeById(state: { items: Interruption[] }, id: string) {
  if (!state.items.some(item => item.id === id)) return state
  return { items: state.items.filter(item => item.id !== id) }
}

function cancelExpiry(id: string) {
  const timer = expiryTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    expiryTimers.delete(id)
  }
}

export const useInterruptionStore = create<InterruptionState>((set, get) => ({
  items: [],

  raise: (item) => {
    cancelExpiry(item.id)
    if (item.expiresAt !== undefined) {
      const delay = Math.max(item.expiresAt - Date.now(), 0)
      expiryTimers.set(item.id, setTimeout(() => {
        expiryTimers.delete(item.id)
        get().resolve(item.id)
      }, delay))
    }
    set(state => ({
      items: [...state.items.filter(existing => existing.id !== item.id), item],
    }))
  },

  dismiss: (id) => {
    cancelExpiry(id)
    set(state => removeById(state, id))
  },

  resolve: (id) => {
    cancelExpiry(id)
    set(state => removeById(state, id))
  },

  clear: () => {
    for (const id of [...expiryTimers.keys()]) cancelExpiry(id)
    set(state => (state.items.length === 0 ? state : { items: [] }))
  },
}))

// ─── Raising helpers ────────────────────────────────────────────────────────
// Call sites are usually a catch block, and a catch block should not have to
// think about kinds, timestamps, or TTLs to be honest about what happened.

/**
 * Something broke and the user needs to know. Persists until dismissed —
 * a failure that disappears on a timer is a failure the user never saw.
 */
export function raiseFailure(
  id: string,
  title: string,
  body?: string,
  actions?: InterruptionAction[],
) {
  useInterruptionStore.getState().raise({
    id, kind: 'failure', title, body, actions,
    createdAt: Date.now(),
  })
}

/** An offer to act. Valuable, never urgent, always dismissible. */
export function raiseInvitation(
  id: string,
  title: string,
  body?: string,
  actions?: InterruptionAction[],
) {
  useInterruptionStore.getState().raise({
    id, kind: 'invitation', title, body, actions,
    createdAt: Date.now(),
  })
}

/** Confirmation that something worked. Removes itself. */
export function raiseNotice(id: string, title: string, body?: string) {
  const now = Date.now()
  useInterruptionStore.getState().raise({
    id, kind: 'notice', title, body,
    createdAt: now,
    expiresAt: now + NOTICE_TTL_MS,
  })
}

/** Work is blocked until the user answers. Never dismissible; see isDismissible. */
export function raiseDecision(
  id: string,
  title: string,
  body: string,
  actions: InterruptionAction[],
) {
  useInterruptionStore.getState().raise({
    id, kind: 'decision', title, body, actions,
    createdAt: Date.now(),
  })
}

export function resolveInterruption(id: string) {
  useInterruptionStore.getState().resolve(id)
}
