import { ReactFlowProvider } from '@xyflow/react'
import type { DbFile } from '../../shared/types'
import { AxiomCanvas } from '../canvas/AxiomCanvas'
import { FloatingWindow } from './FloatingWindow'

/**
 * The unsorted bin as a real canvas, in a window you can move and resize.
 *
 * The contents are the live Floor's own node types rendered by the same
 * component, so a file waiting to be sorted is something you can zoom into and
 * read rather than a summary of itself. That is what makes sorting a judgement
 * instead of a guess: you decide where a file goes by looking at it.
 */

interface BinCanvasWindowProps {
  workspaceId: string
  files: readonly DbFile[]
  onClose: () => void
}

export function BinCanvasWindow({ workspaceId, files, onClose }: BinCanvasWindowProps) {
  return (
    <FloatingWindow
      className="axiom-bin-window"
      dataAttribute="data-bin-window"
      title="Unsorted"
      subtitle={files.length === 0
        ? 'Nothing waiting'
        : `${files.length} file${files.length === 1 ? '' : 's'} with no system`}
      onClose={onClose}
      footer="Zoom in to read a file. Drag one onto a system to place it."
    >
      {files.length === 0 ? (
        <p className="axiom-bin-window__empty">
          Every indexed file belongs somewhere. Drag one in here to take it back out.
        </p>
      ) : (
        <ReactFlowProvider>
          <AxiomCanvas binScene={{ workspaceId, files }} />
        </ReactFlowProvider>
      )}
    </FloatingWindow>
  )
}
