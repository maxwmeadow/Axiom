import type { ParallelAgentSnapshot, ParallelCommandDeckStatus } from '../../shared/types'

export interface AgentLaneAgent {
  id: string
  name: string
  goal: string
  startedAt: number
}

export interface AgentLaneBranch {
  rootId: string
  name: string
  head: string
  isPrimary: boolean
  boundaryCount: number
  fileCount: number
  agents: AgentLaneAgent[]
  errorCount: number
  unreviewed: number
  unexplained: number
  unexpected: number
}

export interface AgentLaneCollisionBranch {
  rootId: string
  name: string
  fileCount: number
  claim: string
}

export interface AgentLaneCollision {
  systemId: string
  systemName: string
  branches: AgentLaneCollisionBranch[]
}

export interface AgentLaneModel {
  visible: boolean
  branchCount: number
  agentCount: number
  branches: AgentLaneBranch[]
  collisions: AgentLaneCollision[]
}

/** Same transport caveat as `list`: neither string is guaranteed to arrive. */
function text(value: string | undefined | null): string {
  return typeof value === 'string' ? value : ''
}

function branchName(branch: string | undefined, headCommit: string | undefined): string {
  return text(branch) || `detached@${text(headCommit).slice(0, 7) || 'unknown'}`
}

const EMPTY: AgentLaneModel = {
  visible: false, branchCount: 0, agentCount: 0, branches: [], collisions: [],
}

/**
 * The snapshot arrives over HTTP, so its type is a promise the compiler cannot
 * keep. An error body, a truncated response, or an archd built before this
 * field existed all arrive as objects missing the arrays below - and reading
 * `.map` off one of them threw inside a `useMemo`, which React escalates into a
 * render failure that blanks the whole workbench. A panel must never be able to
 * do that, so every list is treated as absent-until-proven.
 */
function list<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : []
}

/**
 * Turns the transport snapshot into the deliberately small projection the lane
 * renders. Keeping this pure makes the important UX contract executable:
 * one-root projects remain visually identical, while parallel work is grouped
 * by the worktree that actually produced it.
 */
export function buildAgentLaneModel(
  snapshot: ParallelAgentSnapshot | null,
  deck: ParallelCommandDeckStatus | null = null,
): AgentLaneModel {
  if (!snapshot || !Array.isArray(snapshot.branches)) return EMPTY

  const branches = snapshot.branches.map(branch => {
    const brief = list(deck?.branches).find(candidate => candidate.rootId === branch.rootId)
    const files = new Set(list(branch.unclassifiedFiles))
    for (const touch of list(branch.touchedSystems)) {
      for (const file of list(touch.files)) files.add(file)
    }
    return {
      rootId: branch.rootId,
      name: branchName(branch.branch, branch.headCommit),
      head: text(branch.headCommit).slice(0, 7),
      isPrimary: branch.isPrimary,
      boundaryCount: list(branch.touchedSystems).length,
      fileCount: files.size,
      agents: list(branch.activeWork).map(work => ({
        id: work.sessionId,
        name: work.agent || 'Agent',
        goal: work.goal,
        startedAt: work.startedAt,
      })),
      errorCount: branch.errors?.length ?? 0,
      unreviewed: brief?.unreviewedClaims ?? 0,
      unexplained: brief?.unexplained ?? 0,
      unexpected: brief?.unexpected ?? 0,
    }
  })

  const collisions = list(snapshot.collisions).map(collision => ({
    systemId: collision.systemId,
    systemName: collision.systemName,
    branches: list(collision.branches).map(branch => {
      const files = list(branch.files)
      return {
        rootId: branch.rootId,
        name: branchName(
          branch.branch,
          snapshot.branches.find(candidate => candidate.rootId === branch.rootId)?.headCommit ?? '',
        ),
        fileCount: files.length,
        claim: list(branch.claims).find(claim => !claim.internal)?.title
          ?? `${files.length} changed file${files.length === 1 ? '' : 's'}`,
      }
    }),
  }))

  return {
    // Axiom already has single-agent surfaces. The lane is a parallel-worktree
    // surface, so showing it for one root would violate legacy visual parity.
    visible: branches.length > 1,
    branchCount: branches.length,
    agentCount: branches.reduce((count, branch) => count + branch.agents.length, 0),
    branches,
    collisions,
  }
}
