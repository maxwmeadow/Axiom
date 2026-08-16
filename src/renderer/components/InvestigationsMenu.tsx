import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGraphStore, type InvestigationDoc } from '../store/graphStore'
import { ChromeButton } from './ui/ChromeButton'

interface InvestigationMeta {
  id: string
  name: string
  commit: string
  branch: string
  createdAt: number
  durationMs: number
  eventCount: number
}

const MENU_WIDTH = 360
const VIEWPORT_GUTTER = 8

function captureDate(createdAt: number): string {
  if (!createdAt) return 'Date unavailable'
  return new Date(createdAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function InvestigationsMenu({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<InvestigationMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const anchorRef = useRef<HTMLDivElement>(null)
  const replay = useGraphStore(state => state.replay)
  const startReplay = useGraphStore(state => state.startReplay)

  const updatePosition = useCallback(() => {
    const bounds = anchorRef.current?.getBoundingClientRect()
    if (!bounds) return
    const left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(bounds.left, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER),
    )
    setPosition({ left, top: bounds.bottom + 5 })
  }, [])

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `http://127.0.0.1:7743/api/investigation/list?workspace=${encodeURIComponent(workspaceId)}`,
      )
      if (!response.ok) throw new Error(`Unable to load captures (${response.status})`)
      const payload = await response.json() as { investigations?: InvestigationMeta[] }
      setItems(payload.investigations ?? [])
    } catch (cause: unknown) {
      setItems([])
      setError(cause instanceof Error ? cause.message : 'Unable to load investigation captures')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    updatePosition()
    setOpen(true)
    void load()
  }

  const openReplay = async (id: string) => {
    setOpeningId(id)
    setError(null)
    try {
      const response = await fetch(
        `http://127.0.0.1:7743/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspaceId)}`,
      )
      if (!response.ok) throw new Error(`Unable to open capture (${response.status})`)
      startReplay(await response.json() as InvestigationDoc)
      setOpen(false)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to open investigation capture')
    } finally {
      setOpeningId(null)
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useEffect(() => {
    setOpen(false)
    setItems([])
    setError(null)
  }, [workspaceId])

  return (
    <div className="axiom-investigations-anchor" ref={anchorRef}>
      <ChromeButton
        onClick={toggle}
        label="Investigations"
        active={open || !!replay}
        ariaControls="axiom-investigations-menu"
        ariaExpanded={open}
        ariaHasPopup="menu"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9"/>
          <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
        </svg>
      </ChromeButton>

      {open && createPortal(
        <>
          <div className="axiom-investigations-scrim" onPointerDown={() => setOpen(false)} />
          <section
            className="axiom-investigations-menu"
            id="axiom-investigations-menu"
            role="menu"
            aria-label="Investigation captures"
            style={{
              '--axiom-investigations-left': `${position.left}px`,
              '--axiom-investigations-top': `${position.top}px`,
            } as React.CSSProperties}
          >
            <header className="axiom-investigations-menu__header">
              <div>
                <h2>Investigation captures</h2>
                <p>Saved runtime timelines</p>
              </div>
              {!loading && !error && <output>{items.length}</output>}
            </header>

            <div className="axiom-investigations-menu__body">
              {loading && <div className="axiom-investigations-menu__state">Loading captures…</div>}
              {error && <div className="axiom-investigations-menu__state axiom-investigations-menu__state--error" role="alert">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div className="axiom-investigations-menu__empty">
                  <strong>No captures yet</strong>
                  <span>
                    Ask your agent to <code>start_investigation</code>, debug the behavior,
                    then <code>stop_investigation</code>.
                  </span>
                </div>
              )}
              {!loading && items.map(investigation => (
                <button
                  key={investigation.id}
                  type="button"
                  className="axiom-investigations-menu__item"
                  role="menuitem"
                  disabled={openingId !== null}
                  onClick={() => void openReplay(investigation.id)}
                >
                  <span className="axiom-investigations-menu__item-title">
                    <strong>{investigation.name}</strong>
                    <time dateTime={new Date(investigation.createdAt).toISOString()}>
                      {captureDate(investigation.createdAt)}
                    </time>
                  </span>
                  <span className="axiom-investigations-menu__item-meta">
                    <span>{investigation.eventCount} events</span>
                    <span>{(investigation.durationMs / 1000).toFixed(1)}s</span>
                    <code>{investigation.branch}@{investigation.commit ? investigation.commit.slice(0, 7) : '-'}</code>
                  </span>
                  {openingId === investigation.id && <span className="axiom-investigations-menu__opening">Opening…</span>}
                </button>
              ))}
            </div>
          </section>
        </>,
        document.body,
      )}
    </div>
  )
}
