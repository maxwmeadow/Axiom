import { create } from 'zustand'
import type { CanvasSnapshot } from '../../shared/types.ts'
import type { Decision, ProposedSystem } from '../canvas/architectureProposal.ts'
import { checkDecision } from '../canvas/architectureProposal.ts'
import { useGraphStore } from './graphStore.ts'

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
let proposalLayoutSaveQueue: Promise<void> = Promise.resolve()
let proposalLayoutGeneration = 0
let proposalLayoutBlockedThrough = 0
let proposalLoadGeneration = 0

export interface ProposalSummary {
  id: string
  workspaceId: string
  rootId?: string | null
  parentScopeType?: 'workspace' | 'system'
  parentScopeId?: string
  currentRevision: number
  createdBy?: string | null
  createdAt?: number
  rationale?: string | null
  evidenceSummary?: string | null
  systems: ProposedSystem[]
  memberships: ProposalMembership[]
  layouts: ProposalLayout[]
}

export interface ProposalMembership {
  id: string
  fileId?: string | null
  rootId: string
  filePath: string
  targetSystemKey: string
  disposition: 'assign' | 'retain' | 'unassigned' | 'excluded'
  rationale?: string | null
}

export interface ProposalLayout {
  nodeType: 'system' | 'file'
  /** A systemKey for systems, a membership id for files. */
  nodeKey: string
  parentRefType: 'scope' | 'live_system' | 'proposed_system'
  parentRefId: string
  positionX: number
  positionY: number
  width: number
  height: number
  scale: number
  interiorScale: number
  updatedAt?: number
}

/**
 * What the daemon actually returns: a header whose candidates live inside the
 * current round, since rounds are immutable and numbered. The panel wants one
 * flat thing to render, so the translation happens here - at the boundary,
 * once - rather than every component learning the wire format.
 *
 * This mattered: reading `systems` off the header found nothing and the panel
 * rendered an empty review, which looks exactly like "the agent proposed
 * nothing" rather than like a bug.
 */
interface DaemonProposal {
  id: string
  workspaceId: string
  rootId?: string | null
  parentScopeType?: 'workspace' | 'system'
  parentScopeId?: string
  currentRevision: number
  createdBy?: string | null
  createdAt?: number
  round?: {
    rationale?: string | null
    evidenceSummary?: string | null
    systems?: ProposedSystem[]
    memberships?: ProposalMembership[]
    layouts?: ProposalLayout[]
  }
  systems?: ProposedSystem[]
  memberships?: ProposalMembership[]
  layouts?: ProposalLayout[]
}

function normalize(proposal: DaemonProposal): ProposalSummary {
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    rootId: proposal.rootId ?? null,
    parentScopeType: proposal.parentScopeType ?? 'workspace',
    parentScopeId: proposal.parentScopeId ?? '',
    currentRevision: proposal.currentRevision,
    createdBy: proposal.createdBy ?? null,
    createdAt: proposal.createdAt,
    rationale: proposal.round?.rationale ?? null,
    evidenceSummary: proposal.round?.evidenceSummary ?? null,
    systems: proposal.round?.systems ?? proposal.systems ?? [],
    memberships: proposal.round?.memberships ?? proposal.memberships ?? [],
    layouts: proposal.round?.layouts ?? proposal.layouts ?? [],
  }
}

interface FinalizeProposalResponse {
  proposal: DaemonProposal
  snapshot: CanvasSnapshot
  deltaBaselineAt?: number
}

