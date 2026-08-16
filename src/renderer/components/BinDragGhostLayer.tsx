import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { BASE_FILE_H, BASE_FILE_W, NODE_TYPES } from '../canvas/AxiomCanvas'
import {
  getBinGhost,
  registerBinGhostElement,
  subscribeBinGhost,
} from '../canvas/binDragGhost'

/**
 * The dragged node itself, riding above everything, between two canvases.
 *
 * Mounted once beside the Floor rather than inside it. The whole point is that
 * showing a ghost must not re-render the canvas that owns the drag - a
 * re-render mid-gesture is what used to strand the node on the cursor.
 *
 * It draws through the same `NODE_TYPES` registry the canvas uses, so this is
 * not a picture of the node: it is the node, rendered by its own component with
 * its own data.
 */
export function BinDragGhostLayer() {
  const ghost = useSyncExternalStore(subscribeBinGhost, getBinGhost, getBinGhost)
  if (!ghost) return null

  const { node, scale } = ghost
  const NodeComponent = NODE_TYPES[node.type ?? 'file'] as
    React.ComponentType<Record<string, unknown>> | undefined
  if (!NodeComponent) return null

  const width = Number(node.style?.width ?? node.measured?.width ?? BASE_FILE_W)
  const height = Number(node.style?.height ?? node.measured?.height ?? BASE_FILE_H)

  return createPortal(
    <div
      ref={registerBinGhostElement}
      className="axiom-bin-ghost"
      style={{
        width,
        height,
        transform: `translate(-50%, -50%) scale(${scale})`,
      }}
    >
      <NodeComponent
        {...node}
        data={node.data}
        selected={false}
        dragging
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        width={width}
        height={height}
      />
    </div>,
    document.body,
  )
}
