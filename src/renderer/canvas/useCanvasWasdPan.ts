import { useEffect, useRef } from 'react'

interface Viewport {
  x: number
  y: number
  zoom: number
}

/** The one keyboard-panning implementation shared by every Axiom canvas. */
export function useCanvasWasdPan(
  getViewport: () => Viewport,
  setViewport: (viewport: Viewport) => void | Promise<boolean>,
  enabled = true,
) {
  const heldKeysRef = useRef<Set<string>>(new Set())
  const wasdRafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    const PAN_SPEED = 8
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      const key = event.key.toLowerCase()
      if (!['w', 'a', 's', 'd'].includes(key)) return
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
        if (dx !== 0 || dy !== 0) {
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
  }, [enabled, getViewport, setViewport])
}
