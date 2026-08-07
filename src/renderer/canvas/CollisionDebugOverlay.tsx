/**
 * Live collision geometry, drawn on the canvas.
 *
 * Purely a renderer: every rect it draws comes from `buildCollisionModel`,
 * which in turn calls the real placement engine. Nothing in this file computes
 * geometry, and nothing in it may start to — the moment the overlay derives a
 * box of its own it stops being evidence and becomes a second opinion.
 *
 * Works identically on the Floor and on a Sheet. The layer only changes the
 * badge in the readout.
 */
import React, { useMemo, useState } from 'react'
import { Panel, ViewportPortal, useViewport } from '@xyflow/react'

import {
  summarizeCollisionModel,
  type CollisionBox,
  type CollisionBoxKind,
  type CollisionModel,
} from './collisionModel.ts'

interface BoxStyle {
  color: string
  /** Dashed outlines mark derived regions; solid ones mark real geometry. */
  dashed: boolean
  /** Screen-space stroke width in CSS pixels. */
  weight: number
  fill: string | null
  labelled: boolean
}

const BOX_STYLES: Record<CollisionBoxKind, BoxStyle> = {
  node:        { color: '#2BB3C0', dashed: false, weight: 1,   fill: null,                      labelled: true  },
  clearance:   { color: '#D4A843', dashed: true,  weight: 1,   fill: 'rgba(212,168,67,0.06)',   labelled: false },
  content:     { color: '#5FA37A', dashed: true,  weight: 1,   fill: null,                      labelled: true  },
  destination: { color: '#2F9E68', dashed: false, weight: 2,   fill: 'rgba(47,158,104,0.10)',   labelled: true  },
  incoming:    { color: '#4C7DF0', dashed: false, weight: 2,   fill: 'rgba(76,125,240,0.10)',   labelled: true  },
  landing:     { color: '#C05BD8', dashed: false, weight: 2,   fill: 'rgba(192,91,216,0.12)',   labelled: true  },
  blocker:     { color: '#D6453F', dashed: false, weight: 2,   fill: 'rgba(214,69,63,0.10)',    labelled: true  },
}

const KIND_ORDER: CollisionBoxKind[] = [
  'clearance', 'content', 'node', 'destination', 'incoming', 'blocker', 'landing',
]

const TOGGLEABLE: Array<{ kind: CollisionBoxKind; label: string }> = [
  { kind: 'node', label: 'Node boxes' },
  { kind: 'clearance', label: 'Clearance halos' },
  { kind: 'content', label: 'Frame interiors' },
]

export interface CollisionDebugOverlayProps {
  model: CollisionModel
  onClose: () => void
}

export function CollisionDebugOverlay({ model, onClose }: CollisionDebugOverlayProps) {
  const [hidden, setHidden] = useState<ReadonlySet<CollisionBoxKind>>(() => new Set())
  const { zoom } = useViewport()

  const visible = useMemo(() => {
    const rank = new Map(KIND_ORDER.map((kind, index) => [kind, index]))
    return model.boxes
      .filter(box => !hidden.has(box.kind))
      .sort((left, right) => (rank.get(left.kind) ?? 0) - (rank.get(right.kind) ?? 0))
  }, [model.boxes, hidden])

  const toggle = (kind: CollisionBoxKind) => setHidden(current => {
    const next = new Set(current)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    return next
  })

  return (
    <>
      <ViewportPortal>
        {/* Non-interactive by construction: the overlay must never intercept the
            very gesture it exists to explain. */}
        <div style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 9 }}>
          {visible.map(box => (
            <CollisionBoxView key={box.key} box={box} zoom={zoom} />
          ))}
        </div>
      </ViewportPortal>
      <Panel position="top-right">
        <CollisionReadout
          model={model}
          hidden={hidden}
          onToggle={toggle}
          onClose={onClose}
        />
      </Panel>
    </>
  )
}

function CollisionBoxView({ box, zoom }: { box: CollisionBox; zoom: number }) {
  const style = BOX_STYLES[box.kind]
  // Strokes and labels are authored in SCREEN pixels and converted back through
  // the zoom, so a hairline stays a hairline at 0.2x and does not swallow the
  // node it outlines at 3x.
  const stroke = style.weight / zoom
  return (
    <div
      style={{
        position: 'absolute',
        left: box.rect.x,
        top: box.rect.y,
        width: box.rect.width,
        height: box.rect.height,
        border: `${stroke}px ${style.dashed ? 'dashed' : 'solid'} ${style.color}`,
        background: style.fill ?? undefined,
        boxSizing: 'border-box',
      }}
    >
      {style.labelled && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `scale(${1 / zoom}) translateY(-100%)`,
            transformOrigin: 'top left',
            whiteSpace: 'nowrap',
            font: '600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
            color: style.color,
            background: 'rgba(18,22,21,0.82)',
            padding: '1px 4px',
            borderRadius: 2,
          }}
        >
          {box.label}
        </span>
      )}
    </div>
  )
}

const readoutShell: React.CSSProperties = {
  width: 302,
  maxHeight: '72vh',
  overflowY: 'auto',
  background: 'rgba(18,22,21,0.94)',
  border: '1px solid rgba(148,163,158,0.28)',
  borderRadius: 6,
  padding: '10px 12px',
  font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#D8E0DC',
}

