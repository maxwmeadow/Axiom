import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type CapturedEvent } from '../store/graphStore'

/**
 * ReplayBar — Investigation Capture playback (Phase 8).
 *
 * A saved investigation is a timeline of captured events (the exact envelopes
 * the live canvas consumes). Playback re-feeds them through the store's replay
 * dispatch so the whole investigation unfolds on the canvas: traces animate,
 * watched nodes pulse, values appear, perturbations turn nodes orange/red,
 * notes surface. Play / pause / step / scrub, paced by the captured offsets.
 */

// Pace playback by the captured inter-event gaps, clamped so it neither stalls
// on long idle gaps nor blitzes through a burst.
const MIN_GAP_MS = 140
const MAX_GAP_MS = 1600

function eventLabel(ev: CapturedEvent): string {
  const p = ev.payload as any
  if (!p) return ev.type
  switch (ev.type) {
    case 'investigation:note': return `📝 ${p.text}`
    case 'call:trace': return `trace · ${p.steps?.length ?? 0} hops`
    case 'data:flow': return `data-flow · ${p.variable}`
    case 'runtime:call': return `call · ${p.symbol ?? ''}`
    case 'runtime:return': return `return · ${p.symbol ?? ''}`
    case 'runtime:exception': return `exception · ${p.excType ?? ''}`
    case 'runtime:inject': return `inject · ${p.inject?.symbol ?? ''} (${p.inject?.status ?? ''})`
    case 'runtime:watch': return `watch · ${p.watch?.symbol ?? ''}`
    case 'runtime:session': return `session ${p.status ?? ''}`
    default: return ev.type
  }
}

export function ReplayBar() {
  const { replay, replayNext, replaySeek, stopReplay } = useGraphStore(useShallow(s => ({
    replay: s.replay,
    replayNext: s.replayNext,
    replaySeek: s.replaySeek,
    stopReplay: s.stopReplay,
  })))
  const [playing, setPlaying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const events = replay?.events ?? []
  const cursor = replay?.cursor ?? -1
  const atEnd = cursor >= events.length - 1

  // Play loop: schedule the next event by the captured gap (clamped).
  useEffect(() => {
    if (!playing || !replay) return
    if (atEnd) { setPlaying(false); return }
    const cur = events[cursor]
    const next = events[cursor + 1]
    const gap = Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS,
      (next.offsetMs - (cur?.offsetMs ?? next.offsetMs)) || MIN_GAP_MS))
    timer.current = setTimeout(() => {
      useGraphStore.getState().replayNext()
    }, gap)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [playing, cursor, replay, atEnd, events])

  if (!replay) return null

  const pct = events.length ? ((cursor + 1) / events.length) * 100 : 0
  const lastNote = useMemo(() => {
    for (let i = cursor; i >= 0; i--) {
      if (events[i].type === 'investigation:note') return (events[i].payload as any)?.text as string
    }
    return null
  }, [cursor, events])
  const currentLabel = cursor >= 0 && cursor < events.length ? eventLabel(events[cursor]) : 'ready'

  const restart = () => { setPlaying(false); replaySeek(-1) }
  const close = () => { setPlaying(false); stopReplay() }

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 1200, width: 640, maxWidth: 'calc(100vw - 48px)',
      background: 'var(--bg-raised)',
      border: '1px solid #a855f7', borderLeft: '3px solid #a855f7', borderRadius: 0,
      boxShadow: '6px 6px 0 rgba(0,0,0,0.35)',
      padding: '12px 16px', color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#a855f7' }}>▶ REPLAY</span>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {replay.name}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'ui-monospace, monospace' }}>
          {replay.branch}@{replay.commit ? replay.commit.slice(0, 8) : '—'}
        </span>
        <button onClick={close} title="Exit replay" style={iconBtn}>✕</button>
      </div>

      {/* Scrubber */}
      <input
        type="range" min={-1} max={Math.max(0, events.length - 1)} value={cursor}
        onChange={(e) => { setPlaying(false); replaySeek(Number(e.target.value)) }}
        style={{ width: '100%', accentColor: '#a855f7', cursor: 'pointer' }}
      />

      {/* Progress + current event */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', fontSize: 11, color: 'var(--text-secondary)' }}>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{cursor + 1}/{events.length}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{currentLabel}</span>
        <span>{Math.round(pct)}%</span>
      </div>

      {/* Transport */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={restart} title="Restart" style={ctrlBtn}>⟲</button>
        <button
          onClick={() => { if (atEnd) return; setPlaying(p => !p) }}
          disabled={atEnd}
          style={{ ...ctrlBtn, background: playing ? 'var(--bg-overlay)' : ctrlBtn.background, borderColor: playing ? '#a855f7' : 'var(--border)', color: playing ? '#a855f7' : 'var(--text-primary)', opacity: atEnd ? 0.4 : 1, minWidth: 64 }}
        >
          {playing ? '❚❚ Pause' : atEnd ? 'End' : '▶ Play'}
        </button>
        <button onClick={() => { setPlaying(false); replayNext() }} disabled={atEnd} title="Step" style={{ ...ctrlBtn, opacity: atEnd ? 0.4 : 1 }}>
          ⏭ Step
        </button>
        {lastNote && (
          <div style={{
            marginLeft: 8, flex: 1, fontSize: 12, color: '#e9d5ff',
            background: 'var(--bg-overlay)', border: '1px solid #a855f7',
            borderRadius: 0, padding: '4px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            📝 {lastNote}
          </div>
        )}
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-secondary)',
  cursor: 'pointer', fontSize: 13, padding: '2px 6px', borderRadius: 0,
}
const ctrlBtn: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', borderRadius: 0, padding: '5px 10px',
  cursor: 'pointer', fontSize: 12, fontWeight: 600,
}
