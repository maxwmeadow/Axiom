import type { CSSProperties } from 'react'
import type { NodeResizeParams } from '../resizeGeometry'

type ResizeTraceRow = Record<string, string | number | boolean | null>

type ResizeTraceSession = {
  id: number
  nodeId: string
  startedAt: number
  lastLiveLogAt: number
  presentationScale: number
  direction: string
  root: HTMLElement | null
  target: Element | null
  startClientX: number
  startClientY: number
  previousClientX: number
  previousClientY: number
  start: NodeResizeParams
  previous: NodeResizeParams
  rows: ResizeTraceRow[]
  frameRows: ResizeTraceRow[]
  frameRafId: number | null
}

let nextResizeTraceId = 0
const resizeTraceSessions = new Map<string, ResizeTraceSession>()

/** Shared NodeResizer contract: selection chrome follows node presentation. */
export function resizeChromeProps(scale: number) {
  // XYFlow may render controls outside the custom node's inherited style
  // scope, so computed lengths must be stamped directly on each control.
  // CSS cannot multiply a <length> by a custom-property number in Chromium;
  // doing that silently invalidates the declaration and restores XYFlow's 5px.
  const safeScale = Math.max(0.0001, scale)
  const handleStyle: CSSProperties = {
    width: `${5 * safeScale}px`,
    height: `${5 * safeScale}px`,
    borderWidth: `${safeScale}px`,
    borderRadius: `${safeScale}px`,
  }
  const lineStyle = { '--axiom-resize-stroke': `${safeScale}px` } as CSSProperties
  return {
    autoScale: false,
    handleClassName: 'axiom-resize-handle',
    lineClassName: 'axiom-resize-line',
    handleStyle,
    lineStyle,
  } as const
}

function sourcePointer(event: unknown): {
  clientX: number
  clientY: number
  movementX: number | null
  movementY: number | null
  coalescedEvents: number
  altKey: boolean
  target: Element | null
  d3X: number | null
  d3Y: number | null
  d3Dx: number | null
  d3Dy: number | null
} {
  const drag = event as {
    x?: number
    y?: number
    dx?: number
    dy?: number
    sourceEvent?: {
      clientX?: number
      clientY?: number
      movementX?: number
      movementY?: number
      target?: EventTarget | null
      getCoalescedEvents?: () => unknown[]
      altKey?: boolean
      touches?: ArrayLike<{ clientX: number; clientY: number }>
    }
  }
  const source = drag.sourceEvent
  const touch = source?.touches?.[0]
  return {
    clientX: source?.clientX ?? touch?.clientX ?? 0,
    clientY: source?.clientY ?? touch?.clientY ?? 0,
    movementX: typeof source?.movementX === 'number' ? source.movementX : null,
    movementY: typeof source?.movementY === 'number' ? source.movementY : null,
    coalescedEvents: typeof source?.getCoalescedEvents === 'function' ? source.getCoalescedEvents().length : 0,
    altKey: source?.altKey === true,
    target: source?.target instanceof Element ? source.target : null,
    d3X: typeof drag.x === 'number' ? drag.x : null,
    d3Y: typeof drag.y === 'number' ? drag.y : null,
    d3Dx: typeof drag.dx === 'number' ? drag.dx : null,
    d3Dy: typeof drag.dy === 'number' ? drag.dy : null,
  }
}

