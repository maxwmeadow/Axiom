import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A movable, resizable window over the workbench.
 *
 * Portalled to the document body rather than rendered where it is declared.
 * `position: fixed` detaches layout but leaves the element a DOM descendant of
 * whatever declared it, and a window living inside the canvas subtree puts the
 * canvas's own pointer handling in the capture path of every event the window
 * raises - which is how a drag out of one ended up unable to finish. Leaving
 * the subtree is the fix, so it is built into the window itself.
 *
 * Geometry is per-session on purpose. Where a reference window happens to sit
 * is a convenience, not a document worth persisting.
 */

interface FloatingWindowProps {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Fractions of the viewport used for the opening size. */
  initialWidthRatio?: number
  initialHeightRatio?: number
  minWidth?: number
  minHeight?: number
  className?: string
  /** Marks the window for hit tests, e.g. the unsorted bin's drop target. */
  dataAttribute?: string
  /**
   * Where it opens. A window launched from a control should appear over that
   * control, not in the middle of the screen - it belongs to the thing you
   * clicked, and centring it severs that connection. Moving it afterwards is
   * the user's business; this is only the starting point.
   */
  anchor?: 'center' | 'above-bins'
}

export function FloatingWindow({
  title,
  subtitle,
  onClose,
  children,
  footer,
  initialWidthRatio = 0.32,
  initialHeightRatio = 0.42,
  minWidth = 320,
  minHeight = 240,
  className,
  dataAttribute,
  anchor = 'above-bins',
}: FloatingWindowProps) {
  const [frame, setFrame] = useState(() => {
    const width = Math.max(minWidth, Math.round(window.innerWidth * initialWidthRatio))
    const height = Math.max(minHeight, Math.round(window.innerHeight * initialHeightRatio))
    if (anchor === 'center') {
      return {
        x: Math.max(16, Math.round((window.innerWidth - width) / 2)),
        y: Math.max(16, Math.round((window.innerHeight - height) / 2)),
        width,
        height,
      }
    }
    // Sat directly above the bins in the bottom-right, aligned to their right
    // edge, so it reads as having come out of the control that opened it.
    const inset = 12
    const binsHeight = 92
    return {
      x: Math.max(16, window.innerWidth - width - inset),
      y: Math.max(16, window.innerHeight - height - binsHeight),
      width,
      height,
    }
  })
  const gesture = useRef<
    | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
    | { kind: 'resize'; startX: number; startY: number; originW: number; originH: number }
    | null
  >(null)

  const onPointerMove = useCallback((event: PointerEvent) => {
    const active = gesture.current
    if (!active) return
    if (active.kind === 'move') {
      const nextX = active.originX + (event.clientX - active.startX)
      const nextY = active.originY + (event.clientY - active.startY)
      setFrame(current => ({
        ...current,
        // The title bar must stay reachable: a window whose header has left the
        // viewport is one that can never be moved back.
        x: Math.min(Math.max(nextX, -current.width + 80), window.innerWidth - 80),
        y: Math.min(Math.max(nextY, 0), window.innerHeight - 40),
      }))
      return
    }
    setFrame(current => ({
      ...current,
      width: Math.max(minWidth, active.originW + (event.clientX - active.startX)),
      height: Math.max(minHeight, active.originH + (event.clientY - active.startY)),
    }))
  }, [minWidth, minHeight])

  // A move or resize is a pointer gesture that travels over text, which the
  // browser reads as a selection drag. Suppressed on the document because the
  // pointer routinely leaves the window mid-gesture.
  const beginGesture = useCallback(() => { document.body.style.userSelect = 'none' }, [])
  const endGesture = useCallback(() => {
    if (gesture.current) document.body.style.userSelect = ''
    gesture.current = null
  }, [])

  useEffect(() => () => { document.body.style.userSelect = '' }, [])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endGesture)
    window.addEventListener('pointercancel', endGesture)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endGesture)
      window.removeEventListener('pointercancel', endGesture)
    }
  }, [onPointerMove, endGesture])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <section
      className={['axiom-window', className].filter(Boolean).join(' ')}
      {...(dataAttribute ? { [dataAttribute]: '' } : {})}
      aria-label={title}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <header
        className="axiom-window__bar"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest('button, input')) return
          beginGesture()
          gesture.current = {
            kind: 'move',
            startX: event.clientX,
            startY: event.clientY,
            originX: frame.x,
            originY: frame.y,
          }
        }}
      >
        <div>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <button type="button" onClick={onClose} aria-label={`Close ${title}`}>×</button>
      </header>

      <div className="axiom-window__body">{children}</div>

      {footer && <footer className="axiom-window__footer">{footer}</footer>}

      <div
        className="axiom-window__grip"
        role="separator"
        aria-label={`Resize ${title}`}
        onPointerDown={event => {
          beginGesture()
          gesture.current = {
            kind: 'resize',
            startX: event.clientX,
            startY: event.clientY,
            originW: frame.width,
            originH: frame.height,
          }
        }}
      />
    </section>,
    document.body,
  )
}
