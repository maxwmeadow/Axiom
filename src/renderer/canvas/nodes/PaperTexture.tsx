import React from 'react'

/**
 * Paper stock for the canvas.
 *
 * Defined ONCE, at the document level, and referenced by every node through
 * `url(#…)`. SVG paint servers are shared, so a thousand cards cost one
 * definition — a filter or pattern per node would run turbulence per card and
 * make panning crawl.
 *
 * There are three stocks, and which one a node gets is semantic. A file is
 * something you write on; a system is something you keep files in; infra is
 * something you spec. Giving each its own material means the hierarchy is
 * legible from the surface alone, before you read a single label:
 *
 *   WRITING PAPER  files      fine horizontal laid lines, light fibre
 *   FOLDER CARD    systems    heavier kraft fibre, vertical board grain
 *   BLUEPRINT      infra      fine technical grid, cool wash
 *
 * TILING. Anything rotated must be rotated with `patternTransform`, which turns
 * the whole tiling lattice, and never with a transform inside the tile. A tile
 * whose contents are rotated no longer matches its neighbours at the seams, and
 * the result is visible splits across every card — which is exactly what the
 * first version of this did.
 */

/** Tile size in node-local units. Fixed, so grain is consistent per card. */
const TILE = 64

function Fibre({ id, frequency, octaves }: { id: string; frequency: number; octaves: number }) {
  return (
    <filter id={id} x="0" y="0" width="100%" height="100%">
      <feTurbulence
        type="fractalNoise"
        baseFrequency={frequency}
        numOctaves={octaves}
        stitchTiles="stitch"
        result="grain"
      />
      <feColorMatrix type="saturate" values="0" />
    </filter>
  )
}

/** Writing paper: what a file is. Ruled, light, meant to be read on. */
function WritingPaper({ id, wash, fibre, rule }: {
  id: string; wash: string; fibre: number; rule: number
}) {
  const noiseId = `${id}-fibre`
  return (
    <>
      <Fibre id={noiseId} frequency={0.9} octaves={2} />
      {/* Ruling is 1.2 degrees off-square so it never moirés against the canvas
          grid. The rotation is on the lattice, so the tiles still meet. */}
      <pattern
        id={id}
        width={TILE} height={TILE}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(-1.2)"
      >
        <rect width={TILE} height={TILE} fill={wash} />
        <rect width={TILE} height={TILE} filter={`url(#${noiseId})`} opacity={fibre} />
        <g opacity={rule}>
          {/* 8 divides 64, so the ruling continues across the seam. */}
          {Array.from({ length: TILE / 8 }, (_, index) => (
            <line
              key={index}
              x1={0} y1={index * 8} x2={TILE} y2={index * 8}
              stroke="#000" strokeWidth={0.4}
            />
          ))}
        </g>
      </pattern>
    </>
  )
}

/**
 * Folder card: what a system is. Heavier stock, grain running the other way,
 * so a container reads as a different material from the things inside it.
 */
function FolderCard({ id, wash, fibre, grain }: {
  id: string; wash: string; fibre: number; grain: number
}) {
  const noiseId = `${id}-fibre`
  return (
    <>
      {/* Lower frequency, one more octave: coarser, more board-like than the
          fine tooth of writing paper. */}
      <Fibre id={noiseId} frequency={0.55} octaves={3} />
      <pattern
        id={id}
        width={TILE} height={TILE}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(0.6)"
      >
        <rect width={TILE} height={TILE} fill={wash} />
        <rect width={TILE} height={TILE} filter={`url(#${noiseId})`} opacity={fibre} />
        {/* Vertical board grain, irregularly spaced so it reads as fibre pulp
            rather than as ruling. */}
        <g opacity={grain}>
          {[3, 11, 18, 27, 34, 41, 49, 58].map(x => (
            <line
              key={x}
              x1={x} y1={0} x2={x} y2={TILE}
              stroke="#000"
              strokeWidth={x % 3 === 0 ? 0.7 : 0.35}
            />
          ))}
        </g>
      </pattern>
    </>
  )
}

/** Blueprint: what infrastructure is. Specified, gridded, technical. */
function Blueprint({ id, wash, fibre, grid }: {
  id: string; wash: string; fibre: number; grid: number
}) {
  const noiseId = `${id}-fibre`
  return (
    <>
      <Fibre id={noiseId} frequency={0.8} octaves={2} />
      <pattern id={id} width={TILE} height={TILE} patternUnits="userSpaceOnUse">
        <rect width={TILE} height={TILE} fill={wash} />
        <rect width={TILE} height={TILE} filter={`url(#${noiseId})`} opacity={fibre} />
        <g opacity={grid} stroke="#000" fill="none">
          {Array.from({ length: TILE / 16 }, (_, index) => (
            <React.Fragment key={index}>
              <line x1={0} y1={index * 16} x2={TILE} y2={index * 16} strokeWidth={0.35} />
              <line x1={index * 16} y1={0} x2={index * 16} y2={TILE} strokeWidth={0.35} />
            </React.Fragment>
          ))}
        </g>
      </pattern>
    </>
  )
}

/**
 * Mounted once, near the app root. Renders nothing visible — it exists only to
 * hold the paint servers the nodes point at.
 *
 * Each stock has a sheet variant under cooler light, so a proposal surface
 * reads as different paper without any node component knowing sheets exist.
 */
export function PaperTextureDefs() {
  const sheetWash = 'rgba(122,110,168,0.08)'
  return (
    <svg
      aria-hidden="true"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        <WritingPaper id="axiom-paper" wash="transparent" fibre={0.055} rule={0.03} />
        <WritingPaper id="axiom-paper-sheet" wash={sheetWash} fibre={0.07} rule={0.038} />

        <FolderCard id="axiom-card" wash="rgba(140,120,86,0.05)" fibre={0.085} grain={0.05} />
        <FolderCard id="axiom-card-sheet" wash={sheetWash} fibre={0.095} grain={0.055} />

        <Blueprint id="axiom-blueprint" wash="rgba(70,110,130,0.04)" fibre={0.05} grid={0.05} />
        <Blueprint id="axiom-blueprint-sheet" wash={sheetWash} fibre={0.06} grid={0.06} />
      </defs>
    </svg>
  )
}
