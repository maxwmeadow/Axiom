import type { Node } from '@xyflow/react'

// A node reveals its contents once its on-screen geometric mean reaches this
// size. Keeping this size-relative makes semantic zoom independent of depth and
// of the world-space scale chosen by a layout.
export const REVEAL_CONTAINER_PX = 480

export function applyZoomVisibility(nodes: Node[], zoom: number): Node[] {
  const sortedNodes = [...nodes].sort((a, b) => {
    const aDepth = Number(a.data?.depth ?? 0)
    const bDepth = Number(b.data?.depth ?? 0)
    return aDepth - bDepth
  })

  const childrenVisibleByNode = new Map<string, number>()
  const updatedNodes = sortedNodes.map(node => {
    const selfVisibility = node.parentId
      ? (childrenVisibleByNode.get(node.parentId) ?? 0)
      : 1

    const worldWidth = Number(node.style?.width ?? node.measured?.width ?? 0)
    const worldHeight = Number(node.style?.height ?? node.measured?.height ?? 0)
    const measurable = worldWidth > 0 && worldHeight > 0
    const renderedSize = Math.sqrt(worldWidth * worldHeight) * zoom
    const childrenVisibility = selfVisibility
      * (!measurable || renderedSize >= REVEAL_CONTAINER_PX ? 1 : 0)

    childrenVisibleByNode.set(node.id, childrenVisibility)

    return {
      ...node,
      style: {
        ...node.style,
        opacity: selfVisibility,
        pointerEvents: selfVisibility > 0.1 ? ('all' as const) : ('none' as const),
        transition: 'opacity 0.25s ease-out',
      },
      data: {
        ...node.data,
        currentZoom: zoom,
        childrenVisible: childrenVisibility,
        selfScale: 0.92 + 0.08 * selfVisibility,
        selfBlur: (1 - selfVisibility) * 3,
      },
    }
  })

  const updatedById = new Map(updatedNodes.map(node => [node.id, node]))
  return nodes.map(node => updatedById.get(node.id) ?? node)
}

export function makeFullyVisible(node: Node): Node {
  return {
    ...node,
    style: { ...node.style, opacity: 1, pointerEvents: 'all' as const },
    data: { ...node.data, selfScale: 1, selfBlur: 0, childrenVisible: 1 },
  }
}
