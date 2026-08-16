/**
 * Reviewing an architecture an agent proposed.
 *
 * The agent reads the codebase and says what it thinks the systems are. This
 * module holds the rules for what the human can then do about it, kept apart
 * from the panel so they can be tested on plain objects and cannot quietly
 * change when the UI is restyled.
 *
 * Two rules carry most of the weight.
 *
 * Approval is PER SYSTEM. A tree of forty candidates that must be taken or
 * left whole is a tree nobody accepts: one wrong boundary and the entire
 * proposal bounces, so the map stays named by guesswork. Nine approved and
 * three rejected has to be an ordinary outcome.
 *
 * And a rejection is an INSTRUCTION, not a deletion. The candidate and its
 * membership survive into the next round carrying the reason, because the
 * agent's next attempt is only better if it knows what was wrong.
 */

export type Decision = 'pending' | 'approved' | 'rejected'
export type ParentRefType = 'scope' | 'live_system' | 'proposed_system'
export type Disposition = 'assign' | 'retain' | 'unassigned' | 'excluded'

export interface ProposedSystem {
  systemKey: string
  name: string
  description?: string | null
  parentRefType: ParentRefType
  parentRefId?: string | null
  depth: number
  decision: Decision
  rejectionReason?: string | null
  /** Files this candidate would take ownership of. */
  fileCount: number
  /** Every file it touches, including ones it only reclassifies away. */
  affectedFileCount: number
  materializedSystemId?: string | null
}

export interface ProposalNode extends ProposedSystem {
  children: ProposalNode[]
}

export interface VisibleProposalNode {
  node: ProposalNode
  depth: number
}

/** Direct plus descendant files, so a container never misleadingly says 0. */
export function proposalSubtreeFileCount(node: ProposalNode): number {
  return node.fileCount + node.children.reduce(
    (total, child) => total + proposalSubtreeFileCount(child),
    0,
  )
}

/** The visual tree order, respecting the branches the reviewer folded. */
export function flattenVisibleProposalTree(
  roots: readonly ProposalNode[],
  collapsed: ReadonlySet<string>,
): VisibleProposalNode[] {
  const result: VisibleProposalNode[] = []
  const walk = (nodes: readonly ProposalNode[], depth: number) => {
    for (const node of nodes) {
      result.push({ node, depth })
      if (!collapsed.has(node.systemKey)) walk(node.children, depth + 1)
    }
  }
  walk(roots, 0)
  return result
}

/**
 * Rebuild the tree from the flat rows the daemon returns.
 *
 * A candidate whose parent is missing, or which sits in a parent cycle, is
 * lifted to the top rather than dropped. Losing a system silently is worse
 * than showing it in the wrong place: the user can move a misplaced box, but
 * cannot approve one they never saw.
 */
export function buildProposalTree(systems: readonly ProposedSystem[]): ProposalNode[] {
  const nodes = new Map<string, ProposalNode>()
  for (const system of systems) nodes.set(system.systemKey, { ...system, children: [] })

  const roots: ProposalNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentRefType === 'proposed_system' && node.parentRefId
      ? nodes.get(node.parentRefId)
      : undefined
    if (!parent || parent === node || descendsFrom(parent, node, nodes)) roots.push(node)
    else parent.children.push(node)
  }

  const byDepthThenName = (a: ProposalNode, b: ProposalNode) =>
    a.depth - b.depth || a.name.localeCompare(b.name)
  const sortTree = (list: ProposalNode[]) => {
    list.sort(byDepthThenName)
    for (const node of list) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}

function descendsFrom(
  candidate: ProposalNode,
  ancestor: ProposalNode,
  nodes: Map<string, ProposalNode>,
): boolean {
  const seen = new Set<string>()
  let current: ProposalNode | undefined = candidate
  while (current) {
    if (current === ancestor) return true
    if (seen.has(current.systemKey)) return true
    seen.add(current.systemKey)
    current = current.parentRefType === 'proposed_system' && current.parentRefId
      ? nodes.get(current.parentRefId)
      : undefined
  }
  return false
}

/**
 * Why a candidate cannot be approved yet, or null when it can.
 *
 * A proposed child cannot exist before its proposed parent, so approving out
 * of order is refused with the reason rather than greyed out - a disabled
 * control that explains nothing is how a user decides a feature is broken.
 */
export function blockedReason(
  system: ProposedSystem,
  bySystemKey: ReadonlyMap<string, ProposedSystem>,
): string | null {
  if (system.parentRefType !== 'proposed_system' || !system.parentRefId) return null
  const parent = bySystemKey.get(system.parentRefId)
  if (!parent) return null
  if (parent.decision === 'approved') return null
  if (parent.decision === 'rejected') {
    return `${parent.name} was rejected, so this cannot be placed inside it.`
  }
  return `Approve ${parent.name} first - this belongs inside it.`
}

export interface DecisionAttempt {
  systemKey: string
  decision: Decision
  rejectionReason?: string
}

export type DecisionRefusal = { ok: false; reason: string }
export type DecisionAccepted = { ok: true }

/**
 * Validate one decision before it is sent. The daemon enforces all of this
 * too - this exists so the refusal arrives as a sentence next to the button
 * rather than as a failed request the user has to interpret.
 */
export function checkDecision(
  attempt: DecisionAttempt,
  bySystemKey: ReadonlyMap<string, ProposedSystem>,
): DecisionAccepted | DecisionRefusal {
  const system = bySystemKey.get(attempt.systemKey)
  if (!system) return { ok: false, reason: 'That system is no longer part of this proposal.' }

  if (attempt.decision === 'rejected') {
    // A reason is required because it is the entire value of a rejection: the
    // next round is only better if the agent is told what was wrong.
    if (!attempt.rejectionReason?.trim()) {
      return { ok: false, reason: 'Say what is wrong with it - the agent uses that to try again.' }
    }
    return { ok: true }
  }

  if (attempt.decision === 'approved') {
    const blocked = blockedReason(system, bySystemKey)
    if (blocked) return { ok: false, reason: blocked }
  }
  return { ok: true }
}

export interface ProposalProgress {
  total: number
  approved: number
  rejected: number
  pending: number
  /** Files that would move into an approved system. */
  filesPlaced: number
  settled: boolean
}

export function readProgress(systems: readonly ProposedSystem[]): ProposalProgress {
  let approved = 0
  let rejected = 0
  let filesPlaced = 0
  for (const system of systems) {
    if (system.decision === 'approved') {
      approved += 1
      filesPlaced += system.fileCount
    } else if (system.decision === 'rejected') rejected += 1
  }
  const pending = systems.length - approved - rejected
  return {
    total: systems.length,
    approved,
    rejected,
    pending,
    filesPlaced,
    settled: systems.length > 0 && pending === 0,
  }
}

/**
 * What the panel header says. Stated as the user's own progress through a
 * decision, never as a status taxonomy - "12 systems to review" is a task,
 * "PROPOSAL_PENDING" is a database column.
 */
export function describeProgress(progress: ProposalProgress): string {
  if (progress.total === 0) return 'Nothing proposed yet.'
  if (progress.pending > 0) {
    const decided = progress.approved + progress.rejected
    return decided === 0
      ? `${progress.total} ${progress.total === 1 ? 'system' : 'systems'} to review`
      : `${progress.pending} left to review`
  }
  if (progress.rejected === 0) {
    return `All ${progress.approved} approved - ${progress.filesPlaced} files placed`
  }
  return `${progress.approved} approved, ${progress.rejected} sent back`
}
