/** The complete geometry emitted by React Flow's NodeResizer. */
export interface NodeResizeParams {
  x: number
  y: number
  width: number
  height: number
}

export interface CanonicalResizeGeometry extends NodeResizeParams {
  parentWorldScale: number
}

export interface ContainerInsets {
  left: number
  right: number
  top: number
  bottom: number
}

export interface FloatingResizeDirection {
  horizontal: 'left' | 'right' | null
  vertical: 'top' | 'bottom' | null
}

export interface FloatingResizeBounds {
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export interface ResizeChromeGeometry {
  /** Desired composed screen width of the SVG outline. */
  strokeWidth: number
  /** Whole-pixel base size counter-scaled against the canvas transform. */
  handleSize: number
  /** Whole-pixel base hit target counter-scaled against the canvas transform. */
  hitSize: number
}

export interface ResizeDimensionSources {
  controlled?: number | null
  styled?: number | null
  rendered?: number | null
  measured?: number | null
}

export const RESIZE_OUTLINE_SCREEN_PX = 1
export const RESIZE_HANDLE_SCREEN_PX = 8
export const RESIZE_HIT_TARGET_SCREEN_PX = 18

export interface ClientToFlowTransform {
  viewportX: number
  viewportY: number
  zoom: number
  paneLeft: number
  paneTop: number
}

const safeScale = (value: number): number => Number.isFinite(value) && value > 0 ? value : 1

/**
 * Choose the exact controlled node dimension before React Flow's DOM
 * measurement. XYFlow measures with offsetWidth/offsetHeight, which discard
 * fractions and are unsuitable as a resize baseline at extreme zoom.
 */
export function authoritativeResizeDimension(sources: ResizeDimensionSources, fallback = 1): number {
  for (const value of [sources.controlled, sources.styled, sources.rendered, sources.measured]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1
}

/**
 * Selection chrome rides the node's own DOM transform so it updates on the
 * exact same compositor frame. Its fixed-size pieces are counter-scaled by
 * the viewport zoom, making these values literal composed browser pixels.
 */
export function resizeChromeGeometry(): ResizeChromeGeometry {
  return {
    strokeWidth: RESIZE_OUTLINE_SCREEN_PX,
    handleSize: RESIZE_HANDLE_SCREEN_PX,
    hitSize: RESIZE_HIT_TARGET_SCREEN_PX,
  }
}

/** Convert a browser client point into React Flow coordinates without rounding. */
export function clientPointToFlow(
  point: { x: number; y: number },
  transform: ClientToFlowTransform,
): { x: number; y: number } {
  const zoom = safeScale(transform.zoom)
  const finite = (value: number): number => Number.isFinite(value) ? value : 0
  return {
    x: (finite(point.x) - finite(transform.paneLeft) - finite(transform.viewportX)) / zoom,
    y: (finite(point.y) - finite(transform.paneTop) - finite(transform.viewportY)) / zoom,
  }
}

/**
 * Apply a screen-space pointer delta to a flow-space rectangle without
 * quantization. XYFlow's built-in resizer floors these deltas to whole flow
 * units; keeping the quotient floating-point preserves one-screen-pixel
 * precision at every viewport zoom.
 */
export function floatingResizeGeometry(
  start: NodeResizeParams,
  direction: FloatingResizeDirection,
  screenDelta: { x: number; y: number },
  zoom: number,
  bounds: FloatingResizeBounds,
): NodeResizeParams {
  const viewportZoom = safeScale(zoom)
  const deltaX = (Number.isFinite(screenDelta.x) ? screenDelta.x : 0) / viewportZoom
  const deltaY = (Number.isFinite(screenDelta.y) ? screenDelta.y : 0) / viewportZoom
  const minWidth = Math.max(0, bounds.minWidth)
  const minHeight = Math.max(0, bounds.minHeight)
  const maxWidth = Math.max(minWidth, bounds.maxWidth)
  const maxHeight = Math.max(minHeight, bounds.maxHeight)
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  let width = start.width
  let height = start.height
  let x = start.x
  let y = start.y

  if (direction.horizontal === 'right') {
    width = clamp(start.width + deltaX, minWidth, maxWidth)
  } else if (direction.horizontal === 'left') {
    width = clamp(start.width - deltaX, minWidth, maxWidth)
    x = start.x + start.width - width
  }
  if (direction.vertical === 'bottom') {
    height = clamp(start.height + deltaY, minHeight, maxHeight)
  } else if (direction.vertical === 'top') {
    height = clamp(start.height - deltaY, minHeight, maxHeight)
    y = start.y + start.height - height
  }
  return { x, y, width, height }
}

/**
 * Uniformly fit a node's canonical presentation into its authored frame.
 * The limiting axis controls typography/chrome scale while the other axis
 * gains additional logical layout space. This preserves content visibility
 * through arbitrary user resizing without changing nested-frame semantics.
 */
export function fitPresentationScale(
  renderedWidth: number | null | undefined,
  renderedHeight: number | null | undefined,
  designWidth: number,
  designHeight: number,
  fallback = 1,
): number {
  if (!(typeof renderedWidth === 'number' && renderedWidth > 0) ||
      !(typeof renderedHeight === 'number' && renderedHeight > 0) ||
      !(designWidth > 0) || !(designHeight > 0)) return safeScale(fallback)
  return Math.max(0.0001, Math.min(renderedWidth / designWidth, renderedHeight / designHeight))
}

/**
 * Convert React Flow's rendered, parent-local resize rectangle back into
 * Axiom's canonical geometry. Positions inherit only the ancestor scale;
 * dimensions inherit both the ancestor and node's own scale.
 */
export function toCanonicalResizeGeometry(
  params: NodeResizeParams,
  worldScale: number,
  ownScale: number,
  hasParent: boolean,
): CanonicalResizeGeometry {
  const safeWorldScale = safeScale(worldScale)
  const parentWorldScale = hasParent ? safeWorldScale / safeScale(ownScale) : 1
  return {
    x: params.x / parentWorldScale,
    y: params.y / parentWorldScale,
    width: params.width / safeWorldScale,
    height: params.height / safeWorldScale,
    parentWorldScale,
  }
}

/**
 * React Flow keeps a container's children visually stationary when its north
 * or west edge moves. Mirror that origin shift in canonical child geometry so
 * the next persisted layout rebuild does not make the children jump.
 */
export function childPositionAfterParentResize(
  childStart: Pick<NodeResizeParams, 'x' | 'y'>,
  parentStart: Pick<NodeResizeParams, 'x' | 'y'>,
  parentEnd: Pick<NodeResizeParams, 'x' | 'y'>,
  parentWorldScale: number,
): { x: number; y: number } {
  const scale = safeScale(parentWorldScale)
  return {
    x: (childStart.x + parentStart.x - parentEnd.x) / scale,
    y: (childStart.y + parentStart.y - parentEnd.y) / scale,
  }
}

export function resizeChanged(start: NodeResizeParams, end: NodeResizeParams, epsilon = 0.001): boolean {
  return Math.abs(end.x - start.x) >= epsilon || Math.abs(end.y - start.y) >= epsilon ||
    Math.abs(end.width - start.width) >= epsilon || Math.abs(end.height - start.height) >= epsilon
}

/**
 * Return one direction-independent minimum that is safe for every resize
 * handle. East/south handles retain the children's far edge; west/north
 * handles retain the distance from the opposite frame edge to the children's
 * near edge because XYFlow keeps children stationary while moving the origin.
 */
export function minimumContainerSize(
  container: Pick<NodeResizeParams, 'width' | 'height'>,
  children: ReadonlyArray<NodeResizeParams>,
  insets: ContainerInsets,
  floor: Pick<NodeResizeParams, 'width' | 'height'>,
): { width: number; height: number; westWidth: number; northHeight: number } {
  if (children.length === 0) {
    return {
      width: floor.width,
      height: floor.height,
      westWidth: floor.width,
      northHeight: floor.height,
    }
  }

  const left = Math.min(...children.map(child => child.x))
  const top = Math.min(...children.map(child => child.y))
  const right = Math.max(...children.map(child => child.x + child.width))
  const bottom = Math.max(...children.map(child => child.y + child.height))

  // The minimum is the box that contains the children, plus insets - nothing
  // more. It must never be derived from the container's *current* size: doing
  // that made the minimum track whatever width the frame already had, so a
  // container whose children sat near its left edge reported a minimum equal
  // to its own width and could not be narrowed at all.
  //
  // Children are placed relative to the frame origin, so `right` and `bottom`
  // already carry their offset. The overhang terms only matter when a child
  // has drifted above or left of its inset, where extra room is needed to
  // contain it once the frame is normalized.
  const overhangLeft = Math.max(0, insets.left - left)
  const overhangTop = Math.max(0, insets.top - top)
  return {
    width: Math.max(floor.width, right + overhangLeft + insets.right),
    height: Math.max(floor.height, bottom + overhangTop + insets.bottom),
    // A west or north handle moves the frame ORIGIN, and children are
    // compensated to stay visually put - so their local coordinates slide
    // negative and the frame walks off their left/top edge. The east/south
    // minimum above cannot express that, because it is measured from an origin
    // those handles are moving. The constraint there is instead how far the
    // origin may travel before it passes the nearest child.
    westWidth: Math.max(floor.width, container.width - Math.max(0, left - insets.left)),
    northHeight: Math.max(floor.height, container.height - Math.max(0, top - insets.top)),
  }
}
