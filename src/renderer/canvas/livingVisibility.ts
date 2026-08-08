import type { Node } from '@xyflow/react'
import type { LivingInspectionWindow, NodeFx } from './sceneTypes.ts'

export type NodeFxById = Record<string, NodeFx>

function isVisible(node: Node): boolean {
  if (node.hidden) return false
  const opacity = Number(node.style?.opacity ?? 1)
  return Number.isFinite(opacity) ? opacity > 0.1 : true
}

export interface LivingVisibilityOptions {
  /** Canonical graph ancestry, independent of React Flow presentation parentId. */
  semanticParentById?: ReadonlyMap<string, string | null>
  /** Stable display labels used when hidden activity is surfaced by an ancestor. */
  labelById?: ReadonlyMap<string, string>
}

/**
 * Resolves a semantic node to the nearest ancestor that is actually visible at
 * the current zoom. Canonical ancestry remains available even when a sheet
 * flattens React Flow parentIds or a display projection omits the origin node.
 */
export function livingVisibilityIndex(nodes: Node[], options: LivingVisibilityOptions = {}): {
  visibleNodeId: (id: string) => string | null
} {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const cache = new Map<string, string | null>()

  const visibleNodeId = (startId: string): string | null => {
    const cached = cache.get(startId)
    if (cached !== undefined) return cached

    const visited: string[] = []
    let id: string | undefined = startId
    const seen = new Set<string>()
    let resolved: string | null = null
    while (id && !seen.has(id)) {
      seen.add(id)
      visited.push(id)
      const node = byId.get(id)
      if (node && isVisible(node)) {
        resolved = id
        break
      }
      id = options.semanticParentById?.get(id) ?? node?.parentId
    }
    for (const visitedId of visited) cache.set(visitedId, resolved)
    return resolved
  }

  return { visibleNodeId }
}

function surfacedKind(kind: NodeFx['kind']): NodeFx['kind'] {
  if (kind === 'enter' || kind === 'flow-add') return 'surface-add'
  if (kind === 'exit' || kind === 'flow-remove') return 'surface-remove'
  return 'surface-update'
}

function sameNodeFx(left: NodeFx | null | undefined, right: NodeFx | null): boolean {
  if (!left || !right) return left == null && right == null
  if (left.key !== right.key || left.kind !== right.kind || left.count !== right.count) return false
  const leftIds = left.originIds ?? []
  const rightIds = right.originIds ?? []
  const leftLabels = left.originLabels ?? []
  const rightLabels = right.originLabels ?? []
  return leftIds.length === rightIds.length &&
    leftLabels.length === rightLabels.length &&
    leftIds.every((value, index) => value === rightIds[index]) &&
    leftLabels.every((value, index) => value === rightLabels[index])
}

function nodeDimension(node: Node, axis: 'width' | 'height'): number {
  const value = Number(node.measured?.[axis] ?? node.style?.[axis] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function localRectWithinAncestor(
  origin: Node,
  ancestorId: string,
  byId: ReadonlyMap<string, Node>,
): Pick<LivingInspectionWindow, 'x' | 'y' | 'width' | 'height'> | null {
  let x = origin.position?.x ?? 0
  let y = origin.position?.y ?? 0
  let parentId = origin.parentId
  const seen = new Set<string>([origin.id])
  while (parentId && parentId !== ancestorId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) return null
    x += parent.position?.x ?? 0
    y += parent.position?.y ?? 0
    parentId = parent.parentId
  }
  if (parentId !== ancestorId) return null
  return {
    x,
    y,
    width: nodeDimension(origin, 'width'),
    height: nodeDimension(origin, 'height'),
  }
}

function sameWindows(
  left: LivingInspectionWindow[] | undefined,
  right: LivingInspectionWindow[] | undefined,
): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((window, index) => {
    const other = b[index]
    return window.key === other.key &&
      window.originId === other.originId &&
      window.x === other.x &&
      window.y === other.y &&
      window.width === other.width &&
      window.height === other.height
  })
}

