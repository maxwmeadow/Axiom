export interface SheetEditabilityInput {
  activeSheetId: string | null
  liveNodeIds: Iterable<string>
  activePlannedNodeIds: Iterable<string>
  activeLayoutNodeIds: Iterable<string>
}

/**
 * Every live node can acquire a sheet-local layout opinion on first move.
 * Planned nodes remain owned by their sheet, so only planned nodes belonging
 * to the active sheet are editable.
 */
export function sheetEditableNodeIds({
  activeSheetId,
  liveNodeIds,
  activePlannedNodeIds,
  activeLayoutNodeIds,
}: SheetEditabilityInput): Set<string> {
  if (!activeSheetId) return new Set()
  return new Set([
    ...liveNodeIds,
    ...activePlannedNodeIds,
    ...activeLayoutNodeIds,
  ])
}
