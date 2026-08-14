import type { DbFile, DbSystem, FloorLayout } from '../../shared/types'
import type { ProposalSummary } from '../store/architectureProposalStore'

export interface ProposalPreviewModel {
  systems: DbSystem[]
  files: DbFile[]
  layouts: FloorLayout[]
}

function languageFromPath(path: string): string {
  const lower = path.toLowerCase()
  const extensions: Array<[string, string]> = [
    ['.tsx', 'tsx'], ['.ts', 'typescript'], ['.jsx', 'jsx'], ['.mjs', 'javascript'],
    ['.js', 'javascript'], ['.py', 'python'], ['.go', 'go'], ['.rs', 'rust'],
    ['.cs', 'csharp'], ['.cpp', 'cpp'], ['.cc', 'cpp'], ['.cxx', 'cpp'],
    ['.hpp', 'cpp'], ['.hxx', 'cpp'], ['.rb', 'ruby'], ['.java', 'java'],
    ['.mdx', 'markdown'], ['.md', 'markdown'],
  ]
  return extensions.find(([extension]) => lower.endsWith(extension))?.[1] ?? 'unknown'
}

/**
 * Project an immutable proposal through the same semantic model the live Floor
 * uses. IDs are namespaced so a candidate can never masquerade as a canonical
 * system before approval. Membership files are cloned for the same reason.
 */
export function buildProposalPreviewModel(
  proposal: ProposalSummary,
  indexedSystems: readonly DbSystem[],
  indexedFiles: readonly DbFile[],
): ProposalPreviewModel {
  const proposalId = (key: string) => `proposal:${proposal.id}:${key}`
  const liveById = new Map(indexedSystems.map(system => [system.id, system]))
  const includedLive = new Map<string, DbSystem>()

  const includeLiveAncestors = (id: string | null | undefined) => {
    const seen = new Set<string>()
    let current = id ? liveById.get(id) : undefined
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      includedLive.set(current.id, { ...current })
      current = current.parentId ? liveById.get(current.parentId) : undefined
    }
  }
  for (const system of proposal.systems) {
    if (system.parentRefType === 'live_system') includeLiveAncestors(system.parentRefId)
  }
  if (proposal.parentScopeType === 'system') includeLiveAncestors(proposal.parentScopeId)

  const systems: DbSystem[] = [
    ...includedLive.values(),
    ...proposal.systems.map(system => ({
      id: proposalId(system.systemKey),
      workspaceId: proposal.workspaceId,
      name: system.name,
      parentId: system.parentRefType === 'proposed_system' && system.parentRefId
        ? proposalId(system.parentRefId)
        : system.parentRefType === 'live_system'
          ? system.parentRefId ?? null
          : proposal.parentScopeType === 'system'
            ? proposal.parentScopeId ?? null
            : null,
      source: 'agent' as const,
      color: null,
      description: system.description ?? null,
      agentNotes: null,
      depth: system.depth,
      positionX: 0,
      positionY: 0,
      width: null,
      height: null,
      createdAt: proposal.createdAt ?? 0,
      updatedAt: proposal.createdAt ?? 0,
    })),
  ]

  const indexedById = new Map(indexedFiles.map(file => [file.id, file]))
  const indexedByPath = new Map(indexedFiles.map(file => [file.relPath.toLowerCase(), file]))
  const files = proposal.memberships
    .filter(membership => membership.disposition === 'assign')
    .flatMap((membership): DbFile[] => {
      const target = proposal.systems.find(system => system.systemKey === membership.targetSystemKey)
      if (!target) return []
      const indexed = (membership.fileId ? indexedById.get(membership.fileId) : undefined)
        ?? indexedByPath.get(membership.filePath.replaceAll('\\', '/').toLowerCase())
      return [{
        id: `proposal-file:${proposal.id}:${membership.id}`,
        rootId: indexed?.rootId ?? membership.rootId,
        path: indexed?.path ?? membership.filePath,
        relPath: indexed?.relPath ?? membership.filePath,
        language: indexed?.language || languageFromPath(membership.filePath),
        systemId: proposalId(target.systemKey),
        lineCount: indexed?.lineCount ?? 0,
        churnScore: indexed?.churnScore ?? 0,
        activityScore: indexed?.activityScore,
        activityAt: indexed?.activityAt,
        shape: indexed?.shape,
        shapeOverride: indexed?.shapeOverride,
        displayName: indexed?.displayName,
        positionX: 0,
        positionY: 0,
        width: indexed?.width,
        height: indexed?.height,
        indexedAt: indexed?.indexedAt ?? 0,
      }]
    })

  const membershipById = new Map(proposal.memberships.map(membership => [membership.id, membership]))
  const layouts: FloorLayout[] = (proposal.layouts ?? []).flatMap((layout): FloorLayout[] => {
    const nodeId = layout.nodeType === 'system'
      ? proposalId(layout.nodeKey)
      : `proposal-file:${proposal.id}:${layout.nodeKey}`
    if (layout.nodeType === 'file' && !membershipById.has(layout.nodeKey)) return []
    const parentNodeId = layout.parentRefType === 'proposed_system'
      ? proposalId(layout.parentRefId)
      : layout.parentRefType === 'live_system'
        ? layout.parentRefId
        : proposal.parentScopeType === 'system'
          ? proposal.parentScopeId ?? null
          : null
    return [{
      workspaceId: proposal.workspaceId,
      nodeId,
      nodeType: layout.nodeType,
      parentNodeId,
      parentNodeType: parentNodeId ? 'system' : null,
      containmentKind: parentNodeId ? 'part_of' : 'root',
      positionX: layout.positionX,
      positionY: layout.positionY,
      width: layout.width,
      height: layout.height,
      scale: layout.scale,
      interiorScale: layout.interiorScale,
      updatedAt: layout.updatedAt ?? proposal.createdAt ?? 0,
    }]
  })

  return { systems, files, layouts }
}
