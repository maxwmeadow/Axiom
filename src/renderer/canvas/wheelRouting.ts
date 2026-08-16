/**
 * Wheel routing between canvas zoom and scrollable node content.
 *
 * Axiom owns wheel zoom, so a scrollable region inside a node (a file's symbol
 * list, a class node's member list) would never see the wheel. Marking those
 * regions `nowheel` is the wrong trade: it permanently dead-zones canvas zoom
 * over most of a revealed node, including lists too short to scroll at all.
 *
 * Instead a region claims the wheel only while it can actually consume it. The
 * list scrolls until it reaches a boundary, then the canvas resumes zooming -
 * the same chaining behavior a browser gives nested scroll areas.
 */
export interface WheelScrollMetrics {
  /** Computed `overflow-y` of the candidate region. */
  overflowY: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// Sub-pixel slack: fractional layout means a region resting at its boundary can
// report a scrollTop a hair away from the exact limit.
const BOUNDARY_EPSILON = 1

export function regionConsumesWheel(
  metrics: WheelScrollMetrics,
  deltaY: number,
): boolean {
  if (metrics.overflowY !== 'auto' && metrics.overflowY !== 'scroll') return false
  const maxScroll = metrics.scrollHeight - metrics.clientHeight
  if (maxScroll <= BOUNDARY_EPSILON) return false
  if (deltaY < 0) return metrics.scrollTop > BOUNDARY_EPSILON
  if (deltaY > 0) return metrics.scrollTop < maxScroll - BOUNDARY_EPSILON
  return false
}

/**
 * How far one wheel event scrolls a node's list.
 *
 * A Chromium wheel notch reports ~100px, but a symbol row is roughly 12px, so
 * forwarding the raw delta jumps most of a list per notch and slams into the
 * boundary immediately. Cap the step against the region's own height so short
 * lists move a couple of rows, while small trackpad deltas pass through
 * untouched and stay smooth.
 */
const MIN_WHEEL_STEP_PX = 24
const WHEEL_STEP_VIEWPORT_FRACTION = 0.2

export function wheelScrollStep(deltaY: number, clientHeight: number): number {
  const cap = Math.max(MIN_WHEEL_STEP_PX, clientHeight * WHEEL_STEP_VIEWPORT_FRACTION)
  const magnitude = Math.min(Math.abs(deltaY), cap)
  return Math.sign(deltaY) * magnitude
}

export type WheelRoute =
  /** An ancestor opted out; leave the event completely alone. */
  | { kind: 'ignore' }
  /** This region scrolls. Axiom scrolls it directly rather than relying on
   *  native scrolling, which is unreliable inside transform-scaled nodes. */
  | { kind: 'scroll'; element: Element }
  /** Nobody claimed it: the canvas zooms. */
  | { kind: 'zoom' }

/**
 * Walks from the wheel target toward the canvas root to decide who owns this
 * wheel event. Axiom always consumes the event for 'scroll' and 'zoom'; only
 * an explicit `nowheel` opt-out leaves it to the browser.
 */
export function routeWheelEvent(
  target: Element | null,
  deltaY: number,
  root: Element | null,
  readMetrics: (element: Element) => WheelScrollMetrics,
): WheelRoute {
  let current: Element | null = target
  while (current) {
    // An explicit opt-out wins anywhere, including on the root.
    if (current.classList?.contains('nowheel')) return { kind: 'ignore' }
    // The canvas root is the zoom surface itself; it is never node content,
    // even if something has made it scrollable.
    if (current === root) return { kind: 'zoom' }
    if (regionConsumesWheel(readMetrics(current), deltaY)) {
      return { kind: 'scroll', element: current }
    }
    current = current.parentElement
  }
  return { kind: 'zoom' }
}