/**
 * Stamps each activity event onto its real node when visible, otherwise onto
 * the nearest visible semantic container. The newest event wins when several
 * hidden descendants surface on the same container during one burst.
 */
export function surfaceLivingNodeFx(
  nodes: Node[],
  directFx: NodeFxById,
  options: LivingVisibilityOptions = {},
  revealIds: ReadonlySet<string> = new Set(Object.keys(directFx)),
): Node[] {
  const visibility = livingVisibilityIndex(nodes, options)
  const resolved = new Map<string, NodeFx>()
  const byId = new Map(nodes.map(node => [node.id, node]))
  const windowsBySystem = new Map<string, LivingInspectionWindow[]>()

  for (const [originId, fx] of Object.entries(directFx)) {
    // If the actual semantic node is still part of the scene, reveal that
    // exact node at its authored position and size. Surfacing on an ancestor
    // is only a fallback for sheet projections that genuinely omit the origin.
    const originNode = byId.get(originId)
    if (originNode) {
      resolved.set(originId, fx)
      if (!isVisible(originNode)) {
        const ancestorId = visibility.visibleNodeId(originId)
        const localRect = ancestorId
          ? localRectWithinAncestor(originNode, ancestorId, byId)
          : null
        if (ancestorId && ancestorId !== originId && localRect) {
          const windows = windowsBySystem.get(ancestorId) ?? []
          windows.push({
            ...localRect,
            traceId: fx.traceId,
            key: fx.key,
            kind: fx.kind,
            originId,
          })
          windowsBySystem.set(ancestorId, windows)
        }
      }
      continue
    }
    const targetId = visibility.visibleNodeId(originId)
    if (!targetId) continue
    const previous = resolved.get(targetId)
    const nodeLabel = String(
      options.labelById?.get(originId) ??
      originId,
    )
    const originIds = [...(previous?.originIds ?? []), originId]
    const originLabels = [...(previous?.originLabels ?? []), nodeLabel]
    const previousIsNewer = !!previous && previous.key > fx.key
    const surfaced = {
      ...(previousIsNewer ? previous : fx),
      kind: previousIsNewer ? previous.kind : surfacedKind(fx.kind),
      key: Math.max(previous?.key ?? fx.key, fx.key),
      originIds,
      originLabels,
      count: originIds.length,
    }
    resolved.set(targetId, surfaced)
  }

  return nodes.map(node => {
    const fx = resolved.get(node.id) ?? null
    const previous = (node.data as Record<string, unknown>).fx as NodeFx | null | undefined
    const livingWindows = windowsBySystem.get(node.id)
    const previousWindows = (node.data as Record<string, unknown>).livingWindows as
      | LivingInspectionWindow[]
      | undefined
    const reveal = revealIds.has(node.id) && !isVisible(node)
    const wasRevealed = Boolean((node.data as Record<string, unknown>).livingReveal)
    if (sameNodeFx(previous, fx) &&
        sameWindows(previousWindows, livingWindows) &&
        reveal === wasRevealed) {
      return node
    }
    return {
      ...node,
      // Semantic zoom normally removes hidden descendants from React Flow's
      // render set. A live edit intentionally reveals its exact authored node
      // for the duration of the signal, then the base projection hides it
      // again when the signal expires.
      hidden: reveal ? false : node.hidden,
      zIndex: reveal ? Math.max(node.zIndex ?? 0, 9500) : node.zIndex,
      style: reveal
        ? {
            ...node.style,
            opacity: 1,
            pointerEvents: 'none',
            transition: 'none',
          }
        : node.style,
      data: { ...node.data, fx, livingReveal: reveal, livingWindows },
    }
  })
}

export function visibleLivingEndpoints(
  nodes: Node[],
  sourceId: string,
  targetId: string,
  options: LivingVisibilityOptions = {},
): { source: string; target: string } | null {
  const visibility = livingVisibilityIndex(nodes, options)
  const source = visibility.visibleNodeId(sourceId)
  const target = visibility.visibleNodeId(targetId)
  if (!source || !target || source === target) return null
  return { source, target }
}
