import { useCallback, useMemo } from 'react'
import type { DbFile, DbSystem, FloorLayout } from '../../shared/types'
import { AxiomCanvas } from '../canvas/AxiomCanvas'
import { buildProposalPreviewModel } from '../canvas/proposalPreview'
import { useProposalStore, type ProposalLayout, type ProposalSummary } from '../store/architectureProposalStore'

const systemNodeId = (proposalId: string, systemKey: string) =>
  `proposal:${proposalId}:${systemKey}`

const fileNodeId = (proposalId: string, membershipId: string) =>
  `proposal-file:${proposalId}:${membershipId}`

/**
 * Data adapter only. The rendered surface and every interaction are the real
 * AxiomCanvas; this component translates proposal keys at the persistence
 * boundary so unapproved nodes cannot enter the live Floor store.
 */
export function ProposalReviewCanvas({
  proposal,
  indexedSystems,
  indexedFiles,
  indexedLayouts,
}: {
  proposal: ProposalSummary
  indexedSystems: readonly DbSystem[]
  indexedFiles: readonly DbFile[]
  indexedLayouts: readonly FloorLayout[]
}) {
  const model = useMemo(
    () => buildProposalPreviewModel(proposal, indexedSystems, indexedFiles),
    [proposal, indexedSystems, indexedFiles],
  )
  const previewLayouts = useProposalStore(state => state.previewLayouts)
  const saveLayouts = useProposalStore(state => state.saveLayouts)
  const selectedSystemKey = useProposalStore(state => state.selectedSystemKey)
  const selectSystem = useProposalStore(state => state.selectSystem)

  const systemKeyByNodeId = useMemo(() => new Map(proposal.systems.map(system => [
    systemNodeId(proposal.id, system.systemKey), system.systemKey,
  ])), [proposal.id, proposal.systems])
  const membershipByNodeId = useMemo(() => new Map(proposal.memberships.map(membership => [
    fileNodeId(proposal.id, membership.id), membership,
  ])), [proposal.id, proposal.memberships])
  const pendingKeys = useMemo(() => new Set(proposal.systems
    .filter(system => system.decision === 'pending')
    .map(system => system.systemKey)), [proposal.systems])
  const editableNodeIds = useMemo(() => new Set([
    ...[...systemKeyByNodeId].filter(([, key]) => pendingKeys.has(key)).map(([id]) => id),
    ...[...membershipByNodeId]
      .filter(([, membership]) => pendingKeys.has(membership.targetSystemKey))
      .map(([id]) => id),
  ]), [systemKeyByNodeId, membershipByNodeId, pendingKeys])

  const floorLayouts = useMemo(() => {
    const modelIds = new Set([
      ...model.systems.map(system => system.id),
      ...model.files.map(file => file.id),
    ])
    const live = indexedLayouts.filter(layout => modelIds.has(layout.nodeId))
    const proposedKeys = new Set(model.layouts.map(layout => `${layout.nodeType}:${layout.nodeId}`))
    return [
      ...live.filter(layout => !proposedKeys.has(`${layout.nodeType}:${layout.nodeId}`)),
      ...model.layouts,
    ]
  }, [model, indexedLayouts])

  const onSelectNode = useCallback((nodeId: string | null) => {
    if (!nodeId) {
      selectSystem(null)
      return
    }
    selectSystem(
      systemKeyByNodeId.get(nodeId)
        ?? membershipByNodeId.get(nodeId)?.targetSystemKey
        ?? null,
    )
  }, [selectSystem, systemKeyByNodeId, membershipByNodeId])

  const translateLayouts = useCallback((
    updates: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>,
  ) => {
    const translated = updates.map((update): ProposalLayout | null => {
      const systemKey = systemKeyByNodeId.get(update.nodeId)
      const membership = membershipByNodeId.get(update.nodeId)
      if (!systemKey && !membership) return null
      const proposedParent = update.parentNodeId
        ? systemKeyByNodeId.get(update.parentNodeId)
        : undefined
      const isScope = !update.parentNodeId || (
        proposal.parentScopeType === 'system' && update.parentNodeId === proposal.parentScopeId
      )
      const parentRefType: ProposalLayout['parentRefType'] = isScope
        ? 'scope'
        : proposedParent
          ? 'proposed_system'
          : 'live_system'
      if (membership && parentRefType !== 'proposed_system') return null
      return {
        nodeType: systemKey ? 'system' : 'file',
        nodeKey: systemKey ?? membership!.id,
        parentRefType,
        parentRefId: parentRefType === 'scope'
          ? ''
          : proposedParent ?? update.parentNodeId ?? '',
        positionX: update.positionX,
        positionY: update.positionY,
        width: update.width,
        height: update.height,
        scale: update.scale,
        interiorScale: update.interiorScale,
      }
    })
    if (translated.some(layout => layout === null) ||
        updates.some(update => !editableNodeIds.has(update.nodeId))) {
      throw new Error('That gesture would modify an approved or live node.')
    }
    return translated as ProposalLayout[]
  }, [systemKeyByNodeId, membershipByNodeId, proposal.parentScopeType, proposal.parentScopeId, editableNodeIds])

  const onPreviewLayouts = useCallback((
    updates: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>,
  ) => {
    previewLayouts(translateLayouts(updates))
  }, [previewLayouts, translateLayouts])

  const onSaveLayouts = useCallback(async (
    updates: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>,
  ) => {
    await saveLayouts(translateLayouts(updates))
  }, [saveLayouts, translateLayouts])

  const reviewScene = useMemo(() => ({
    // Layout saves and branch decisions must not create a "new" camera scene.
    // The proposal is one review surface for its whole lifetime.
    id: `proposal:${proposal.id}`,
    workspaceId: proposal.workspaceId,
    systems: model.systems,
    files: model.files,
    floorLayouts,
    editableNodeIds,
    selectedNodeId: selectedSystemKey
      ? systemNodeId(proposal.id, selectedSystemKey)
      : null,
    onSelectNode,
    onPreviewLayouts,
    onSaveLayouts,
  }), [proposal.id, proposal.workspaceId, model, floorLayouts, editableNodeIds, selectedSystemKey, onSelectNode, onPreviewLayouts, onSaveLayouts])

  return <AxiomCanvas reviewScene={reviewScene} />
}