function CollisionReadout({
  model,
  hidden,
  onToggle,
  onClose,
}: {
  model: CollisionModel
  hidden: ReadonlySet<CollisionBoxKind>
  onToggle: (kind: CollisionBoxKind) => void
  onClose: () => void
}) {
  const { drag, issues } = model
  const errors = issues.filter(issue => issue.severity === 'error')
  return (
    <div style={readoutShell}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ letterSpacing: '0.06em', fontSize: 10, textTransform: 'uppercase' }}>
          Collision
        </strong>
        <span style={{
          padding: '1px 6px',
          borderRadius: 10,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          background: model.layer === 'sheet' ? 'rgba(76,125,240,0.22)' : 'rgba(95,163,122,0.22)',
          color: model.layer === 'sheet' ? '#9DB8F7' : '#96C7AC',
        }}>
          {model.layer}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid rgba(148,163,158,0.34)',
            borderRadius: 4,
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            padding: '1px 6px',
          }}
        >
          close
        </button>
      </header>

      <Row label="scene">
        {model.nodeCount} nodes · {model.frameCount} frames · {model.editableCount ?? 'all'} editable
      </Row>

      <Section title="clearance — enforced">
        <Row label="all nodes" tone="#D4A843">
          {round(model.clearance.gap)} world — the only distance a drop can fail
        </Row>
      </Section>

      <Section title="packing gap — preference only">
        {model.gaps.slice(0, 6).map(entry => (
          <Row key={entry.frameId ?? 'root'} label={entry.label}>
            {round(entry.gap.gap)} world — {entry.gap.source} {entry.gap.authored}
            {entry.gap.source === 'FRAME_ITEM_GAP' ? ` × ${round(entry.gap.contentScale)}` : ''}
          </Row>
        ))}
        {model.gaps.length > 6 && <Row label="…">{model.gaps.length - 6} more frames</Row>}
      </Section>

      <Section title="drag">
        {!drag && <Muted>no drag in flight</Muted>}
        {drag && (
          <>
            <Row label="target">{drag.targetNodeId ?? 'root plane'}</Row>
            <Row label="path">
              {drag.resolution}
              {drag.changesParent ? ' · reparent' : ' · same parent'}
              {drag.landingApproximate ? ' · landing approximate' : ''}
            </Row>
            <Row label="pushed">
              {drag.repelDistance > 0.5
                ? `${round(drag.repelDistance)} world units (clearance ${round(drag.clearance.gap)})`
                : 'not at all — landing where released'}
            </Row>
            <Row label="moving">{drag.movingNodeIds.length} node(s)</Row>
            {drag.blockers.length === 0 && <Muted>released position is free</Muted>}
            {drag.blockers.map(blocker => (
              <Row key={blocker.nodeId} label="blocked by" tone="#D6453F">
                {blocker.nodeId} — {blocker.separation} apart, needs {blocker.required}
              </Row>
            ))}
            {drag.landingNeighbours.slice(0, 3).map(neighbour => (
              <Row key={`landing:${neighbour.nodeId}`} label="lands near" tone="#C05BD8">
                {neighbour.nodeId} — {neighbour.separation} apart
              </Row>
            ))}
          </>
        )}
      </Section>

      <Section title={`invariants (${errors.length} error${errors.length === 1 ? '' : 's'})`}>
        {issues.length === 0 && <Muted>all clear</Muted>}
        {issues.slice(0, 12).map((issue, index) => (
          <Row
            key={`${issue.code}:${index}`}
            label={issue.code}
            tone={issue.severity === 'error' ? '#D6453F' : '#D4A843'}
          >
            {issue.message}
          </Row>
        ))}
        {issues.length > 12 && <Muted>{issues.length - 12} more — see console dump</Muted>}
      </Section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {TOGGLEABLE.map(entry => (
          <button
            key={entry.kind}
            type="button"
            onClick={() => onToggle(entry.kind)}
            style={{
              background: hidden.has(entry.kind) ? 'transparent' : 'rgba(148,163,158,0.16)',
              border: `1px solid ${BOX_STYLES[entry.kind].color}`,
              borderRadius: 4,
              color: hidden.has(entry.kind) ? 'rgba(216,224,220,0.45)' : BOX_STYLES[entry.kind].color,
              cursor: 'pointer',
              font: 'inherit',
              padding: '2px 6px',
            }}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            console.groupCollapsed('[AxiomCollision] model')
            for (const line of summarizeCollisionModel(model)) console.log(line)
            console.log('raw', model)
            console.groupEnd()
          }}
          style={{
            background: 'transparent',
            border: '1px solid rgba(148,163,158,0.34)',
            borderRadius: 4,
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            padding: '2px 6px',
          }}
        >
          Dump to console
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 10 }}>
      <div style={{
        fontSize: 9,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'rgba(216,224,220,0.5)',
        marginBottom: 3,
      }}>
        {title}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 2 }}>
      <span style={{ color: tone ?? 'rgba(216,224,220,0.5)', flex: '0 0 auto', minWidth: 62 }}>
        {label}
      </span>
      <span style={{ wordBreak: 'break-word', minWidth: 0 }}>{children}</span>
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'rgba(216,224,220,0.42)' }}>{children}</div>
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
