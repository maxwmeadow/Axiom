import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore, useStoreApi, type NodeChange } from '@xyflow/react'
import {
  authoritativeResizeDimension,
  clientPointToFlow,
  floatingResizeGeometry,
  resizeChromeGeometry,
  type FloatingResizeDirection,
  type NodeResizeParams,
} from '../resizeGeometry'
import { traceResizeEnd, traceResizeStart, traceResizeStep } from './resizeChrome'
import { scaleSelectionRects, type SelectionMember } from '../selectionResize'
import { contentRectFor } from '../frameGeometry'

type HorizontalSide = 'left' | 'right' | null
type VerticalSide = 'top' | 'bottom' | null

/** Floor under which a scaled selection member may not shrink. */
const MIN_SELECTION_MEMBER_PX = 24

interface ResizeDirection extends FloatingResizeDirection {
  name: string
  horizontal: HorizontalSide
  vertical: VerticalSide
  xFactor: number
  yFactor: number
  cursor: CSSProperties['cursor']
}

const DIRECTIONS: readonly ResizeDirection[] = [
  { name: 'top-left',     horizontal: 'left',  vertical: 'top',    xFactor: 0,   yFactor: 0,   cursor: 'nwse-resize' },
  { name: 'top',          horizontal: null,    vertical: 'top',    xFactor: 0.5, yFactor: 0,   cursor: 'ns-resize' },
  { name: 'top-right',    horizontal: 'right', vertical: 'top',    xFactor: 1,   yFactor: 0,   cursor: 'nesw-resize' },
  { name: 'right',        horizontal: 'right', vertical: null,     xFactor: 1,   yFactor: 0.5, cursor: 'ew-resize' },
  { name: 'bottom-right', horizontal: 'right', vertical: 'bottom', xFactor: 1,   yFactor: 1,   cursor: 'nwse-resize' },
  { name: 'bottom',       horizontal: null,    vertical: 'bottom', xFactor: 0.5, yFactor: 1,   cursor: 'ns-resize' },
  { name: 'bottom-left',  horizontal: 'left',  vertical: 'bottom', xFactor: 0,   yFactor: 1,   cursor: 'nesw-resize' },
  { name: 'left',         horizontal: 'left',  vertical: null,     xFactor: 0,   yFactor: 0.5, cursor: 'ew-resize' },
]

interface ResizeSession {
  pointerId: number
  direction: ResizeDirection
  startClientX: number
  startClientY: number
  startFlowX: number
  startFlowY: number
  usesFlowCoordinates: boolean
  zoom: number
  start: NodeResizeParams
  last: NodeResizeParams
  childStarts: Map<string, { x: number; y: number }>
  /** Other selected nodes sharing this node's parent, captured at gesture start. */
  selectionStarts: SelectionMember[]
  /** Minima resolved for THIS gesture's handle. */
  minWidth: number
  minHeight: number
  /** Largest this node may grow, after clamping to its parent frame. */
  maxWidth: number
  maxHeight: number
  handle: SVGGElement
  nodeElement: HTMLElement | null
  lastPointerEvent: PointerEvent
  cleanup: () => void
  cancel: () => void
}

export interface AxiomNodeResizerProps {
  nodeId: string
  isVisible: boolean
  presentationScale: number
  nodeWidth?: number | null
  nodeHeight?: number | null
  color: string
  isResizable?: boolean
  minWidth?: number
  minHeight?: number
  /** West/north handles move the origin and need their own minima. */
  minWidthWest?: number
  minHeightNorth?: number
  maxWidth?: number
  maxHeight?: number
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
}

