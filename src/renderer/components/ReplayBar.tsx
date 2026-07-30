import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type CapturedEvent } from '../store/graphStore'

const MIN_GAP_MS = 140
const MAX_GAP_MS = 1600

function eventLabel(event: CapturedEvent): string {
  const payload = event.payload as any
  if (!payload) return event.type
  switch (event.type) {
    case 'investigation:note': return `note · ${payload.text}`
    case 'call:trace': return `trace · ${payload.steps?.length ?? 0} hops`
    case 'data:flow': return `data-flow · ${payload.variable}`
    case 'runtime:call': return `call · ${payload.symbol ?? ''}`
    case 'runtime:return': return `return · ${payload.symbol ?? ''}`
    case 'runtime:exception': return `exception · ${payload.excType ?? ''}`
    case 'runtime:inject': return `inject · ${payload.inject?.symbol ?? ''} (${payload.inject?.status ?? ''})`
    case 'runtime:watch': return `watch · ${payload.watch?.symbol ?? ''}`
    case 'runtime:session': return `session ${payload.status ?? ''}`
    default: return event.type
  }
}

export function ReplayBar() {
  const { replay, replayNext, replaySeek, stopReplay } = useGraphStore(useShallow(state => ({
    replay: state.replay,
    replayNext: state.replayNext,
    replaySeek: state.replaySeek,
    stopReplay: state.stopReplay,
  })))
  const [playing, setPlaying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const events = replay?.events ?? []
  const cursor = replay?.cursor ?? -1
  const atEnd = cursor >= events.length - 1
  const percent = events.length ? ((cursor + 1) / events.length) * 100 : 0
  const currentLabel = cursor >= 0 && cursor < events.length ? eventLabel(events[cursor]) : 'Ready to replay'
  const lastNote = useMemo(() => {
    for (let index = cursor; index >= 0; index -= 1) {
      if (events[index].type === 'investigation:note') {
        return (events[index].payload as { text?: string })?.text ?? null
      }
    }
    return null
  }, [cursor, events])

  useEffect(() => {
    if (!playing || !replay) return
    if (atEnd) {
      setPlaying(false)
      return
    }
    const current = events[cursor]
    const next = events[cursor + 1]
    const gap = Math.max(
      MIN_GAP_MS,
      Math.min(MAX_GAP_MS, (next.offsetMs - (current?.offsetMs ?? next.offsetMs)) || MIN_GAP_MS),
    )
    timer.current = setTimeout(() => {
      useGraphStore.getState().replayNext()
    }, gap)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, cursor, replay, atEnd, events])

  if (!replay) return null

  const restart = () => {
    setPlaying(false)
    replaySeek(-1)
  }

  const close = () => {
    setPlaying(false)
    stopReplay()
  }

  return (
    <section className="axiom-replay" aria-label={`Investigation replay: ${replay.name}`}>
      <header className="axiom-replay__header">
        <div className="axiom-replay__identity">
          <span className="axiom-replay__mode">Replay</span>
          <strong title={replay.name}>{replay.name}</strong>
        </div>
        <code className="axiom-replay__revision">
          {replay.branch}@{replay.commit ? replay.commit.slice(0, 8) : '—'}
        </code>
        <button type="button" className="axiom-replay__close" onClick={close} aria-label="Exit replay">×</button>
      </header>

      <div className="axiom-replay__body">
        <input
          className="axiom-replay__timeline"
          type="range"
          min={-1}
          max={Math.max(0, events.length - 1)}
          value={cursor}
          aria-label="Investigation timeline"
          aria-valuetext={`${cursor + 1} of ${events.length}: ${currentLabel}`}
          onChange={event => {
            setPlaying(false)
            replaySeek(Number(event.target.value))
          }}
        />

        <div className="axiom-replay__progress">
          <span>{cursor + 1}/{events.length}</span>
          <strong title={currentLabel}>{currentLabel}</strong>
          <output>{Math.round(percent)}%</output>
        </div>

        <div className="axiom-replay__transport">
          <button type="button" className="axiom-replay__button" onClick={restart}>Restart</button>
          <button
            type="button"
            className="axiom-replay__button axiom-replay__button--primary"
            data-playing={playing || undefined}
            disabled={atEnd}
            onClick={() => {
              if (!atEnd) setPlaying(current => !current)
            }}
          >
            {playing ? 'Pause' : atEnd ? 'End' : 'Play'}
          </button>
          <button
            type="button"
            className="axiom-replay__button"
            disabled={atEnd}
            onClick={() => {
              setPlaying(false)
              replayNext()
            }}
          >
            Step
          </button>
          {lastNote && <aside className="axiom-replay__note" title={lastNote}>{lastNote}</aside>}
        </div>
      </div>
    </section>
  )
}
