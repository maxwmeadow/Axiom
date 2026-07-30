import type {
  DeltaClaim,
  DeltaCounts,
  DeltaFileChange,
  DeltaSummary,
  DeltaWorkSession,
} from '../../shared/types.ts'

/**
 * Morning Delta review projection.
 *
 * The first version of this listed raw changes in a scrubber and was
 * unreadable: five rows all reading "New cross-boundary calls" for what was
 * one architectural fact, in a strip too small to show which files were
 * involved. Two lessons are baked in here.
 *
 * 1. The review unit is a CLAIM, not an event. Compaction happens in archd;
 *    this module only decides what is shown and where the camera goes.
 * 2. Taking someone to a change is not the same as showing it. A boundary
 *    claim frames both SYSTEMS, because the boundary is the point, and
 *    everything unrelated is ghosted so the subject is unmistakable.
 */

export type DeltaMarkKind = 'created' | 'updated' | 'deleted'

export interface DeltaMark {
  change: DeltaMarkKind
  actor: DeltaFileChange['actor']
  saves: number
  systemName?: string
}

export interface DeltaReview {
  /** Claims worth showing, highest consequence first. */
  claims: DeltaClaim[]
  /** Intra-system churn, held back unless the user asks for it. */
  internalClaims: DeltaClaim[]
  /** File ID → mark, for files that still exist on the Floor. */
  marks: Map<string, DeltaMark>
  /** Deleted files, which have no node left to mark. */
  tombstones: DeltaFileChange[]
  /** What the agents said they were doing, keyed by session id. */
  sessions: Map<string, DeltaWorkSession>
  /** Sessions in start order, for the narration header. */
  sessionList: DeltaWorkSession[]
  until: number
  empty: boolean
}

export function buildDeltaReview(
  summary: DeltaSummary | null,
  knownNodeIds: ReadonlySet<string>,
): DeltaReview {
  const marks = new Map<string, DeltaMark>()
  const tombstones: DeltaFileChange[] = []

  if (!summary) {
    return {
      claims: [], internalClaims: [], marks, tombstones,
      sessions: new Map(), sessionList: [], until: 0, empty: true,
    }
  }

  for (const file of summary.files) {
    if (file.change === 'deleted') {
      tombstones.push(file)
      continue
    }
    if (!knownNodeIds.has(file.id)) continue
    marks.set(file.id, {
      change: file.change,
      actor: file.actor,
      saves: file.saves,
      systemName: file.systemName,
    })
  }

  const claims = (summary.claims ?? []).filter(claim => !claim.internal)
  const internalClaims = (summary.claims ?? []).filter(claim => claim.internal)

  const sessionList = summary.sessions ?? []
  const sessions = new Map(sessionList.map(session => [session.id, session]))

  return {
    claims,
    internalClaims,
    marks,
    tombstones,
    sessions,
    sessionList,
    until: summary.until,
    empty: claims.length === 0 && internalClaims.length === 0,
  }
}

/**
 * The agent's own words for why a claim exists. Falls back from the closing
 * summary to the declared goal, because an in-flight session has a goal but no
 * summary yet. Returns null when nobody narrated the change — the panel says
 * so explicitly rather than pretending the silence means nothing.
 */
export function claimRationale(
  claim: DeltaClaim,
  review: DeltaReview,
): string | null {
  if (!claim.sessionId) return null
  const session = review.sessions.get(claim.sessionId)
  if (!session) return null
  return session.summary || session.goal || null
}