function viewportZoom(root: HTMLElement | null): number {
  const viewport = root?.querySelector<HTMLElement>('.react-flow__viewport')
    ?? document.querySelector<HTMLElement>('.react-flow__viewport')
  if (!viewport) return 1
  const transform = window.getComputedStyle(viewport).transform
  if (!transform || transform === 'none') return 1
  try {
    const matrix = new DOMMatrixReadOnly(transform)
    return Number.isFinite(matrix.a) && matrix.a > 0 ? matrix.a : 1
  } catch {
    const match = transform.match(/^matrix\(([^,]+)/)
    const parsed = match ? Number(match[1]) : 1
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  }
}

function resizeDirection(target: Element | null): string {
  if (!target) return 'unknown'
  return ['top', 'right', 'bottom', 'left'].filter(direction => target.classList.contains(direction)).join('-') || 'unknown'
}

function renderedFrame(session: ResizeTraceSession, timestamp: number): void {
  const node = session.target?.closest<HTMLElement>('.react-flow__node') ?? null
  const chrome = session.target?.closest<HTMLElement>('.axiom-node-resizer') ?? null
  const handle = session.target
  if (!node || !chrome || !handle) return

  const nodeRect = node.getBoundingClientRect()
  const chromeRect = chrome.getBoundingClientRect()
  const handleRect = handle.getBoundingClientRect()
  const computed = getComputedStyle(node)
  const previous = session.frameRows.at(-1)
  const zoom = viewportZoom(session.root)
  const handleCenterX = handleRect.left + handleRect.width / 2
  const handleCenterY = handleRect.top + handleRect.height / 2
  const expectedHandleX = session.direction.includes('left')
    ? nodeRect.left
    : session.direction.includes('right') ? nodeRect.right : nodeRect.left + nodeRect.width / 2
  const expectedHandleY = session.direction.includes('top')
    ? nodeRect.top
    : session.direction.includes('bottom') ? nodeRect.bottom : nodeRect.top + nodeRect.height / 2
  const previousNumber = (key: string): number | null => {
    const value = previous?.[key]
    return typeof value === 'number' ? value : null
  }
  const previousTime = previousNumber('tMs')
  const previousX = previousNumber('nodeScreenX')
  const previousY = previousNumber('nodeScreenY')
  const previousWidth = previousNumber('nodeScreenWidth')
  const previousHeight = previousNumber('nodeScreenHeight')

  session.frameRows.push({
    frame: session.frameRows.length + 1,
    tMs: timestamp - session.startedAt,
    frameGapMs: previousTime === null ? 0 : timestamp - session.startedAt - previousTime,
    latestPointerSample: session.rows.length,
    zoom,
    requestedXFlow: session.previous.x,
    requestedYFlow: session.previous.y,
    requestedWidthFlow: session.previous.width,
    requestedHeightFlow: session.previous.height,
    computedNodeWidthFlow: Number.parseFloat(computed.width),
    computedNodeHeightFlow: Number.parseFloat(computed.height),
    offsetNodeWidthIntegerFlow: node.offsetWidth,
    offsetNodeHeightIntegerFlow: node.offsetHeight,
    inlineNodeWidth: node.style.width || null,
    inlineNodeHeight: node.style.height || null,
    nodeScreenX: nodeRect.left,
    nodeScreenY: nodeRect.top,
    nodeScreenWidth: nodeRect.width,
    nodeScreenHeight: nodeRect.height,
    nodeScreenStepX: previousX === null ? 0 : nodeRect.left - previousX,
    nodeScreenStepY: previousY === null ? 0 : nodeRect.top - previousY,
    nodeScreenStepWidth: previousWidth === null ? 0 : nodeRect.width - previousWidth,
    nodeScreenStepHeight: previousHeight === null ? 0 : nodeRect.height - previousHeight,
    chromeLeftErrorScreen: chromeRect.left - nodeRect.left,
    chromeTopErrorScreen: chromeRect.top - nodeRect.top,
    chromeRightErrorScreen: chromeRect.right - nodeRect.right,
    chromeBottomErrorScreen: chromeRect.bottom - nodeRect.bottom,
    handleCenterX,
    handleCenterY,
    handleEdgeErrorXScreen: handleCenterX - expectedHandleX,
    handleEdgeErrorYScreen: handleCenterY - expectedHandleY,
  })
}

export function traceResizeStart(
  event: unknown,
  params: NodeResizeParams,
  nodeId: string,
  presentationScale: number,
): void {
  const pointer = sourcePointer(event)
  // Continuous DOM measurement is deliberately opt-in: getBoundingClientRect
  // on every animation frame forces layout and can itself make a resize feel
  // less fluid. Hold Alt while beginning a resize when a trace is needed.
  if (!pointer.altKey) return
  const target = pointer.target
  const root = target?.closest<HTMLElement>('.react-flow') ?? null
  const zoom = viewportZoom(root)
  const direction = resizeDirection(target)
  const session: ResizeTraceSession = {
    id: ++nextResizeTraceId,
    nodeId,
    startedAt: performance.now(),
    lastLiveLogAt: 0,
    presentationScale,
    direction,
    root,
    target,
    startClientX: pointer.clientX,
    startClientY: pointer.clientY,
    previousClientX: pointer.clientX,
    previousClientY: pointer.clientY,
    start: { ...params },
    previous: { ...params },
    rows: [],
    frameRows: [],
    frameRafId: null,
  }
  resizeTraceSessions.set(nodeId, session)
  const sampleFrame = (timestamp: number) => {
    if (resizeTraceSessions.get(nodeId) !== session) return
    renderedFrame(session, timestamp)
    session.frameRafId = requestAnimationFrame(sampleFrame)
  }
  session.frameRafId = requestAnimationFrame(sampleFrame)
  requestAnimationFrame(() => {
    const computed = target ? window.getComputedStyle(target) : null
    const rect = target?.getBoundingClientRect()
    console.info(`[AxiomResizeTrace #${session.id}] start`, {
      nodeId,
      direction,
      presentationScale,
      zoom,
      startGeometryFlowUnits: params,
      pointerClientCssPixels: { x: pointer.clientX, y: pointer.clientY },
      conversion: `1 browser CSS px = ${1 / zoom} React Flow units at ${zoom}x zoom`,
      devicePixelRatio: window.devicePixelRatio,
      handle: {
        className: target?.className ?? null,
        computedWidth: computed?.width ?? null,
        computedHeight: computed?.height ?? null,
        computedBorderWidth: computed?.borderWidth ?? null,
        screenWidthCssPixels: rect?.width ?? null,
        screenHeightCssPixels: rect?.height ?? null,
      },
    })
  })
}

export function traceResizeStep(event: unknown, params: NodeResizeParams, nodeId: string): void {
  const session = resizeTraceSessions.get(nodeId)
  if (!session) return
  const now = performance.now()
  const pointer = sourcePointer(event)
  const zoom = viewportZoom(session.root)
  const pointerStepX = pointer.clientX - session.previousClientX
  const pointerStepY = pointer.clientY - session.previousClientY
  const pointerTotalX = pointer.clientX - session.startClientX
  const pointerTotalY = pointer.clientY - session.startClientY
  const xStep = params.x - session.previous.x
  const yStep = params.y - session.previous.y
  const widthStep = params.width - session.previous.width
  const heightStep = params.height - session.previous.height
  const xTotal = params.x - session.start.x
  const yTotal = params.y - session.start.y
  const widthTotal = params.width - session.start.width
  const heightTotal = params.height - session.start.height
  const controlsLeft = session.direction.includes('left')
  const controlsRight = session.direction.includes('right')
  const controlsTop = session.direction.includes('top')
  const controlsBottom = session.direction.includes('bottom')
  const expectedXTotal = controlsLeft ? pointerTotalX / zoom : 0
  const expectedYTotal = controlsTop ? pointerTotalY / zoom : 0
  const expectedWidthTotal = controlsLeft ? -pointerTotalX / zoom : controlsRight ? pointerTotalX / zoom : 0
  const expectedHeightTotal = controlsTop ? -pointerTotalY / zoom : controlsBottom ? pointerTotalY / zoom : 0
  const horizontalTrackingError = controlsLeft
    ? xTotal - expectedXTotal
    : controlsRight ? widthTotal - expectedWidthTotal : 0
  const verticalTrackingError = controlsTop
    ? yTotal - expectedYTotal
    : controlsBottom ? heightTotal - expectedHeightTotal : 0
  const row: ResizeTraceRow = {
    sample: session.rows.length + 1,
    tMs: now - session.startedAt,
    direction: session.direction,
    zoom,
    flowUnitsPerCssPixel: 1 / zoom,
    clientX: pointer.clientX,
    clientY: pointer.clientY,
    pointerStepCssX: pointerStepX,
    pointerStepCssY: pointerStepY,
    pointerTotalCssX: pointerTotalX,
    pointerTotalCssY: pointerTotalY,
    pointerStepDeviceEstimateX: pointerStepX * window.devicePixelRatio,
    pointerStepDeviceEstimateY: pointerStepY * window.devicePixelRatio,
    movementX: pointer.movementX,
    movementY: pointer.movementY,
    coalescedEvents: pointer.coalescedEvents,
    d3X: pointer.d3X,
    d3Y: pointer.d3Y,
    d3Dx: pointer.d3Dx,
    d3Dy: pointer.d3Dy,
    expectedPointerStepFlowX: pointerStepX / zoom,
    expectedPointerStepFlowY: pointerStepY / zoom,
    x: params.x,
    y: params.y,
    width: params.width,
    height: params.height,
    xStepFlow: xStep,
    yStepFlow: yStep,
    widthStepFlow: widthStep,
    heightStepFlow: heightStep,
    xStepScreen: xStep * zoom,
    yStepScreen: yStep * zoom,
    widthStepScreen: widthStep * zoom,
    heightStepScreen: heightStep * zoom,
    xTotalFlow: xTotal,
    yTotalFlow: yTotal,
    widthTotalFlow: widthTotal,
    heightTotalFlow: heightTotal,
    expectedXTotalFlow: expectedXTotal,
    expectedYTotalFlow: expectedYTotal,
    expectedWidthTotalFlow: expectedWidthTotal,
    expectedHeightTotalFlow: expectedHeightTotal,
    horizontalTrackingErrorFlow: horizontalTrackingError,
    verticalTrackingErrorFlow: verticalTrackingError,
    horizontalTrackingErrorScreen: horizontalTrackingError * zoom,
    verticalTrackingErrorScreen: verticalTrackingError * zoom,
    stationaryRightEdgeErrorFlow: controlsLeft ? xTotal + widthTotal : 0,
    stationaryBottomEdgeErrorFlow: controlsTop ? yTotal + heightTotal : 0,
  }
  session.rows.push(row)
  session.previousClientX = pointer.clientX
  session.previousClientY = pointer.clientY
  session.previous = { ...params }
  if (now - session.lastLiveLogAt >= 250) {
    session.lastLiveLogAt = now
    console.debug(`[AxiomResizeTrace #${session.id}] live sample ${row.sample}`, row)
  }
}

export function traceResizeEnd(event: unknown, params: NodeResizeParams, nodeId: string): void {
  const session = resizeTraceSessions.get(nodeId)
  if (!session) return
  traceResizeStep(event, params, nodeId)
  const pointer = sourcePointer(event)
  if (session.frameRafId !== null) cancelAnimationFrame(session.frameRafId)

  // Capture the controlled React update and one subsequent paint before
  // reporting. Immediate pointer-up logging misses the exact frame where a
  // stale controlled node or persistence rebuild can snap the visuals.
  requestAnimationFrame(timestamp => {
    renderedFrame(session, timestamp)
    requestAnimationFrame(finalTimestamp => {
      renderedFrame(session, finalTimestamp)
      const zoom = viewportZoom(session.root)
      const numericSteps = (rows: ResizeTraceRow[], key: string) => rows
        .map(row => typeof row[key] === 'number' ? Math.abs(row[key] as number) : 0)
        .filter(value => value > Number.EPSILON)
      const flowSteps = [
        ...numericSteps(session.rows, 'xStepFlow'), ...numericSteps(session.rows, 'yStepFlow'),
        ...numericSteps(session.rows, 'widthStepFlow'), ...numericSteps(session.rows, 'heightStepFlow'),
      ]
      const requestedScreenSteps = [
        ...numericSteps(session.rows, 'xStepScreen'), ...numericSteps(session.rows, 'yStepScreen'),
        ...numericSteps(session.rows, 'widthStepScreen'), ...numericSteps(session.rows, 'heightStepScreen'),
      ]
      const paintedScreenSteps = [
        ...numericSteps(session.frameRows, 'nodeScreenStepX'), ...numericSteps(session.frameRows, 'nodeScreenStepY'),
        ...numericSteps(session.frameRows, 'nodeScreenStepWidth'), ...numericSteps(session.frameRows, 'nodeScreenStepHeight'),
      ]
      const chromeErrors = [
        ...numericSteps(session.frameRows, 'chromeLeftErrorScreen'), ...numericSteps(session.frameRows, 'chromeTopErrorScreen'),
        ...numericSteps(session.frameRows, 'chromeRightErrorScreen'), ...numericSteps(session.frameRows, 'chromeBottomErrorScreen'),
      ]
      const frameGaps = numericSteps(session.frameRows, 'frameGapMs')
      const summary = {
        nodeId,
        direction: session.direction,
        elapsedMs: performance.now() - session.startedAt,
        zoomAtEnd: zoom,
        browserCssPixelsPerFlowUnit: zoom,
        flowUnitsPerBrowserCssPixel: 1 / zoom,
        devicePixelRatio: window.devicePixelRatio,
        pointerSamples: session.rows.length,
        paintedFrames: session.frameRows.length,
        largestPaintFrameGapMs: frameGaps.length ? Math.max(...frameGaps) : 0,
        smallestGeometryStepFlowUnits: flowSteps.length ? Math.min(...flowSteps) : 0,
        smallestRequestedStepBrowserCssPixels: requestedScreenSteps.length ? Math.min(...requestedScreenSteps) : 0,
        smallestPaintedStepBrowserCssPixels: paintedScreenSteps.length ? Math.min(...paintedScreenSteps) : 0,
        largestPaintedStepBrowserCssPixels: paintedScreenSteps.length ? Math.max(...paintedScreenSteps) : 0,
        largestChromeToNodeErrorBrowserCssPixels: chromeErrors.length ? Math.max(...chromeErrors) : 0,
        startPointerCss: { x: session.startClientX, y: session.startClientY },
        endPointerCss: { x: pointer.clientX, y: pointer.clientY },
        totalPointerCss: { x: pointer.clientX - session.startClientX, y: pointer.clientY - session.startClientY },
        startGeometryFlowUnits: session.start,
        endGeometryFlowUnits: params,
        geometryDeltaFlowUnits: {
          x: params.x - session.start.x,
          y: params.y - session.start.y,
          width: params.width - session.start.width,
          height: params.height - session.start.height,
        },
      }
      console.groupCollapsed(`[AxiomResizeFrameTrace #${session.id}] COMPLETE - ${nodeId} - ${session.direction}`)
      console.info('Frame/pointer summary', summary)
      console.info('Pointer events and requested floating-point geometry')
      console.table(session.rows)
      console.info('Every painted animation frame: requested geometry vs actual node/chrome DOM')
      console.table(session.frameRows)
      console.log('[AxiomResizeFrameTraceRaw]', { summary, pointerSamples: session.rows, paintedFrames: session.frameRows })
      console.groupEnd()
      resizeTraceSessions.delete(nodeId)
    })
  })
}
