import { create } from 'zustand'
import type { Decision, ProposedSystem } from '../canvas/architectureProposal.ts'
import { checkDecision } from '../canvas/architectureProposal.ts'

/**
 * The architecture an agent proposed, and the decisions taken on it.
 *
 * Proposals live in their own daemon tables rather than as pending rows in
 * `systems`, so nothing unconfirmed can leak into a snapshot, the delta, or the
 * canvas. This store is the renderer's view of that: it never invents a
 * proposal locally, and an approved system reaches the map only because the
 * daemon materialised it and broadcast the change.
 */

const API = 'http://127.0.0.1:7743'

export interface ProposalSummary {
  id: string
  workspaceId: string
  currentRevision: number
  createdBy?: string | null
  createdAt?: number
  rationale?: string | null
  evidenceSummary?: string | null
  systems: ProposedSystem[]
}

/**
 * What the daemon actually returns: a header whose candidates live inside the
 * current round, since rounds are immutable and numbered. The panel wants one
 * flat thing to render, so the translation happens here — at the boundary,
 * once — rather than every component learning the wire format.
 *
 * This mattered: reading `systems` off the header found nothing and the panel
 * rendered an empty review, which looks exactly like "the agent proposed
 * nothing" rather than like a bug.
 */
interface DaemonProposal {
  id: string
  workspaceId: string
  currentRevision: number
  createdBy?: string | null
  createdAt?: number
  round?: {
    rationale?: string | null
    evidenceSummary?: string | null
    systems?: ProposedSystem[]
  }
  systems?: ProposedSystem[]
}

function normalize(proposal: DaemonProposal): ProposalSummary {
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    currentRevision: proposal.currentRevision,
    createdBy: proposal.createdBy ?? null,
    createdAt: proposal.createdAt,
    rationale: proposal.round?.rationale ?? null,
    evidenceSummary: proposal.round?.evidenceSummary ?? null,
    systems: proposal.round?.systems ?? proposal.systems ?? [],
  }
}

interface ProposalState {
  proposal: ProposalSummary | null
  loading: boolean
  /** A refusal to show beside the system that caused it, keyed by systemKey. */
  refusals: Record<string, string>
  /** Systems with a decision in flight, so a double-press cannot double-send. */
  deciding: string[]
  error: string | null
  reviewing: boolean
  cursor: number

  load: (workspaceId: string) => Promise<void>
  decide: (systemKey: string, decision: Decision, rejectionReason?: string) => Promise<void>
  beginReview: () => void
  endReview: () => void
  setCursor: (index: number) => void
  clearRefusal: (systemKey: string) => void
}

export const useProposalStore = create<ProposalState>((set, get) => ({
  proposal: null,
  loading: false,
  refusals: {},
  deciding: [],
  error: null,
  reviewing: false,
  cursor: 0,

  load: async (workspaceId: string) => {
    if (!workspaceId) return
    set({ loading: true, error: null })
    try {
      const listed = await fetch(
        `${API}/api/architecture-proposals?workspace=${encodeURIComponent(workspaceId)}`,
      )
      if (!listed.ok) throw new Error(`proposals unavailable (${listed.status})`)
      // The daemon returns a bare array; accept the wrapped form too so a
      // later shape change on that side cannot blank this panel silently.
      const body = await listed.json() as
        Array<{ id: string }> | { proposals?: Array<{ id: string }> }
      const list = Array.isArray(body) ? body : body.proposals ?? []
      const head = list[0]
      if (!head) {
        set({ proposal: null, loading: false })
        return
      }
      const detailed = await fetch(
        `${API}/api/architecture-proposals/${head.id}?workspace=${encodeURIComponent(workspaceId)}`,
      )
      if (!detailed.ok) throw new Error(`proposal unavailable (${detailed.status})`)
      set({ proposal: normalize(await detailed.json() as DaemonProposal), loading: false })
    } catch (error) {
      // A daemon that is not running is not a broken proposal. Say what failed
      // rather than rendering an empty review that looks like "nothing to do".
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Could not reach Axiom’s daemon.',
      })
    }
  },

  decide: async (systemKey, decision, rejectionReason) => {
    const { proposal, deciding } = get()
    if (!proposal || deciding.includes(systemKey)) return

    const bySystemKey = new Map(proposal.systems.map(system => [system.systemKey, system]))
    const checked = checkDecision({ systemKey, decision, rejectionReason }, bySystemKey)
    if (!checked.ok) {
      // Refused locally so the sentence lands beside the control that was
      // pressed. The daemon enforces the same rules; this only saves the user
      // a round trip to be told something we already knew.
      set(state => ({ refusals: { ...state.refusals, [systemKey]: checked.reason } }))
      return
    }

    set(state => ({
      deciding: [...state.deciding, systemKey],
      refusals: { ...state.refusals, [systemKey]: '' },
    }))
    try {
      const res = await fetch(
        `${API}/api/architecture-proposals/${proposal.id}/systems/${encodeURIComponent(systemKey)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: proposal.workspaceId,
            revision: proposal.currentRevision,
            decision,
            rejectionReason: rejectionReason ?? '',
            decidedBy: 'user',
          }),
        },
      )
      if (res.status === 409) {
        // Someone else moved the proposal on. Reload rather than overwrite:
        // the whole point of the revision check is that the last write does
        // not silently win.
        set(state => ({
          refusals: {
            ...state.refusals,
            [systemKey]: 'This proposal changed while you were reviewing it. Reloaded.',
          },
        }))
        await get().load(proposal.workspaceId)
        return
      }
      if (!res.ok) throw new Error(await res.text())
      await get().load(proposal.workspaceId)
    } catch (error) {
      set(state => ({
        refusals: {
          ...state.refusals,
          [systemKey]: error instanceof Error ? error.message : 'That decision did not save.',
        },
      }))
    } finally {
      set(state => ({ deciding: state.deciding.filter(key => key !== systemKey) }))
    }
  },

  beginReview: () => set({ reviewing: true, cursor: 0 }),
  endReview: () => set({ reviewing: false }),
  setCursor: (index: number) => set({ cursor: Math.max(0, index) }),
  clearRefusal: (systemKey: string) =>
    set(state => ({ refusals: { ...state.refusals, [systemKey]: '' } })),
}))
