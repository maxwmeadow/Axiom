// The one queue every attention-seeking surface goes through.
//
// Before this, each banner owned its own visibility and decided independently
// when to appear. Nothing could rank them, nothing could tell you how many were
// waiting, and two of them rendered at the same coordinates. Routing everything
// through one store means the ordering rules in shared/interruptions.ts are the
// only ordering rules, and adding a surface cannot reintroduce a collision.
import { create } from 'zustand'
import type { Interruption, InterruptionAction } from '../../shared/interruptions'

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

export const useInterruptionStore = create<InterruptionState>((set) => ({
  items: [],

  raise: (item) => set(state => ({
    items: [...state.items.filter(existing => existing.id !== item.id), item],
  })),

  dismiss: (id) => set(state => ({
    items: state.items.filter(item => item.id !== id),
  })),

  resolve: (id) => set(state => ({
    items: state.items.filter(item => item.id !== id),
  })),

  clear: () => set({ items: [] }),
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
