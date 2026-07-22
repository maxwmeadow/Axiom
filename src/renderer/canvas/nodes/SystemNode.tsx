import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { SystemNodeData } from '../sceneTypes'
import { EditableNodeTitle } from './EditableNodeTitle'
import { useInfraService } from '../../store/registryStore'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from './infraIcons'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { AxiomNodeResizer } from './AxiomNodeResizer'
import { DEPTH_TITLE_PX } from '../frameGeometry'

// Drop-target feedback: renders the cell grid only while a node is being
// dragged over this container (green = free, amber = displaced, red = occupied).
function GridOverlay({ d }: { d: SystemNodeData }) {
  if (!d.isDropTarget || !d.nodeW || !d.nodeH || !d.gridCellW || !d.gridCellH || !d.gridGap) return null

  const w = d.nodeW, h = d.nodeH
  const cw = d.gridCellW, ch = d.gridCellH, gap = d.gridGap
  if (![w, h, cw, ch, gap].every(value => Number.isFinite(value) && value > 0)) return null
  const columnCount = Math.min(512, Math.max(0, Math.ceil((w - gap) / (cw + gap))))
  const rowCount = Math.min(
    Math.max(1, Math.floor(4096 / Math.max(1, columnCount))),
    Math.max(0, Math.ceil((h - gap) / (ch + gap))),
  )

  const els: React.ReactNode[] = []

  // Draw cells
  for (let col = 0; col < columnCount; col++) {
    const x = (col + 1) * gap + col * cw
    if (x >= w) break
    for (let row = 0; row < rowCount; row++) {
      const y = (row + 1) * gap + row * ch
      if (y >= h) break

      const isInSnapFootprint = !!(d.snapPreview &&
        col >= d.snapPreview.col && col < d.snapPreview.col + d.snapPreview.wUnits &&
        row >= d.snapPreview.row && row < d.snapPreview.row + d.snapPreview.hUnits)

      const isOccupied = d.occupiedCells?.has(`${col}-${row}`)
      let fill: string
      let stroke: string
      let strokeDash: string | undefined

      if (isInSnapFootprint && isOccupied) {
        // Amber = occupied cell under snap footprint → will be displaced
        fill = "rgba(245, 158, 11, 0.10)"
        stroke = "rgba(245, 158, 11, 0.55)"
        strokeDash = "2,2"
      } else if (isInSnapFootprint) {
        // Bright green = free cell that will be occupied
        fill = "rgba(16, 185, 129, 0.12)"
        stroke = "rgba(16, 185, 129, 0.55)"
      } else if (isOccupied) {
        fill = "rgba(239, 68, 68, 0.01)" // faint red for occupied
        stroke = "rgba(239, 68, 68, 0.08)"
      } else {
        fill = "rgba(16, 185, 129, 0.05)" // semi-transparent green for free
        stroke = "rgba(16, 185, 129, 0.25)"
        strokeDash = "2,2"
      }

      els.push(
        <rect key={`cell-${col}-${row}`}
          x={x} y={y}
          width={Math.min(cw, w - x)}
          height={Math.min(ch, h - y)}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.5}
          strokeDasharray={strokeDash}
        />
      )
    }
  }

  // Snap preview overlay
  if (d.snapPreview) {
    const { col, row, wUnits, hUnits } = d.snapPreview
    const px = (col + 1) * gap + col * cw
    const py = (row + 1) * gap + row * ch
    const pw = wUnits * cw + (wUnits - 1) * gap
    const ph = hUnits * ch + (hUnits - 1) * gap

    els.push(
      <rect key="snap-preview"
        x={px} y={py}
        width={pw}
        height={ph}
        fill="rgba(16, 185, 129, 0.15)"
        stroke="rgba(16, 185, 129, 0.8)"
        strokeWidth={1.5}
        style={{ transition: "all 0.08s ease-out" }}
      />
    )
  }

  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}
      width={w} height={h}>
      {els}
    </svg>
  )
}

