import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useGraphStore } from '../store/graphStore'
import {
  apiGetInvestigation,
  apiListInvestigations,
  apiStartInvestigation,
  apiStopInvestigation,
} from '../canvas/arcdApi'
import type { InvestigationDoc } from '../store/graphStore'
import { ChromeButton } from './ui/ChromeButton'

/**
 * Start and stop an investigation, and show one while it is running.
 *
 * Recording used to be reachable only from an agent's MCP call, and nothing on
 * the canvas said it was happening. Someone watching their agent debug saw an
 * unchanged toolbar whether a session was being captured or not. This is both
 * halves: a human can record their own session, and either way the canvas says
 * so while it happens.
 */
function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function defaultName(): string {
  return `Investigation ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function RecordingControl({ workspaceId }: { workspaceId: string }) {
  const active = useGraphStore(state => state.activeInvestigation)
  const beginInvestigation = useGraphStore(state => state.beginInvestigation)
  const endInvestigation = useGraphStore(state => state.endInvestigation)
  const startReplay = useGraphStore(state => state.startReplay)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ id: string; eventCount: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Opening the app while an agent is already recording must show the truth,
  // so the live state is reconciled from archd rather than assumed empty.
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void (async () => {
      try {
        const { recording } = await apiListInvestigations(workspaceId)
        if (cancelled || !recording) return
        beginInvestigation(
          recording.id, recording.name, recording.createdAt, recording.eventCount, recording.origin,
        )
      } catch {
        // A failed reconcile is not worth a visible error; the WS broadcast
        // will still switch the control on when the next event arrives.
      }
    })()
    return () => { cancelled = true }
  }, [workspaceId, beginInvestigation])

  useEffect(() => {
    if (!active) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [active])

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const openSaved = useCallback(async (id: string) => {
    try {
      startReplay(await apiGetInvestigation(workspaceId, id) as InvestigationDoc)
      setSaved(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not open the capture')
    }
  }, [workspaceId, startReplay])

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(null)
    const name = defaultName()
    try {
      const result = await apiStartInvestigation(workspaceId, name)
      // Optimistic, and confirmed moments later by investigation:started.
      beginInvestigation(result.id, result.name || name)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not start recording')
    } finally {
      setBusy(false)
    }
  }, [workspaceId, beginInvestigation])

  const stop = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await apiStopInvestigation(workspaceId)
      endInvestigation()
      setSaved({ id: result.id, eventCount: result.eventCount })
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(null), 8000)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not stop recording')
    } finally {
      setBusy(false)
    }
  }, [workspaceId, endInvestigation])

  if (active) {
    return (
      <div className="axiom-recording" role="status" aria-live="polite">
        <button
          type="button"
          className="axiom-recording__stop"
          onClick={() => void stop()}
          disabled={busy}
          title={`Recording "${active.name}" - click to save the capture`}
        >
          <span className="axiom-recording__dot" aria-hidden="true" />
          <span className="axiom-recording__text">
            {busy
              ? 'Saving…'
              : active.origin === 'auto'
                ? `Auto-recording ${elapsedLabel(now - active.startedAt)}`
                : `Recording ${elapsedLabel(now - active.startedAt)}`}
          </span>
          <span className="axiom-recording__count">
            {active.eventCount} {active.eventCount === 1 ? 'event' : 'events'}
          </span>
        </button>
        {error && <span className="axiom-recording__error" role="alert">{error}</span>}
      </div>
    )
  }

  return (
    <div className="axiom-recording">
      <ChromeButton
        onClick={() => void start()}
        label={busy ? 'Starting recording' : 'Record investigation'}
        visualLabel="Record"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="7" fill="currentColor" stroke="none" />
        </svg>
      </ChromeButton>
      {saved && (
        <button
          type="button"
          className="axiom-recording__saved"
          onClick={() => void openSaved(saved.id)}
          title="Replay this capture on the canvas"
        >
          Saved {saved.eventCount} {saved.eventCount === 1 ? 'event' : 'events'} - watch it
        </button>
      )}
      {error && <span className="axiom-recording__error" role="alert">{error}</span>}
    </div>
  )
}
