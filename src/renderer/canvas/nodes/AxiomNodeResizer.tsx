import { useCallback, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useStoreApi, type NodeChange } from '@xyflow/react'
import { floatingResizeGeometry, type FloatingResizeDirection, type NodeResizeParams } from '../resizeGeometry'
import { traceResizeEnd, traceResizeStart, traceResizeStep } from './resizeChrome'

type HorizontalSide = 'left' | 'right' | null
type VerticalSide = 'top' | 'bottom' | null

interface ResizeDirection extends FloatingResizeDirection {
  name: string
  horizontal: HorizontalSide
  vertical: VerticalSide
  left: string
  top: string
  cursor: CSSProperties['cursor']
}

const DIRECTIONS: readonly ResizeDirection[] = [
  { name: 'top-left',     horizontal: 'left',  vertical: 'top',    left: '0%',   top: '0%',   cursor: 'nwse-resize' },
  { name: 'top',          horizontal: null,    vertical: 'top',    left: '50%',  top: '0%',   cursor: 'ns-resize' },
  { name: 'top-right',    horizontal: 'right', vertical: 'top',    left: '100%', top: '0%',   cursor: 'nesw-resize' },
  { name: 'right',        horizontal: 'right', vertical: null,     left: '100%', top: '50%',  cursor: 'ew-resize' },
  { name: 'bottom-right', horizontal: 'right', vertical: 'bottom', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { name: 'bottom',       horizontal: null,    vertical: 'bottom', left: '50%',  top: '100%', cursor: 'ns-resize' },
  { name: 'bottom-left',  horizontal: 'left',  vertical: 'bottom', left: '0%',   top: '100%', cursor: 'nesw-resize' },
  { name: 'left',         horizontal: 'left',  vertical: null,     left: '0%',   top: '50%',  cursor: 'ew-resize' },
]

interface ResizeSession {
  pointerId: number
  direction: ResizeDirection
  startClientX: number
  startClientY: number
  zoom: number
  start: NodeResizeParams
  last: NodeResizeParams
  childStarts: Map<string, { x: number; y: number }>
}

export interface AxiomNodeResizerProps {
  nodeId: string
  isVisible: boolean
  presentationScale: number
  color: string
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
}

const safePositive = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

function traceEvent(event: ReactPointerEvent<HTMLElement>, target: HTMLElement): unknown {
  const native = event.nativeEvent
  return {
    sourceEvent: {
      clientX: event.clientX,
      clientY: event.clientY,
      movementX: native.movementX,
      movementY: native.movementY,
      pointerType: native.pointerType,
      target,
      getCoalescedEvents: typeof native.getCoalescedEvents === 'function'
        ? () => native.getCoalescedEvents()
        : undefined,
    },
  }
}

/**
 * Floating-point replacement for XYFlow's NodeResizer.
 *
 * XYFlow floors pointer deltas in flow space. At 100x zoom that quantizes
 * every resize to 100 browser pixels. This controller performs the inverse
 * viewport transform without rounding and emits ordinary public NodeChange
 * records, preserving Axiom's controlled-node and persistence pipeline.
 */
export function AxiomNodeResizer({
  nodeId,
  isVisible,
  presentationScale,
  color,
  minWidth = 1,
  minHeight = 1,
  maxWidth = Number.MAX_VALUE,
  maxHeight = Number.MAX_VALUE,
  onResizeStart,
  onResizeEnd,
}: AxiomNodeResizerProps) {
  const store = useStoreApi()
  const sessionRef = useRef<ResizeSession | null>(null)
  const scale = safePositive(presentationScale, 1)
  const handleSize = 5 * scale
  const handleInset = 1 * scale
  const lineThickness = 1 * scale

  const geometryForPointer = useCallback((session: ResizeSession, clientX: number, clientY: number): NodeResizeParams => {
    return floatingResizeGeometry(
      session.start,
      session.direction,
      { x: clientX - session.startClientX, y: clientY - session.startClientY },
      session.zoom,
      {
        minWidth: safePositive(minWidth, 1),
        minHeight: safePositive(minHeight, 1),
        maxWidth: safePositive(maxWidth, Number.MAX_VALUE),
        maxHeight: safePositive(maxHeight, Number.MAX_VALUE),
      },
    )
  }, [maxHeight, maxWidth, minHeight, minWidth])

  const emitGeometry = useCallback((session: ResizeSession, next: NodeResizeParams, resizing: boolean) => {
    const changes: NodeChange[] = []
    if (next.x !== session.last.x || next.y !== session.last.y) {
      changes.push({ id: nodeId, type: 'position', position: { x: next.x, y: next.y }, dragging: false })
    }
    changes.push({
      id: nodeId,
      type: 'dimensions',
      dimensions: { width: next.width, height: next.height },
      resizing,
      setAttributes: true,
    })
    const originDeltaX = next.x - session.start.x
    const originDeltaY = next.y - session.start.y
    if (originDeltaX !== 0 || originDeltaY !== 0) {
      for (const [childId, childStart] of session.childStarts) {
        changes.push({
          id: childId,
          type: 'position',
          position: { x: childStart.x - originDeltaX, y: childStart.y - originDeltaY },
          dragging: false,
        })
      }
    }
    store.getState().triggerNodeChanges(changes)
    session.last = next
  }, [nodeId, store])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection) => {
    if (event.button !== 0) return
    const state = store.getState()
    const node = state.nodeLookup.get(nodeId)
    if (!node) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const start: NodeResizeParams = {
      x: node.position.x,
      y: node.position.y,
      width: node.measured.width ?? Number(node.style?.width ?? 0),
      height: node.measured.height ?? Number(node.style?.height ?? 0),
    }
    const childStarts = new Map<string, { x: number; y: number }>()
    for (const [candidateId, candidate] of state.nodeLookup) {
      if (candidate.parentId === nodeId) childStarts.set(candidateId, { ...candidate.position })
    }
    const session: ResizeSession = {
      pointerId: event.pointerId,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      zoom: safePositive(state.transform[2], 1),
      start,
      last: start,
      childStarts,
    }
    sessionRef.current = session
    traceResizeStart(traceEvent(event, event.currentTarget), start, nodeId, scale)
    onResizeStart?.(start)
  }, [nodeId, onResizeStart, scale, store])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const next = geometryForPointer(session, event.clientX, event.clientY)
    traceResizeStep(traceEvent(event, event.currentTarget), next, nodeId)
    if (next.x !== session.last.x || next.y !== session.last.y ||
        next.width !== session.last.width || next.height !== session.last.height) {
      emitGeometry(session, next, true)
    }
  }, [emitGeometry, geometryForPointer, nodeId])

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const next = geometryForPointer(session, event.clientX, event.clientY)
    if (next.x !== session.last.x || next.y !== session.last.y ||
        next.width !== session.last.width || next.height !== session.last.height) {
      emitGeometry(session, next, true)
    }
    emitGeometry(session, next, false)
    traceResizeEnd(traceEvent(event, event.currentTarget), next, nodeId)
    sessionRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onResizeEnd?.(next)
  }, [emitGeometry, geometryForPointer, nodeId, onResizeEnd])

  if (!isVisible) return null

  const lineBase: CSSProperties = {
    position: 'absolute',
    zIndex: 20,
    background: color,
    pointerEvents: 'none',
  }

  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' }}>
      <div style={{ ...lineBase, left: 0, top: 0, width: '100%', height: `${lineThickness}px`, transform: 'translateY(-50%)' }} />
      <div style={{ ...lineBase, left: 0, bottom: 0, width: '100%', height: `${lineThickness}px`, transform: 'translateY(50%)' }} />
      <div style={{ ...lineBase, left: 0, top: 0, width: `${lineThickness}px`, height: '100%', transform: 'translateX(-50%)' }} />
      <div style={{ ...lineBase, right: 0, top: 0, width: `${lineThickness}px`, height: '100%', transform: 'translateX(50%)' }} />
      {DIRECTIONS.map(direction => (
        <div
          key={direction.name}
          className={`axiom-floating-resize-handle nodrag nopan ${direction.vertical ?? ''} ${direction.horizontal ?? ''}`}
          data-resize-direction={direction.name}
          onPointerDown={event => onPointerDown(event, direction)}
          onPointerMove={onPointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          style={{
            position: 'absolute',
            zIndex: 21,
            left: direction.left,
            top: direction.top,
            width: `${handleSize}px`,
            height: `${handleSize}px`,
            minWidth: 0,
            minHeight: 0,
            padding: 0,
            border: 0,
            borderRadius: `${scale}px`,
            background: '#fff',
            boxSizing: 'border-box',
            transform: 'translate(-50%, -50%)',
            cursor: direction.cursor,
            pointerEvents: 'all',
            touchAction: 'none',
          }}
        >
          <span style={{ position: 'absolute', inset: `${handleInset}px`, borderRadius: `${0.25 * scale}px`, background: color, pointerEvents: 'none' }} />
        </div>
      ))}
    </div>
  )
}