export function SystemNode({ data, selected, width, height, isConnectable }: NodeProps) {
  const d = data as unknown as SystemNodeData
  const infraCategory = d.umlMetadata?.category ?? 'platform'
  const isDeploymentBoundary = d.umlKind === 'infra'
  const infraService = useInfraService(d.umlKind === 'infra' ? (d.umlMetadata?.service ?? '') : '')
  const officialInfraIcon = infraService ? officialServiceIcon(infraService.id) : undefined
  const infraIcon = infraService ? brandIcon(infraService.brand.icon) : null
  const legend = isDeploymentBoundary
    ? ['HOSTING', infraService?.provider?.toUpperCase()].filter(Boolean).join(' · ')
    : 'SYSTEM'
  const { color: authoredColor, name, source, directChildCount, agentTouched, isChild,
    childrenVisible, selfScale, selfBlur, isDropTarget, onResizeStart, onResizeEnd, depth } = d
  const color = isDeploymentBoundary
    ? (infraService?.brand.darkColor ?? infraService?.brand.color ?? authoredColor)
    : authoredColor

  // 0..1 reveal of inner contents (zoom-gated). Drives the title crossfade:
  // big centered title while contents are hidden ↔ small tab-band title once
  // they reveal. The folder silhouette itself renders at all zooms.
  const containerAlpha = typeof childrenVisible === 'number' ? childrenVisible : (childrenVisible ? 1 : 0)
  const scale = typeof selfScale === 'number' ? selfScale : 1
  const blur  = typeof selfBlur === 'number' ? selfBlur : 0
  const totalCount = directChildCount
  const presentationScale = fitPresentationScale(
    width,
    height,
    d.presentationBaseWidth ?? width ?? 620,
    d.presentationBaseHeight ?? height ?? 420,
  )

  // Preview offset — applied as translate so the node visually floats to its predicted post-drop
  // position without moving the React Flow logical position (handles stay at original spot).
  const previewOffset = d.previewOffset as { x: number; y: number } | null | undefined
  const translateX = previewOffset?.x ?? 0
  const translateY = previewOffset?.y ?? 0

  // All pixel values proportional to titlePx so every depth renders identically —
  // only world-space scale differs between depths.
  const depthIdx = Math.min(depth ?? 0, DEPTH_TITLE_PX.length - 1)
  const titlePx  = DEPTH_TITLE_PX[depthIdx] * presentationScale
  const dotPx    = titlePx * 0.55
  const padX     = Math.round(titlePx * 0.75)
  const padY     = Math.round(titlePx * 0.55)
  const radius   = Math.round(titlePx * 0.55)

  // Header compartment: the layout reserves one grid gap above the first cell
  // row. Draw the rule at 80% of that so there's clear space between the rule
  // and the cell tops; the title centers vertically inside the shorter band.
  const reservedGap = d.gridGap ?? Math.round(padY * 2 + titlePx * 1.25)

  const handles = (
    <>
      <Handle type="source" position={Position.Right}  {...connectionHandleProps(isConnectable, presentationScale, { right: -6 })} />
      <Handle type="target" position={Position.Left}   {...connectionHandleProps(isConnectable, presentationScale, { left: -6 })} />
      <Handle type="source" position={Position.Bottom} {...connectionHandleProps(isConnectable, presentationScale, { bottom: -6 })} />
      <Handle type="target" position={Position.Top}    {...connectionHandleProps(isConnectable, presentationScale, { top: -6 })} />
    </>
  )

  // Folder silhouette (Rev 2b): the node outline IS the UML package shape —
  // tab across the top-left holding the title, body below. Proportional to
  // the node so it reads at every zoom, unlike a fixed-px decoration.
  const shellRef = React.useRef<HTMLDivElement>(null)
  const [shellSize, setShellSize] = React.useState({ w: 200, h: 120 })
  React.useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setShellSize({ w: el.offsetWidth, h: el.offsetHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Mirror NodeShell's folder proportions (the sheet-layer look): slim tab
  // with the tiny SYSTEM label, title full-width below. CONSTRAINT: the whole
  // chrome (tab + title band) must fit inside the grid's reserved gap — the
  // layout gives exactly one gridGap of headroom and eight drag/snap sites
  // assume it, so the chrome scales to the budget, never the other way.
  const tabH = Math.round(reservedGap * 0.38)
  const titleBandH = reservedGap - tabH
  const titleFont = Math.min(titlePx, Math.round(titleBandH * 0.72))
  const badgeFont = Math.round(titleFont * 0.8)
  const tabW = Math.min(Math.max(shellSize.w * 0.3, titleFont * 6), shellSize.w * 0.5)
  const tabSlant = tabH * 0.65

  const infraIdentityIcon = (size: number) => {
    if (!isDeploymentBoundary) return null
    if (officialInfraIcon) return <img src={officialInfraIcon} alt="" width={size} height={size} style={{ flexShrink: 0, objectFit: 'contain', order: -1 }} />
    if (infraIcon) return <svg viewBox="0 0 24 24" width={size} height={size} style={{ flexShrink: 0, order: -1 }}>
      <path d={infraIcon.path} fill={color} />
    </svg>
    return <svg viewBox="0 0 24 24" width={size} height={size} style={{ flexShrink: 0, order: -1 }}>
      <path d={CATEGORY_GLYPHS[infraCategory] ?? CATEGORY_GLYPHS.platform} fill={color} />
    </svg>
  }

  // Big centered title — the collapsed identity. Fades out as contents reveal.
  const bigTitleFont = Math.max(0.5, Math.min(shellSize.w * 0.11, shellSize.h * 0.2, 72 * presentationScale))
  const bigTitle = (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: bigTitleFont * 0.25,
      zIndex: 15,
      pointerEvents: 'none',
      opacity: 1 - containerAlpha,
      transition: 'opacity 0.25s ease',
      padding: `0 ${padX}px`,
    }}>
      <EditableNodeTitle value={name} onRename={d.onRename} style={{
        fontSize: bigTitleFont,
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'center',
        pointerEvents: d.onRename ? 'auto' : 'none',
      }} />
      {infraIdentityIcon(Math.max(16, bigTitleFont * 0.48))}
      {totalCount > 0 && (
        <span style={{
          fontSize: Math.max(9, bigTitleFont * 0.3),
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          color,
          border: '1px solid var(--border-dim)',
          background: 'var(--bg-raised)',
          padding: `${bigTitleFont * 0.08}px ${bigTitleFont * 0.25}px`,
        }}>{totalCount}</span>
      )}
    </div>
  )

  const header = (
    <div style={{
      position: 'absolute',
      top: tabH, left: padX, right: padX,
      height: titleBandH,
      display: 'flex',
      alignItems: 'center',
      gap: dotPx * 0.75,
      zIndex: 20,
      overflow: 'hidden',
      // crossfade partner of the big centered title
      opacity: containerAlpha,
      transition: 'opacity 0.25s ease',
    }}>
      {infraIdentityIcon(Math.max(12, titleFont * 1.05))}
      <EditableNodeTitle value={name} onRename={d.onRename} style={{
        fontSize: titleFont,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-primary)',
        letterSpacing: '-0.01em',
        lineHeight: 1.25,
        flex: 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        pointerEvents: 'none',
      }} />
      {source === 'agent' && (
        <span style={{
          fontSize: badgeFont * 0.85,
          color: 'var(--agent-color)',
          background: 'var(--bg-raised)',
          border: '1px solid var(--agent-color)',
          fontFamily: 'var(--font-mono)',
          padding: `${badgeFont * 0.12}px ${badgeFont * 0.5}px`,
          flexShrink: 0,
          pointerEvents: 'none',
        }}>
          AI
        </span>
      )}
    </div>
  )

  // Opaque panel fill per depth — deeper nesting sits one step "higher" on the board.
  const basePanelBg = `var(--panel-${Math.min(depth ?? 0, 3)})`
  const panelBg = isDeploymentBoundary
    ? `color-mix(in srgb, ${color} 12%, ${basePanelBg})`
    : basePanelBg

  const dimmed = !!(d as any).dimmed

  const strokeColor = isDropTarget ? color : 'var(--border)'
  const strokeW = isDropTarget ? 2.5 : 1
  const deploymentCorner = Math.max(7, Math.min(18, shellSize.w * 0.035, shellSize.h * 0.09))
  const shellPath = isDeploymentBoundary
    // Hosting is a deployment chassis, not a UML package. It deliberately
    // shares containment mechanics without implying semantic system ownership.
    ? `M ${deploymentCorner} 1 L ${shellSize.w - deploymentCorner} 1 ` +
      `L ${shellSize.w - 1} ${deploymentCorner} L ${shellSize.w - 1} ${shellSize.h - deploymentCorner} ` +
      `L ${shellSize.w - deploymentCorner} ${shellSize.h - 1} L ${deploymentCorner} ${shellSize.h - 1} ` +
      `L 1 ${shellSize.h - deploymentCorner} L 1 ${deploymentCorner} Z`
    : `M 1 ${shellSize.h - 1} L 1 1 L ${tabW} 1 L ${tabW + tabSlant} ${tabH} ` +
      `L ${shellSize.w - 1} ${tabH} L ${shellSize.w - 1} ${shellSize.h - 1} Z`

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', userSelect: 'none', cursor: 'grab' }}>
      {/* Shell plane: the silhouette and contents ride preview translate,
          reveal scale, and blur. Interaction chrome (resizer, connection
          handles) lives outside on the raw node frame so selection outlines
          never shift, teleport, or get clipped by the shell's overflow. */}
      <div ref={shellRef} style={{
        position: 'absolute',
        inset: 0,
        // The folder SVG owns ALL chrome — a rect background/border here would
        // fill the tab notch and fight the silhouette (the "two systems" bug).
        background: 'transparent',
        transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
        filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
        opacity: dimmed ? 0.3 : 1,
        transformOrigin: 'center center',
        transition: 'transform 0.22s cubic-bezier(0.25,1,0.5,1), filter 0.18s ease-out, opacity 0.3s ease',
        overflow: 'hidden',
      }}>
      {/* Semantic systems use a package outline; hosting uses a compute chassis. */}
      <svg
        width={shellSize.w} height={shellSize.h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        <path
          d={shellPath}
          fill={panelBg}
          stroke={strokeColor}
          strokeWidth={strokeW}
        />
        {isDeploymentBoundary ? <>
          {/* Chassis rails remain legible even around a large hosted service. */}
          <line x1={deploymentCorner * 0.46} y1={deploymentCorner + 3} x2={deploymentCorner * 0.46} y2={shellSize.h - deploymentCorner - 3} stroke={color} strokeWidth={2.5} />
          <line x1={deploymentCorner * 0.78} y1={deploymentCorner + 3} x2={deploymentCorner * 0.78} y2={shellSize.h - deploymentCorner - 3} stroke={color} strokeWidth={1} opacity={0.45} />
        </> : <line x1={2} y1={2} x2={2} y2={shellSize.h - 2} stroke={color} strokeWidth={3} />}
        {/* tiny legend identifies the semantic or deployment role. */}
        <text x={padX * 0.8} y={tabH * 0.72} style={{
          fontSize: tabH * 0.5, letterSpacing: '0.12em',
          fill: isDeploymentBoundary ? color : 'var(--text-dim)', fontFamily: 'var(--font-mono)',
        }}>{legend}</text>
        {/* item count — a small bordered chip nested INSIDE the tab at its
            right end, right edge slanted to echo the tab's cut. */}
        {!isDeploymentBoundary && totalCount > 0 && (() => {
          const legendFont = tabH * 0.5
          const yT = 3.5                    // chip inset from the tab's top edge
          const yB = tabH - 1               // sits low, riding the tab line
          const gapR = 2.5                  // horizontal clearance to the tab slant
          // Right edge runs EXACTLY parallel to the tab's slant at gapR.
          const slope = tabSlant / Math.max(tabH - 1, 1)
          const chipSlant = slope * (yB - yT)
          const chipW = legendFont * 0.62 * String(totalCount).length + tabH * 0.55
          // Anchored at the slant: more digits → chipW grows → x0 moves LEFT;
          // the right edge never moves.
          const x1 = tabW + slope * (yT - 1) - gapR  // top-right corner
          const x0 = x1 - chipW                      // left edge
          return (
            <g opacity={containerAlpha} style={{ transition: 'opacity 0.25s ease' }}>
              <path
                d={`M ${x0} ${yB} L ${x0} ${yT} L ${x1} ${yT} L ${x1 + chipSlant} ${yB} Z`}
                fill="var(--bg-raised)"
                stroke={strokeColor}
                strokeWidth={1}
              />
              <text
                x={x0 + (chipW + chipSlant * 0.35) / 2} y={tabH * 0.72}
                textAnchor="middle"
                style={{
                  fontSize: legendFont, fontWeight: 700,
                  fill: color, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.05em',
                }}
              >{totalCount}</text>
            </g>
          )
        })()}
      </svg>
      <GridOverlay d={d} />
      {header}
      {bigTitle}
      {agentTouched && (
        <div style={{
          position: 'absolute', inset: -3,
          border: '2px solid var(--agent-color, #f59e0b)',
          animation: 'agentPulse 1.5s ease-out 3',
          pointerEvents: 'none',
        }} />
      )}
      </div>
      <AxiomNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
        isResizable={typeof onResizeStart === 'function' && typeof onResizeEnd === 'function'}
        minWidth={d.minResizeWidth ?? 1}
        minHeight={d.minResizeHeight ?? 1} color={color}
        onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />
      {handles}
    </div>
  )
}
