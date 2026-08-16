import { useEffect, useRef } from 'react'

interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Marks a canvas root as something WASD can be aimed at. */
export const CANVAS_SCOPE_ATTR = 'data-axiom-canvas'

/**
 * Where the pointer last was. One listener for every canvas, because the answer
 * is a property of the document, not of any one surface.
 *
 * Tracked rather than read from `:hover`, because canvases nest: the bin window
 * is a DOM descendant of the Floor, so both match `:hover` at once and the
 * question "which one is the user pointing at?" has no answer in CSS.
 */
let pointer: { x: number; y: number } | null = null
let pointerTracked = false

function trackPointer() {
  if (pointerTracked) return
  pointerTracked = true
  window.addEventListener('pointermove', event => {
    pointer = { x: event.clientX, y: event.clientY }
  }, { passive: true })
}

/**
 * The canvas under the pointer, by hit test rather than by hover, so the
 * innermost surface wins when canvases overlap.
 */
function canvasUnderPointer(): Element | null {
  if (!pointer) return null
  return document.elementFromPoint(pointer.x, pointer.y)
    ?.closest(`[${CANVAS_SCOPE_ATTR}]`) ?? null
}

export interface WasdScope {
  /** This canvas's root, matched against whatever is under the pointer. */
  element: () => Element | null
  /**
   * Whether this canvas answers when the pointer is over no canvas at all -
   * hovering a toolbar or a side panel. Without one designated fallback, WASD
   * would simply stop working anywhere off-canvas, which reads as broken.
   */
  fallback: boolean
}

/** The one keyboard-panning implementation shared by every Axiom canvas. */
export function useCanvasWasdPan(
  getViewport: () => Viewport,
  setViewport: (viewport: Viewport) => void | Promise<boolean>,
  enabled = true,
  scope?: WasdScope,
) {
  const heldKeysRef = useRef<Set<string>>(new Set())
  const wasdRafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    trackPointer()
    const PAN_SPEED = 8

    /** Is this canvas the one the user is pointing at? */
    const owns = () => {
      if (!scope) return true
      const mine = scope.element()
      if (!mine) return false
      const hovered = canvasUnderPointer()
      return hovered ? hovered === mine : scope.fallback
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      const key = event.key.toLowerCase()
      if (!['w', 'a', 's', 'd'].includes(key)) return
      // Checked per keypress rather than once per gesture: the pointer can move
      // between canvases while a key is held, and the surface being panned
      // should follow it.
      if (!owns()) return
      event.preventDefault()
      heldKeysRef.current.add(key)
      if (wasdRafRef.current !== null) return
      const loop = () => {
        const keys = heldKeysRef.current
        if (keys.size === 0) {
          wasdRafRef.current = null
          return
        }
        let dx = 0
        let dy = 0
        if (keys.has('a')) dx += PAN_SPEED
        if (keys.has('d')) dx -= PAN_SPEED
        if (keys.has('w')) dy += PAN_SPEED
        if (keys.has('s')) dy -= PAN_SPEED
        // Re-checked every frame, not just on keypress: move the pointer to
        // another canvas mid-hold and the pan follows it there instead of the
        // surface you left continuing to drift.
        if ((dx !== 0 || dy !== 0) && owns()) {
          const viewport = getViewport()
          void setViewport({ x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom })
        }
        wasdRafRef.current = requestAnimationFrame(loop)
      }
      wasdRafRef.current = requestAnimationFrame(loop)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      heldKeysRef.current.delete(event.key.toLowerCase())
      if (heldKeysRef.current.size === 0 && wasdRafRef.current !== null) {
        cancelAnimationFrame(wasdRafRef.current)
        wasdRafRef.current = null
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      heldKeysRef.current.clear()
      if (wasdRafRef.current !== null) cancelAnimationFrame(wasdRafRef.current)
      wasdRafRef.current = null
    }
  }, [enabled, getViewport, setViewport, scope])
}
