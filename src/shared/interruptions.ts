// Interruptions — everything that wants the user's attention over the canvas.
//
// Axiom grew seven independent floating surfaces, each deciding on its own when
// to appear. Two of them shipped at identical coordinates and covered each
// other. Worse than the collision was the rhythm: unrelated things surfacing one
// at a time, in whatever order their triggers happened to fire, with no way to
// tell which mattered.
//
// The fix is not "show everything at once" — a wall of banners is the same
// problem wearing a different coat. It is a single ranked queue with exactly one
// item visible, an honest count of what is behind it, and a rule for what wins.
//
// This module is the rule. It is pure so the ordering can be tested directly
// and cannot drift as surfaces are added.

/**
 * Why something is interrupting, in descending order of claim on attention.
 *
 * · decision   — work is blocked until the user answers. An agent is waiting.
 * · failure    — something broke. The user must know; nothing is waiting on them.
 * · invitation — an offer to act, valuable but never urgent.
 * · notice     — confirmation of something that already succeeded.
 */
export type InterruptionKind = 'decision' | 'failure' | 'invitation' | 'notice'

const KIND_RANK: Record<InterruptionKind, number> = {
  decision: 0,
  failure: 1,
  invitation: 2,
  notice: 3,
}

export interface InterruptionAction {
  label: string
  /** Marks the action that resolves the interruption, for emphasis. */
  primary?: boolean
  run: () => void | Promise<void>
}

export interface Interruption {
  /**
   * Stable identity. Re-raising the same id replaces the existing entry rather
   * than stacking a duplicate — a retry loop that fails ten times is one
   * interruption, not ten.
   */
  id: string
  kind: InterruptionKind
  title: string
  body?: string
  createdAt: number
  actions?: InterruptionAction[]
  /**
   * Wall-clock expiry. Notices set this so a confirmation cannot linger; a
   * decision or failure must never set it, because time passing is not an
   * answer.
   */
  expiresAt?: number
  /**
   * Whether the user may set this aside without answering. Decisions are never
   * dismissible: something is genuinely waiting on the reply.
   */
  dismissible?: boolean
}

/** A decision is blocking by definition, whatever the caller passed. */
export function isDismissible(item: Interruption): boolean {
  if (item.kind === 'decision') return false
  return item.dismissible !== false
}

/** Entries whose expiry has passed. A missing expiresAt never expires. */
export function isExpired(item: Interruption, now: number): boolean {
  return item.expiresAt !== undefined && item.expiresAt <= now
}

/**
 * The queue, most-deserving first: by kind, then oldest first so a backlog
 * drains in the order it arrived instead of reshuffling under the user.
 * Expired entries are dropped.
 */
export function rankInterruptions(
  items: readonly Interruption[],
  now: number,
): Interruption[] {
  return items
    .filter(item => !isExpired(item, now))
    .slice()
    .sort((a, b) => {
      const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
      if (kind !== 0) return kind
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      // Ties would otherwise depend on insertion order, which makes the visible
      // item flicker between renders. Identity is arbitrary but stable.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

export interface LaneState {
  /** The single entry on screen, or null when nothing is waiting. */
  current: Interruption | null
  /** How many ranked entries are behind it. */
  waiting: number
}

/**
 * What the lane shows. Exactly one item, never two — the count is how the rest
 * stay honest without competing for the same space.
 */
export function laneState(items: readonly Interruption[], now: number): LaneState {
  const ranked = rankInterruptions(items, now)
  return {
    current: ranked[0] ?? null,
    waiting: Math.max(ranked.length - 1, 0),
  }
}

/**
 * The soonest moment the lane's contents change on their own, or null when
 * nothing expires. The lane schedules a single timer from this instead of
 * polling, so an idle workbench does no work.
 */
export function nextExpiry(items: readonly Interruption[], now: number): number | null {
  let soonest: number | null = null
  for (const item of items) {
    if (item.expiresAt === undefined || isExpired(item, now)) continue
    if (soonest === null || item.expiresAt < soonest) soonest = item.expiresAt
  }
  return soonest
}
