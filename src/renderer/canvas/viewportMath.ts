export const MIN_CANVAS_ZOOM = 0.02
export const MAX_CANVAS_ZOOM = 100
export const WHEEL_ZOOM_FACTOR = 1.15
export const ZOOM_EASE_STEP = 0.15
export const ZOOM_SNAP_EPSILON = 0.005

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export function nextWheelZoomTarget(
  targetZoom: number,
  deltaY: number,
  minZoom = MIN_CANVAS_ZOOM,
  maxZoom = MAX_CANVAS_ZOOM,
): number {
  if (deltaY < 0) return Math.min(maxZoom, targetZoom * WHEEL_ZOOM_FACTOR)
  return Math.max(minZoom, targetZoom / WHEEL_ZOOM_FACTOR)
}

/** Keep the same flow coordinate under a composed-screen point. */
export function zoomViewportAroundPoint(
  viewport: CanvasViewport,
  point: ScreenPoint,
  nextZoom: number,
): CanvasViewport {
  const flowX = (point.x - viewport.x) / viewport.zoom
  const flowY = (point.y - viewport.y) / viewport.zoom
  return {
    x: point.x - flowX * nextZoom,
    y: point.y - flowY * nextZoom,
    zoom: nextZoom,
  }
}

export function easeViewportTowardZoom(
  viewport: CanvasViewport,
  point: ScreenPoint,
  targetZoom: number,
  step = ZOOM_EASE_STEP,
): CanvasViewport {
  const nextZoom = viewport.zoom + (targetZoom - viewport.zoom) * step
  return zoomViewportAroundPoint(viewport, point, nextZoom)
}