/** How long a session ran, for the narration header. */
export function sessionDuration(session: DeltaWorkSession): string {
  const end = session.endedAt || Date.now()
  const minutes = Math.max(1, Math.round((end - session.startedAt) / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * The nodes a claim is about. Systems come first because framing a boundary
 * means showing the two systems and the space between them; file focus is the
 * fallback for claims with no system context (a file nothing has classified).
 */
export function claimFocusTargets(
  claim: DeltaClaim | null,
  knownNodeIds: ReadonlySet<string>,
): string[] {
  if (!claim) return []
  const systems = (claim.focusSystemIds ?? []).filter(id => knownNodeIds.has(id))
  if (systems.length > 0) return systems
  return (claim.focusFileIds ?? []).filter(id => knownNodeIds.has(id))
}

interface MarkableNode {
  id: string
  parentId?: string
  data?: Record<string, unknown>
}

/**
 * Expands a focus set to everything that should stay lit: the targets, every
 * node inside them, and every container around them. Without the ancestors a
 * focused file would glow inside a ghosted system; without the descendants a
 * focused system would be a lit but empty shell.
 */
function illuminated<T extends MarkableNode>(nodes: T[], targets: string[]): Set<string> {
  const lit = new Set(targets)
  if (lit.size === 0) return lit

  const parentOf = new Map<string, string>()
  for (const node of nodes) {
    if (node.parentId) parentOf.set(node.id, node.parentId)
  }
  for (const target of targets) {
    let parent = parentOf.get(target)
    while (parent && !lit.has(parent)) {
      lit.add(parent)
      parent = parentOf.get(parent)
    }
  }
  // Descendants: repeat until stable, since children may precede parents.
  let grew = true
  while (grew) {
    grew = false
    for (const node of nodes) {
      if (node.parentId && lit.has(node.parentId) && !lit.has(node.id)) {
        lit.add(node.id)
        grew = true
      }
    }
  }
  return lit
}

/**
 * Stamps marks and ghosting onto canvas nodes as a projection, never as canvas
 * state — the same discipline the living FX layer uses. Layout, selection and
 * zoom passes cannot overwrite a review in progress, and ending the review
 * restores the untouched nodes automatically.
 */
export function applyDeltaMarks<T extends MarkableNode>(
  nodes: T[],
  review: DeltaReview,
  focusTargets: string[],
): T[] {
  const ghosting = focusTargets.length > 0
  if (review.marks.size === 0 && !ghosting) return nodes

  const lit = ghosting ? illuminated(nodes, focusTargets) : null
  const focused = new Set(focusTargets)
  let touched = false

  const projected = nodes.map(node => {
    const mark = review.marks.get(node.id)
    const isFocused = focused.has(node.id)
    const ghosted = lit ? !lit.has(node.id) : false
    if (!mark && !isFocused && !ghosted) return node
    touched = true
    return {
      ...node,
      data: {
        ...node.data,
        deltaMark: mark?.change ?? null,
        deltaFocused: isFocused,
        // Reuse the canvas's existing dim treatment rather than inventing a
        // second way for a node to recede.
        dimmed: ghosted ? true : node.data?.dimmed,
      },
    }
  })
  return touched ? projected : nodes
}

/**
 * The one-line headline. It counts CLAIMS, because that is what the user is
 * being asked to review — counting raw events is what made the first version
 * say "5 cross-boundary edges" about a single new dependency.
 */
export function deltaHeadline(review: DeltaReview): string {
  const total = review.claims.length
  if (total === 0) {
    return review.internalClaims.length > 0 ? 'Internal changes only' : 'No structural changes'
  }
  const cycles = review.claims.filter(claim => claim.createsCycle).length
  const label = total === 1 ? '1 change to review' : `${total} changes to review`
  return cycles > 0 ? `${label} · ${cycles} cycle${cycles > 1 ? 's' : ''}` : label
}

/**
 * Attribution. "Agent" is called out explicitly because the whole point of the
 * delta is reviewing work you did not personally do.
 */
export function deltaAttribution(counts: DeltaCounts): string {
  if (counts.agentFiles && counts.humanFiles) return 'by you and your agents'
  if (counts.agentFiles) return 'by your agents'
  if (counts.humanFiles) return 'by you'
  return ''
}

/** Human-readable window, e.g. "since 9:14 PM" or "over the last 3 days". */
export function deltaWindow(since: number, until: number): string {
  if (!since) return 'since your last review'
  const span = until - since
  const day = 24 * 60 * 60 * 1000
  if (span > day) {
    const days = Math.round(span / day)
    return `over the last ${days} day${days > 1 ? 's' : ''}`
  }
  const at = new Date(since)
  return `since ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/** Clamps a claim cursor, returning -1 when there is nothing to review. */
export function clampClaimCursor(claims: DeltaClaim[], cursor: number): number {
  if (claims.length === 0) return -1
  if (cursor < 0) return 0
  if (cursor >= claims.length) return claims.length - 1
  return cursor
}