const safePositive = (value: number | undefined | null, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const geometryChanged = (left: NodeResizeParams, right: NodeResizeParams): boolean =>
  left.x !== right.x || left.y !== right.y || left.width !== right.width || left.height !== right.height

function findNodeElement(root: HTMLElement | null | undefined, nodeId: string): HTMLElement | null {
  if (!root) return null
  for (const element of root.querySelectorAll<HTMLElement>('.react-flow__node')) {
    if (element.dataset.id === nodeId) return element
  }
  return null
}

function traceEvent(event: PointerEvent, target: Element): unknown {
  return {
    sourceEvent: {
      clientX: event.clientX,
      clientY: event.clientY,
      movementX: event.movementX,
      movementY: event.movementY,
      pointerType: event.pointerType,
      target,
      getCoalescedEvents: typeof event.getCoalescedEvents === 'function'
        ? () => event.getCoalescedEvents()
        : undefined,
    },
  }
}

/**
 * Floating-point replacement for XYFlow's NodeResizer.
 *
 * Pointer tracking is owned for the full window lifetime of the gesture. This
 * avoids orphaned sessions when a selected node rerenders, capture is lost, or
 * Chromium cancels a pointer. Geometry remains in floating-point flow units,
 * preserving one-screen-pixel precision at 100x zoom.
 */
export function AxiomNodeResizer({
  nodeId,
  isVisible,
  presentationScale,
  nodeWidth,
  nodeHeight,
  color,
  isResizable = true,
  minWidth = 1,
  minHeight = 1,
  minWidthWest,
  minHeightNorth,
  maxWidth = Number.MAX_VALUE,
  maxHeight = Number.MAX_VALUE,
  onResizeStart,
  onResizeEnd,
}: AxiomNodeResizerProps) {
  const store = useStoreApi()
  const sessionRef = useRef<ResizeSession | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const diagnosticSignatureRef = useRef('')
  const scale = safePositive(presentationScale, 1)
  const viewportZoom = useStore(state => state.transform[2])
  const chrome = resizeChromeGeometry()
  const inverseViewportZoom = 1 / safePositive(viewportZoom, 1)

  const flowPointForClient = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const state = store.getState()
    const rect = state.domNode?.getBoundingClientRect()
    if (!rect) return null
    const zoom = safePositive(state.transform[2], 1)
    return clientPointToFlow(
      { x: clientX, y: clientY },
      {
        viewportX: state.transform[0],
        viewportY: state.transform[1],
        zoom,
        paneLeft: rect.left,
        paneTop: rect.top,
      },
    )
  }, [store])

  const geometryForPointer = useCallback((session: ResizeSession, clientX: number, clientY: number): NodeResizeParams => {
    const currentFlow = session.usesFlowCoordinates ? flowPointForClient(clientX, clientY) : null
    const delta = currentFlow
      ? { x: currentFlow.x - session.startFlowX, y: currentFlow.y - session.startFlowY }
      : { x: clientX - session.startClientX, y: clientY - session.startClientY }
    return floatingResizeGeometry(
      session.start,
      session.direction,
      delta,
      currentFlow ? 1 : session.zoom,
      {
        minWidth: session.minWidth,
        minHeight: session.minHeight,
        maxWidth: session.maxWidth,
        maxHeight: session.maxHeight,
      },
    )
  }, [flowPointForClient, maxHeight, maxWidth, minHeight, minWidth])

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
    // The rest of the selection rides the same transform, so a multi-selection
    // resizes as one frame instead of only the node under the pointer.
    if (session.selectionStarts.length > 0) {
      for (const member of scaleSelectionRects(
        session.start,
        next,
        session.selectionStarts,
        { minWidth: MIN_SELECTION_MEMBER_PX, minHeight: MIN_SELECTION_MEMBER_PX },
      )) {
        changes.push({
          id: member.id,
          type: 'position',
          position: { x: member.x, y: member.y },
          dragging: false,
        })
        changes.push({
          id: member.id,
          type: 'dimensions',
          dimensions: { width: member.width, height: member.height },
          resizing,
          setAttributes: true,
        })
      }
    }
    store.getState().triggerNodeChanges(changes)
    session.last = next
  }, [nodeId, store])

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGGElement>, direction: ResizeDirection) => {
    if (!isResizable || event.button !== 0 || sessionRef.current) return
    const state = store.getState()
    const node = state.nodeLookup.get(nodeId)
    if (!node) return

    // React Flow's ResizeObserver records offsetWidth/offsetHeight in
    // `measured`, which are integer CSS layout units. At extreme canvas zoom,
    // starting from those integers makes the first pointer sample jump from the
    // visible controlled size to the rounded measured size. The controlled
    // dimensions are the geometry actually painted by NodeWrapper; measured is
    // only a fallback for nodes that do not author an explicit size.
    const width = authoritativeResizeDimension({
      controlled: node.width,
      styled: Number(node.style?.width),
      rendered: nodeWidth,
      measured: node.measured.width,
    })
    const height = authoritativeResizeDimension({
      controlled: node.height,
      styled: Number(node.style?.height),
      rendered: nodeHeight,
      measured: node.measured.height,
    })
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return

    event.preventDefault()
    event.stopPropagation()

    const handle = event.currentTarget
    const nodeElement = findNodeElement(state.domNode, nodeId)
    const start: NodeResizeParams = {
      x: Number.isFinite(node.position.x) ? node.position.x : 0,
      y: Number.isFinite(node.position.y) ? node.position.y : 0,
      width,
      height,
    }
    const childStarts = new Map<string, { x: number; y: number }>()
    for (const [candidateId, candidate] of state.nodeLookup) {
      if (candidate.parentId === nodeId) childStarts.set(candidateId, { ...candidate.position })
    }

    // A multi-selection resizes as one frame. Only members sharing this
    // node's parent can be transformed by the same map, since a node parented
    // elsewhere measures its position against a different origin.
    const selectionStarts: SelectionMember[] = []
    for (const [candidateId, candidate] of state.nodeLookup) {
      if (candidateId === nodeId || !candidate.selected) continue
      if ((candidate.parentId ?? null) !== (node.parentId ?? null)) continue
      const memberWidth = authoritativeResizeDimension({
        controlled: candidate.width,
        styled: Number(candidate.style?.width),
        rendered: undefined,
        measured: candidate.measured?.width,
      })
      const memberHeight = authoritativeResizeDimension({
        controlled: candidate.height,
        styled: Number(candidate.style?.height),
        rendered: undefined,
        measured: candidate.measured?.height,
      })
      if (!(memberWidth > 0) || !(memberHeight > 0)) continue
      selectionStarts.push({
        id: candidateId,
        x: candidate.position.x,
        y: candidate.position.y,
        width: memberWidth,
        height: memberHeight,
      })
    }

    // A child may not be resized outside the frame that owns it. Nothing was
    // passing a maximum, so a child could be grown far beyond its parent.
    // Absolute positions are used because they share one coordinate space
    // across nesting levels, unlike per-node scaled geometry.
    let boundedMaxWidth = safePositive(maxWidth, Number.MAX_VALUE)
    let boundedMaxHeight = safePositive(maxHeight, Number.MAX_VALUE)
    const parentInternal = node.parentId ? state.nodeLookup.get(node.parentId) : null
    if (parentInternal) {
      const parentAbsolute = parentInternal.internals.positionAbsolute
      const parentWidth = Number(parentInternal.style?.width ?? parentInternal.measured?.width ?? 0)
      const parentHeight = Number(parentInternal.style?.height ?? parentInternal.measured?.height ?? 0)
      // A system frame is not usable to its own edges: the tab and title band
      // occupy the top, and there is padding on the other three sides.
      //
      // Those insets are authored in CANONICAL frame units, while a rendered
      // parent's width/height are already multiplied by its world scale.
      // Feeding the scaled box straight into contentRect applied unscaled
      // padding to scaled geometry, inflating every inset - which is why the
      // node stopped far short of edges it could plainly be dragged to. Take
      // the content box in canonical units, then scale it, exactly as the drop
      // planner does for the same frame.
      const parentData = parentInternal.data as Record<string, unknown> | undefined
      const parentScale = safePositive(Number(parentData?.worldScale), 1)
      // Tab-aware, and identical to what the drop planner and the resize
      // minimum compute for this same frame. The flat header default used here
      // before disagreed with both, so a node could be dragged into a band a
      // resize refused to enter.
      const canonicalContent = contentRectFor(
        { width: parentWidth / parentScale, height: parentHeight / parentScale },
        Number(parentData?.depth ?? 0),
        parentScale,
      )
      const parentContent = {
        x: canonicalContent.x * parentScale,
        y: canonicalContent.y * parentScale,
        width: canonicalContent.width * parentScale,
        height: canonicalContent.height * parentScale,
      }
      const selfAbsolute = node.internals.positionAbsolute
      if (parentWidth > 0 && parentHeight > 0) {
        // West/north handles move the origin, so their headroom is measured
        // from the fixed far edge instead of the moving near edge.
        const growsWest = direction.horizontal === 'left'
        const growsNorth = direction.vertical === 'top'
        const contentLeft = parentAbsolute.x + parentContent.x
        const contentTop = parentAbsolute.y + parentContent.y
        const roomX = growsWest
          ? (selfAbsolute.x + width) - contentLeft
          : (contentLeft + parentContent.width) - selfAbsolute.x
        const roomY = growsNorth
          ? (selfAbsolute.y + height) - contentTop
          : (contentTop + parentContent.height) - selfAbsolute.y
        if (roomX > 0) boundedMaxWidth = Math.min(boundedMaxWidth, roomX)
        if (roomY > 0) boundedMaxHeight = Math.min(boundedMaxHeight, roomY)
      }
    }

    const startFlow = flowPointForClient(event.clientX, event.clientY)
    const session: ResizeSession = {
      pointerId: event.pointerId,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startFlowX: startFlow?.x ?? event.clientX / safePositive(state.transform[2], 1),
      startFlowY: startFlow?.y ?? event.clientY / safePositive(state.transform[2], 1),
      usesFlowCoordinates: !!startFlow,
      zoom: safePositive(state.transform[2], 1),
      start,
      last: start,
      childStarts,
      selectionStarts,
      maxWidth: boundedMaxWidth,
      maxHeight: boundedMaxHeight,
      // A west handle walks the origin toward the children, so it is bounded by
      // how far the origin may travel - not by the east minimum, which is
      // measured from an origin this handle is moving.
      minWidth: direction.horizontal === 'left'
        ? safePositive(minWidthWest ?? minWidth, 1)
        : safePositive(minWidth, 1),
      minHeight: direction.vertical === 'top'
        ? safePositive(minHeightNorth ?? minHeight, 1)
        : safePositive(minHeight, 1),
      handle,
      nodeElement,
      lastPointerEvent: event.nativeEvent,
      cleanup: () => {},
      cancel: () => {},
    }

    const finish = (pointerEvent: PointerEvent, usePointerGeometry: boolean) => {
      if (sessionRef.current !== session) return
      session.lastPointerEvent = pointerEvent
      const next = usePointerGeometry
        ? geometryForPointer(session, pointerEvent.clientX, pointerEvent.clientY)
        : session.last

      // Tear down first: triggerNodeChanges can synchronously rerender or
      // unmount the node, and no listener may survive that state transition.
      sessionRef.current = null
      session.cleanup()
      nodeElement?.classList.remove('axiom-resizing')
      if (handle.hasPointerCapture(session.pointerId)) {
        try { handle.releasePointerCapture(session.pointerId) } catch { /* capture was already revoked */ }
      }

      if (geometryChanged(session.last, next)) emitGeometry(session, next, true)
      // Always emit the terminal false state, including pointercancel, blur,
      // and a press/release with no movement.
      emitGeometry(session, next, false)
      traceResizeEnd(traceEvent(pointerEvent, handle), next, nodeId)
      onResizeEnd?.(next)
    }

    const onPointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== session.pointerId || sessionRef.current !== session) return
      session.lastPointerEvent = pointerEvent
      if (pointerEvent.pointerType !== 'touch' && (pointerEvent.buttons & 1) === 0) {
        finish(pointerEvent, false)
        return
      }
      pointerEvent.preventDefault()
      const next = geometryForPointer(session, pointerEvent.clientX, pointerEvent.clientY)
      traceResizeStep(traceEvent(pointerEvent, handle), next, nodeId)
      if (geometryChanged(session.last, next)) emitGeometry(session, next, true)
    }
    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === session.pointerId) finish(pointerEvent, true)
    }
    const onPointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === session.pointerId) finish(pointerEvent, false)
    }
    const onLostPointerCapture = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === session.pointerId) finish(pointerEvent, false)
    }
    const onWindowBlur = () => finish(session.lastPointerEvent, false)

    session.cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerCancel, true)
      window.removeEventListener('blur', onWindowBlur)
      handle.removeEventListener('lostpointercapture', onLostPointerCapture)
    }
    session.cancel = () => finish(session.lastPointerEvent, false)
    sessionRef.current = session

    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('blur', onWindowBlur)
    handle.addEventListener('lostpointercapture', onLostPointerCapture)
    nodeElement?.classList.add('axiom-resizing')
    try { handle.setPointerCapture(event.pointerId) } catch { /* window listeners remain authoritative */ }

    traceResizeStart(traceEvent(event.nativeEvent, handle), start, nodeId, scale)
    onResizeStart?.(start)
  }, [emitGeometry, flowPointForClient, geometryForPointer, isResizable, nodeHeight, nodeId, nodeWidth, onResizeEnd, onResizeStart, scale, store])

  useEffect(() => () => sessionRef.current?.cancel(), [])
  useEffect(() => {
    if (!isVisible || !isResizable) sessionRef.current?.cancel()
  }, [isResizable, isVisible])

  useLayoutEffect(() => {
    if (!isVisible) return
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current
      const handle = root?.querySelector<SVGGElement>('.axiom-floating-resize-handle')
      const visual = handle?.firstElementChild as SVGGraphicsElement | null
      const nodeElement = findNodeElement(store.getState().domNode, nodeId)
      if (!root || !handle || !visual || !nodeElement) return
      const rootRect = root.getBoundingClientRect()
      const handleRect = handle.getBoundingClientRect()
      const visualRect = visual.getBoundingClientRect()
      const nodeRect = nodeElement.getBoundingClientRect()
      const internal = store.getState().nodeLookup.get(nodeId)
      const signature = [
        viewportZoom.toFixed(4), nodeRect.width.toFixed(2), nodeRect.height.toFixed(2),
        handleRect.width.toFixed(2), visualRect.width.toFixed(2),
      ].join('|')
      if (signature === diagnosticSignatureRef.current) return
      diagnosticSignatureRef.current = signature
      const suspicious = visualRect.width < 4 || visualRect.width > 24 ||
        handleRect.width < 10 || handleRect.width > 36 ||
        Math.abs(rootRect.width - nodeRect.width) > 1 || Math.abs(rootRect.height - nodeRect.height) > 1
      if (!suspicious) return
      console.warn(
        `[AxiomResizeChromeSummary] node=${nodeId} zoom=${viewportZoom} ` +
        `node=${nodeRect.width.toFixed(2)}x${nodeRect.height.toFixed(2)} ` +
        `visual=${visualRect.width.toFixed(2)}x${visualRect.height.toFixed(2)} ` +
        `hit=${handleRect.width.toFixed(2)}x${handleRect.height.toFixed(2)}`,
      )
      console.warn('[AxiomResizeChromeDiagnostic]', {
        nodeId,
        viewportZoom,
        presentationScale,
        nodeProps: { width: nodeWidth, height: nodeHeight },
        localChrome: chrome,
        expectedScreenPx: { outline: 1, handle: 8, hitTarget: 18 },
        screenRects: {
          node: { x: nodeRect.x, y: nodeRect.y, width: nodeRect.width, height: nodeRect.height },
          root: { x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height },
          hitTarget: { x: handleRect.x, y: handleRect.y, width: handleRect.width, height: handleRect.height },
          visualHandle: { x: visualRect.x, y: visualRect.y, width: visualRect.width, height: visualRect.height },
        },
        inlineStyles: {
          node: nodeElement.getAttribute('style'),
          hitTarget: handle.getAttribute('style'),
          visualHandle: visual.getAttribute('style'),
        },
        computedStyles: {
          node: { width: getComputedStyle(nodeElement).width, height: getComputedStyle(nodeElement).height, transform: getComputedStyle(nodeElement).transform },
          hitTarget: { width: getComputedStyle(handle).width, height: getComputedStyle(handle).height, minWidth: getComputedStyle(handle).minWidth, minHeight: getComputedStyle(handle).minHeight },
          visualHandle: { width: getComputedStyle(visual).width, height: getComputedStyle(visual).height, minWidth: getComputedStyle(visual).minWidth, minHeight: getComputedStyle(visual).minHeight },
        },
        reactFlowNode: internal ? {
          measured: internal.measured,
          position: internal.position,
          style: internal.style,
          width: internal.width,
          height: internal.height,
        } : null,
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [chrome, isVisible, nodeHeight, nodeId, nodeWidth, presentationScale, store, viewportZoom])

  if (!isVisible) return null

  const hitSize = chrome.hitSize * inverseViewportZoom
  const handleSize = chrome.handleSize * inverseViewportZoom
  const handleInset = handleSize * 0.22
  const innerHandleSize = handleSize - handleInset * 2

  return (
    <div
      ref={rootRef}
      className="axiom-node-resizer"
      data-viewport-zoom={viewportZoom}
      data-node-id={nodeId}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 4,
        pointerEvents: 'none',
      }}
    >
      {/* A single SVG stroke cannot open seams at the corners like four
          independently rounded and rasterized HTML lines can. */}
      <svg
        aria-hidden="true"
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
      >
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="none"
          stroke={color}
          strokeWidth={chrome.strokeWidth * inverseViewportZoom}
          shapeRendering="geometricPrecision"
        />
        {isResizable && DIRECTIONS.map(direction => {
          const anchorX = `${direction.xFactor * 100}%`
          const anchorY = `${direction.yFactor * 100}%`
          return (
            <g
              key={direction.name}
              className={`axiom-floating-resize-handle nodrag nopan ${direction.vertical ?? ''} ${direction.horizontal ?? ''}`}
              data-resize-direction={direction.name}
              onPointerDown={event => onPointerDown(event, direction)}
              onClick={event => { event.preventDefault(); event.stopPropagation() }}
              style={{ cursor: direction.cursor, pointerEvents: 'all', touchAction: 'none' }}
            >
              <rect
                x={anchorX}
                y={anchorY}
                width={handleSize}
                height={handleSize}
                rx={handleSize * 0.18}
                fill="#fff"
                transform={`translate(${-handleSize / 2} ${-handleSize / 2})`}
                pointerEvents="none"
              />
              <rect
                x={anchorX}
                y={anchorY}
                width={innerHandleSize}
                height={innerHandleSize}
                rx={innerHandleSize * 0.12}
                fill={color}
                transform={`translate(${-innerHandleSize / 2} ${-innerHandleSize / 2})`}
                pointerEvents="none"
              />
              <rect
                x={anchorX}
                y={anchorY}
                width={hitSize}
                height={hitSize}
                fill="transparent"
                transform={`translate(${-hitSize / 2} ${-hitSize / 2})`}
                pointerEvents="all"
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