function withOptimisticLayouts(proposal: ProposalSummary, layouts: ProposalLayout[]): ProposalSummary {
  const changed = new Set(layouts.map(layout => `${layout.nodeType}:${layout.nodeKey}`))
  const bySystem = new Map(layouts
    .filter(layout => layout.nodeType === 'system')
    .map(layout => [layout.nodeKey, layout]))
  const byMembership = new Map(layouts
    .filter(layout => layout.nodeType === 'file')
    .map(layout => [layout.nodeKey, layout]))
  return {
    ...proposal,
    layouts: [
      ...proposal.layouts.filter(layout => !changed.has(`${layout.nodeType}:${layout.nodeKey}`)),
      ...layouts,
    ],
    systems: proposal.systems.map(system => {
      const layout = bySystem.get(system.systemKey)
      return layout ? {
        ...system,
        parentRefType: layout.parentRefType,
        parentRefId: layout.parentRefType === 'scope' ? null : layout.parentRefId,
      } : system
    }),
    memberships: proposal.memberships.map(membership => {
      const layout = byMembership.get(membership.id)
      return layout ? { ...membership, targetSystemKey: layout.parentRefId } : membership
    }),
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
  finalizing: boolean
  reviewing: boolean
  cursor: number
  selectedSystemKey: string | null

  load: (workspaceId: string) => Promise<void>
  decide: (systemKey: string, decision: Decision, rejectionReason?: string) => Promise<void>
  finalize: () => Promise<void>
  previewLayouts: (layouts: ProposalLayout[]) => void
  saveLayouts: (layouts: ProposalLayout[]) => Promise<void>
  beginReview: () => void
  endReview: () => void
  setCursor: (index: number) => void
  selectSystem: (systemKey: string | null) => void
  clearRefusal: (systemKey: string) => void
}

export const useProposalStore = create<ProposalState>((set, get) => ({
  proposal: null,
  loading: false,
  refusals: {},
  deciding: [],
  error: null,
  finalizing: false,
  reviewing: false,
  cursor: 0,
  selectedSystemKey: null,

  load: async (workspaceId: string) => {
    if (!workspaceId) return
    proposalLayoutGeneration += 1
    const loadGeneration = ++proposalLoadGeneration
    // Never display one workspace's proposal while another workspace is
    // loading. A late response from a deleted project is ignored below too.
    set({
      proposal: null,
      loading: true,
      error: null,
      refusals: {},
      deciding: [],
      finalizing: false,
      reviewing: false,
      cursor: 0,
      selectedSystemKey: null,
    })
    try {
      const listed = await fetch(
        `${API}/api/architecture-proposals?workspace=${encodeURIComponent(workspaceId)}`,
      )
      if (!listed.ok) throw new Error(`proposals unavailable (${listed.status})`)
      // The daemon returns a bare array; accept the wrapped form too so a
      // later shape change on that side cannot blank this panel silently.
      const body = await listed.json() as
        Array<{ id: string }> | { proposals?: Array<{ id: string }> }
      if (loadGeneration !== proposalLoadGeneration) return
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
      const detailBody = await detailed.json() as DaemonProposal
      if (loadGeneration !== proposalLoadGeneration) return
      set({ proposal: normalize(detailBody), loading: false })
    } catch (error) {
      if (loadGeneration !== proposalLoadGeneration) return
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

  // Review completion is a persistence boundary, not a navigation flag. Wait
  // for the last drag/resize write, ask the daemon to atomically materialize
  // the reviewed tree, then install the exact committed snapshot before the
  // review screen is allowed to unmount.
  finalize: async () => {
    if (get().finalizing) return
    set({ finalizing: true, error: null })
    try {
      await proposalLayoutSaveQueue
      const proposal = get().proposal
      if (!proposal) throw new Error('There is no architecture proposal to finish.')
      const response = await fetch(`${API}/api/architecture-proposals/${proposal.id}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: proposal.workspaceId,
          revision: proposal.currentRevision,
          decidedBy: 'user',
          // Completing the setup review defines the first authored baseline.
          // Morning Delta starts after this commit; it must not ask the user
          // to review the provisional map that this screen just replaced.
          establishDeltaBaseline: true,
        }),
      })
      if (response.status === 409) {
        await get().load(proposal.workspaceId)
        throw new Error('This proposal changed while you were finishing it. Review the refreshed map and try again.')
      }
      if (!response.ok) throw new Error(await response.text())
      const body = await response.json() as FinalizeProposalResponse
      const finalized = normalize(body.proposal)
      useGraphStore.getState().applySnapshot(body.snapshot)
      if (body.deltaBaselineAt) {
        // The daemon owns the durable watermark. Clear the already-loaded
        // pre-commit invitation synchronously so entering the Floor cannot
        // flash a stale review while delta:ready refreshes from that boundary.
        useGraphStore.setState({
          delta: null,
          deltaReviewing: false,
          deltaCursor: -1,
          deltaDeferredUntil: 0,
        })
      }
      set({ proposal: finalized, error: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The reviewed architecture could not be committed.'
      set({ error: message })
      throw error
    } finally {
      set({ finalizing: false })
    }
  },

  // A drag commits through the same two visual phases as the live Floor:
  // first show the exact pointer-up frame, then animate into the collision /
  // containment result. This first phase is renderer-only; only saveLayouts
  // crosses the proposal persistence boundary.
  previewLayouts: (layouts) => {
    if (layouts.length === 0) return
    const { proposal } = get()
    if (!proposal) return
    set({ proposal: withOptimisticLayouts(proposal, layouts), error: null })
  },

  saveLayouts: (layouts) => {
    const { proposal } = get()
    if (!proposal || layouts.length === 0) return Promise.resolve()
    const target = {
      id: proposal.id,
      workspaceId: proposal.workspaceId,
      revision: proposal.currentRevision,
    }
    const generation = ++proposalLayoutGeneration
    set({ proposal: withOptimisticLayouts(proposal, layouts), error: null })
    const save = proposalLayoutSaveQueue.catch(() => {}).then(async () => {
      if (generation <= proposalLayoutBlockedThrough) return
      const current = get().proposal
      if (!current || current.id !== target.id || current.currentRevision !== target.revision) return
      const response = await fetch(`${API}/api/architecture-proposals/${target.id}/layouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: target.workspaceId,
          revision: target.revision,
          layouts,
        }),
      })
      if (response.status === 409) {
        proposalLayoutBlockedThrough = proposalLayoutGeneration
        await get().load(target.workspaceId)
        set({ error: 'This proposal changed while you were arranging it. Reloaded.' })
        throw new Error('This proposal changed while you were arranging it. Reloaded.')
      }
      if (!response.ok) {
        const message = await response.text()
        proposalLayoutBlockedThrough = proposalLayoutGeneration
        await get().load(target.workspaceId)
        set({ error: `That layout change did not save: ${message}` })
        throw new Error(message)
      }
      const saved = normalize(await response.json() as DaemonProposal)
      if (generation === proposalLayoutGeneration) {
        set({ proposal: saved, error: null })
      }
    })
    proposalLayoutSaveQueue = save
    return save
  },

  beginReview: () => set({ reviewing: true, cursor: 0, selectedSystemKey: null }),
  endReview: () => set({ reviewing: false }),
  setCursor: (index: number) => set({ cursor: Math.max(0, index) }),
  selectSystem: (systemKey: string | null) => set({ selectedSystemKey: systemKey }),
  clearRefusal: (systemKey: string) =>
    set(state => ({ refusals: { ...state.refusals, [systemKey]: '' } })),
}))
