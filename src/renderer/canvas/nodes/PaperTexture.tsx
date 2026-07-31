import React from 'react'

/**
 * Paper stock for every node on the canvas.
 *
 * Defined ONCE, at the document level, and referenced by every node through
 * `url(#…)`. SVG paint servers are shared, so a thousand cards cost one
 * definition — the alternative, a filter or pattern per node, would run
 * turbulence per card and make panning crawl.
 *
 * Two layers, because real paper is two things: FIBRE (random, fine, the
 * mottling you only notice up close) and LAID LINES (regular, directional, the
 * ghost of the screen it was pressed on). Either alone reads as noise or as
 * stripes; together they read as stock.
 *
 * Kept deliberately faint. This is a surface a person reads code on — texture
 * that competes with a filename is decoration, not craft. It is meant to be
 * felt rather than seen.
 */

/** Tile size in node-local units. Fixed, so grain is consistent per card. */
const TILE = 64

function PaperStock({
  id, fibre, laid, wash,
}: {
  id: string
  /** Random mottling. */
  fibre: string
  /** Directional press lines. */
  laid: string
  /** Overall tint laid under both. */
  wash: string
}) {
  const noiseId = `${id}-noise`
  return (
    <>
      <filter id={noiseId} x="0" y="0" width="100%" height="100%">
        {/* Two octaves: enough structure to read as fibre, cheap enough to
            rasterize once. More octaves buy nothing at this opacity. */}
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.9"
          numOctaves="2"
          stitchTiles="stitch"
          result="grain"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>

      <pattern id={id} width={TILE} height={TILE} patternUnits="userSpaceOnUse">
        <rect width={TILE} height={TILE} fill={wash} />
        <rect width={TILE} height={TILE} filter={`url(#${noiseId})`} opacity={fibre} />
        {/* Laid lines run slightly off-square so they never moiré against the
            canvas grid or a card's own rules. */}
        <g opacity={laid} transform="rotate(-1.2)">
          {Array.from({ length: 9 }, (_, index) => (
            <line
              key={index}
              x1={-TILE} y1={index * 8} x2={TILE * 2} y2={index * 8}
              stroke="#000" strokeWidth={0.4}
            />
          ))}
        </g>
      </pattern>
    </>
  )
}

/**
 * Mounted once, near the app root. Renders nothing visible — it exists only to
 * hold the paint servers the nodes point at.
 */
export function PaperTextureDefs() {
  return (
    <svg
      aria-hidden="true"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        {/* The Floor: warm neutral stock. */}
        <PaperStock id="axiom-paper" wash="transparent" fibre="0.055" laid="0.028" />
        {/* A sheet: the same stock under cooler light, so the proposal reads as
            a different surface without the nodes themselves being restyled. */}
        <PaperStock id="axiom-paper-sheet" wash="rgba(122,110,168,0.07)" fibre="0.07" laid="0.035" />
      </defs>
    </svg>
  )
}
