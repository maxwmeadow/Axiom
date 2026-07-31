import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { LivingInspectionWindow, SystemNodeData } from '../sceneTypes'
import { EditableNodeTitle } from './EditableNodeTitle'
import { useInfraService } from '../../store/registryStore'
import { brandIcon, CATEGORY_GLYPHS, officialServiceIcon } from './infraIcons'
import { fitPresentationScale } from '../resizeGeometry'
import { connectionHandleProps } from './connectionChrome'
import { AxiomNodeResizer } from './AxiomNodeResizer'
import { AgentPresenceBadge } from './AgentPresenceBadge'
import { DEPTH_TITLE_PX } from '../frameGeometry'
import { systemTabChrome } from '../systemChrome'
import { LIVING_WINDOW_CLOSE_MS } from '../../store/graphStore'

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
  const { color: authoredColor, name, source, directChildCount, isChild,
    childrenVisible, selfScale, selfBlur, isDropTarget, onResizeStart, onResizeEnd, depth } = d
  const incomingLivingWindows = (d.livingWindows ?? []).filter(window =>
    [window.x, window.y, window.width, window.height].every(Number.isFinite) &&
    window.width > 0 &&
    window.height > 0
  )
  const livingWindowSignature = incomingLivingWindows
    .map(window => `${window.originId}:${window.key}`)
    .join('|')
  const [renderedLivingWindows, setRenderedLivingWindows] = React.useState<LivingInspectionWindow[]>(
    incomingLivingWindows,
  )
  const [livingWindowsClosing, setLivingWindowsClosing] = React.useState(false)
  const livingWindowCloseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    if (livingWindowCloseTimer.current !== null) {
      clearTimeout(livingWindowCloseTimer.current)
      livingWindowCloseTimer.current = null
    }
    if (incomingLivingWindows.length > 0) {
      setLivingWindowsClosing(false)
      setRenderedLivingWindows(incomingLivingWindows)
      return
    }
    if (renderedLivingWindows.length === 0) return

    // Keep the aperture mounted for a real exit phase. If another signal
    // arrives before it closes, the timer is cancelled and the same window
    // remains open instead of flashing the whole system title in between.
    setLivingWindowsClosing(true)
    livingWindowCloseTimer.current = setTimeout(() => {
      setRenderedLivingWindows([])
      setLivingWindowsClosing(false)
      livingWindowCloseTimer.current = null
    }, LIVING_WINDOW_CLOSE_MS)
    return () => {
      if (livingWindowCloseTimer.current !== null) {
        clearTimeout(livingWindowCloseTimer.current)
        livingWindowCloseTimer.current = null
      }
    }
  }, [livingWindowSignature])
  React.useEffect(() => () => {
    if (livingWindowCloseTimer.current !== null) {
      clearTimeout(livingWindowCloseTimer.current)
    }
  }, [])
  const livingWindows = renderedLivingWindows
  const livingWindowActive = livingWindows.length > 0
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
  // Authoritative and canonical: "how far has the user resized this frame from
  // its design size", with no world-scale term on either side. It must NOT be
  // recomputed here from `width`/`height` — those are world-scaled, which would
  // fold nesting depth in a second time (DEPTH_TITLE_PX already carries it) and
  // would make the chrome grow whenever the frame compressed its interior.
  // The sheet layer does not project one, so fall back to the local canonical
  // ratio there.
  const presentationScale = typeof d.presentationScale === 'number' && d.presentationScale > 0
    ? d.presentationScale
    : fitPresentationScale(
        (width ?? 0) / Math.max(0.0001, d.worldScale ?? 1),
        (height ?? 0) / Math.max(0.0001, d.worldScale ?? 1),
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
      <Handle id="source-top" type="source" position={Position.Top} {...connectionHandleProps(isConnectable, presentationScale, { top: -6 })} />
      <Handle id="source-right" type="source" position={Position.Right} {...connectionHandleProps(isConnectable, presentationScale, { right: -6 })} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} {...connectionHandleProps(isConnectable, presentationScale, { bottom: -6 })} />
      <Handle id="source-left" type="source" position={Position.Left} {...connectionHandleProps(isConnectable, presentationScale, { left: -6 })} />
      <Handle id="target-top" type="target" position={Position.Top} {...connectionHandleProps(isConnectable, presentationScale, { top: -6 })} />
      <Handle id="target-right" type="target" position={Position.Right} {...connectionHandleProps(isConnectable, presentationScale, { right: -6 })} />
      <Handle id="target-bottom" type="target" position={Position.Bottom} {...connectionHandleProps(isConnectable, presentationScale, { bottom: -6 })} />
      <Handle id="target-left" type="target" position={Position.Left} {...connectionHandleProps(isConnectable, presentationScale, { left: -6 })} />
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
  // All tab geometry comes from one swept, tested model. Crucially it takes
  // the UNSCALED depth title size, so tab height cannot follow the node width
  // through presentationScale the way it used to.
  const chrome = systemTabChrome({
    shellWidth: shellSize.w,
    shellHeight: shellSize.h,
    depthTitlePx: DEPTH_TITLE_PX[depthIdx],
    titlePx,
    title: name,
    count: totalCount,
    frameStroke: isDropTarget ? 2.5 : 1,
  })
  const tabH = chrome.tabHeight
  const tabW = chrome.tabWidth
  const tabSlant = chrome.tabSlant
  const tabBandTop = chrome.bandTop
  const tabBandH = chrome.bandHeight
  const titleFont = chrome.titleFont
  const badgeFont = Math.round(titleFont * 0.8)
  const legendFont = chrome.chipFont
  const chipW = chrome.chipWidth
  const chipX0 = chrome.chipLeft
  const chipXTopRight = chrome.chipTopRight
  const chipXBottomRight = chrome.chipBottomRight
  const tabGap = Math.max(1.5, tabH * 0.14)

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
      opacity: livingWindowActive ? 0.08 : 1 - containerAlpha,
      transition: 'opacity 0.5s cubic-bezier(0.22,1,0.36,1)',
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
      // Exactly the chip's band: the title sits wholly within the tab.
      top: tabBandTop,
      // Must be the model's inset, not `padX`. padX is derived from titlePx,
      // which rides presentationScale = min(w/designW, h/designH) — so using
      // it here moved the title sideways whenever the frame's HEIGHT changed.
      left: chrome.titleLeft,
      width: chrome.titleWidth,
      height: tabBandH,
      display: 'flex',
      alignItems: 'center',
      // Depth-relative for the same reason as `left` above: dotPx rides
      // presentationScale, so a height change would shift anything after it.
      gap: DEPTH_TITLE_PX[depthIdx] * 0.4,
      zIndex: 20,
      overflow: 'hidden',
      // crossfade partner of the big centered title
      opacity: livingWindowActive ? 1 : containerAlpha,
      transition: 'opacity 0.5s cubic-bezier(0.22,1,0.36,1)',
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
  const surfacedFx = d.fx?.kind.startsWith('surface-') ? d.fx : null
  const surfacedColor = surfacedFx?.kind === 'surface-add'
    ? '#2fa35d'
    : surfacedFx?.kind === 'surface-remove'
      ? '#b6534b'
      : '#3c8f92'
  const surfacedCount = surfacedFx?.count ?? 1
  const surfacedNames = surfacedFx?.originLabels ?? []
  const surfacedIdentity = surfacedNames.length > 0
    ? surfacedNames.slice(0, 2).join(', ')
    : `${surfacedCount} hidden item${surfacedCount === 1 ? '' : 's'}`
  const surfacedOverflow = surfacedCount > surfacedNames.slice(0, 2).length
    ? ` +${surfacedCount - surfacedNames.slice(0, 2).length}`
    : ''
  const surfacedVerb = surfacedFx?.kind === 'surface-add'
    ? 'created'
    : surfacedFx?.kind === 'surface-remove'
      ? 'removed'
      : 'edited'

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', userSelect: 'none', cursor: 'grab' }}>
      <AgentPresenceBadge presence={d.agentPresence} scale={Math.max(0.8, Math.min(1.2, presentationScale))} />
      {/* Shell plane: the silhouette and contents ride preview translate,
          reveal scale, and blur. Interaction chrome (resizer, connection
          handles) lives outside on the raw node frame so selection outlines
          never shift, teleport, or get clipped by the shell's overflow. */}
      <div ref={shellRef} className="axiom-system-node__shell" style={{
        position: 'absolute',
        inset: 0,
        // The folder SVG owns ALL chrome — a rect background/border here would
        // fill the tab notch and fight the silhouette (the "two systems" bug).
        background: 'transparent',
        transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
        filter: !livingWindowActive && blur > 0.1 ? `blur(${blur}px)` : undefined,
        opacity: dimmed ? 0.3 : 1,
        transformOrigin: 'center center',
        transition: 'transform 0.22s cubic-bezier(0.25,1,0.5,1), filter 0.18s ease-out, opacity 0.3s ease',
        // visible so the folder's hard offset shadow lifts off the board;
        // contents are inset and never bleed past the silhouette.
        overflow: 'visible',
        // Live choreography: a newly-clustered system materializes onto the Floor.
        animation: d.fx?.kind === 'enter' ? 'axiomMaterialize 0.6s cubic-bezier(0.22,1,0.36,1) both' : undefined,
      }}>
      {/* Semantic systems use a package outline; hosting uses a compute chassis. */}
      <svg
        width={shellSize.w} height={shellSize.h}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          overflow: 'visible',
          // Hard warm-gray offset shadow lifts the folder off the parchment
          // board (mirrors the mockup's `drop-shadow(4px 4px 0 …)`).
          filter: 'drop-shadow(4px 4px 0 rgba(76,81,75,0.34))' }}
      >
        <path
          d={shellPath}
          fill={panelBg}
          stroke={strokeColor}
          strokeWidth={strokeW}
        />
        {/* Folder card stock, clipped to the folder itself by sharing its path,
            so the tab and its cut are textured too. A system is what you keep
            files in, so it is heavier board with grain running the other way —
            the material says "container" before any label does. */}
        <path
          className="axiom-shape-texture"
          data-stock="card"
          d={shellPath}
          stroke="none"
          pointerEvents="none"
        />
        {isDeploymentBoundary ? <>
          {/* Chassis rails remain legible even around a large hosted service. */}
          <line x1={deploymentCorner * 0.46} y1={deploymentCorner + 3} x2={deploymentCorner * 0.46} y2={shellSize.h - deploymentCorner - 3} stroke={color} strokeWidth={2.5} />
          <line x1={deploymentCorner * 0.78} y1={deploymentCorner + 3} x2={deploymentCorner * 0.78} y2={shellSize.h - deploymentCorner - 3} stroke={color} strokeWidth={1} opacity={0.45} />
        </> : <line x1={2} y1={2} x2={2} y2={shellSize.h - 2} stroke={color} strokeWidth={3} />}
        {/* item count — a small bordered chip nested INSIDE the tab at its
            right end, right edge slanted to echo the tab's cut. */}
        {!isDeploymentBoundary && totalCount > 0 && (() => {
          // The chip is a sibling of the frame's own chrome, so it shares the
          // frame's stroke weight and registers against the frame's lines:
          //
          //  - its BOTTOM border sits exactly on y = tabH, the body's long top
          //    border, so the two strokes are collinear rather than merely
          //    close;
          //  - its TOP and RIGHT borders stand off the tab's top border and
          //    slanted cut by the same gap. Because the cut is slanted, an
          //    equal *visual* gap needs a larger horizontal offset — hence the
          //    edge-length term below, which converts a perpendicular gap into
          //    the horizontal one that produces it.
          const yT = tabBandTop
          const yB = tabH
          const xTopRight = chipXTopRight
          const xBottomRight = chipXBottomRight
          const x0 = chipX0
          return (
            <g opacity={containerAlpha} style={{ transition: 'opacity 0.25s ease' }}>
              <path
                d={`M ${x0} ${yB} L ${x0} ${yT} L ${xTopRight} ${yT} L ${xBottomRight} ${yB} Z`}
                fill="var(--bg-raised)"
                stroke={strokeColor}
                strokeWidth={chrome.chipStroke}
              />
              <text
                x={(x0 + (xTopRight + xBottomRight) / 2) / 2}
                y={(yT + yB) / 2}
                textAnchor="middle"
                dominantBaseline="central"
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
      </div>
      {livingWindowActive && (() => {
        const pad = Math.max(7, 10 * presentationScale)
        const windows = livingWindows.map(window => {
          const x = Math.max(2, window.x - pad)
          const y = Math.max(2, window.y - pad)
          return {
            ...window,
            x,
            y,
            width: Math.max(1, Math.min(shellSize.w - x - 2, window.width + pad * 2)),
            height: Math.max(1, Math.min(shellSize.h - y - 2, window.height + pad * 2)),
          }
        })
        const maskPath = [
          `M 0 0 H ${shellSize.w} V ${shellSize.h} H 0 Z`,
          ...windows.map(window =>
            `M ${window.x} ${window.y} H ${window.x + window.width} ` +
            `V ${window.y + window.height} H ${window.x} Z`
          ),
        ].join(' ')
        return (
          <svg
            className={
              `axiom-living-inspection-layer${livingWindowsClosing
                ? ' axiom-living-inspection-layer--closing'
                : ''}`
            }
            width={shellSize.w}
            height={shellSize.h}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 28,
              overflow: 'visible',
              pointerEvents: 'none',
              '--living-window-close': `${LIVING_WINDOW_CLOSE_MS}ms`,
            } as React.CSSProperties}
          >
            <path
              d={maskPath}
              fill="rgba(42, 50, 47, 0.16)"
              fillRule="evenodd"
            />
            {windows.map(window => {
              const windowColor = window.kind === 'enter' || window.kind === 'flow-add'
                ? '#2fa35d'
                : window.kind === 'exit' || window.kind === 'flow-remove'
                  ? '#b6534b'
                  : '#3c8f92'
              return (
                <g key={`${window.originId}-${window.key}`}>
                  <rect
                    x={window.x}
                    y={window.y}
                    width={window.width}
                    height={window.height}
                    fill="rgba(242, 240, 229, 0.44)"
                    stroke={windowColor}
                    strokeWidth={Math.max(1.5, 2 * presentationScale)}
                    strokeDasharray={`${Math.max(5, 8 * presentationScale)} ${Math.max(2, 4 * presentationScale)}`}
                    className="axiom-living-inspection-window"
                  />
                </g>
              )
            })}
          </svg>
        )
      })()}
      {surfacedFx && (
        <div
          key={`surface-fx-${surfacedFx.key}`}
          className="axiom-surface-activity-peek"
          style={{
            position: 'absolute',
            right: 0,
            bottom: Math.max(10, titleFont * 0.8),
            zIndex: 35,
            pointerEvents: 'none',
            maxWidth: '58%',
            minWidth: Math.min(shellSize.w * 0.34, 180 * presentationScale),
            border: `1px solid ${surfacedColor}`,
            borderLeftWidth: Math.max(3, 3 * presentationScale),
            background: 'var(--bg-raised)',
            boxShadow: `3px 3px 0 rgba(52, 61, 57, 0.28), 0 0 9px ${surfacedColor}55`,
            color: 'var(--text-primary)',
            padding: `${Math.max(4, titleFont * 0.24)}px ${Math.max(6, titleFont * 0.42)}px`,
            fontFamily: 'var(--font-mono)',
            transformOrigin: 'right center',
            animation: 'axiomSurfaceActivityPeek 1.35s cubic-bezier(0.22,1,0.36,1) both',
          }}
        >
          <div style={{
            color: surfacedColor,
            fontSize: Math.max(7, titleFont * 0.52),
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>{surfacedVerb}</div>
          <div style={{
            overflow: 'hidden',
            marginTop: Math.max(2, titleFont * 0.12),
            fontSize: Math.max(8, titleFont * 0.68),
            fontWeight: 700,
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{surfacedIdentity}{surfacedOverflow}</div>
        </div>
      )}
      <AxiomNodeResizer nodeId={d.id} presentationScale={presentationScale} nodeWidth={width} nodeHeight={height} isVisible={selected}
        isResizable={typeof onResizeStart === 'function' && typeof onResizeEnd === 'function'}
        minWidth={d.minResizeWidth ?? 1}
        minHeight={d.minResizeHeight ?? 1}
        minWidthWest={d.minResizeWidthWest}
        minHeightNorth={d.minResizeHeightNorth} color={color}
        onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />
      {handles}
    </div>
  )
}
