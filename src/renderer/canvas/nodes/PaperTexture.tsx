import React from 'react'
import paperUrl from '../../assets/textures/paper.png'

/**
 * Paper stock for sheet mode.
 *
 * A real scanned kraft tile (public domain - see the assets ATTRIBUTION), not
 * drawn geometry. Procedural ruling was the wrong instinct twice over: it read
 * as slanted stripes rather than as paper, and the rotation needed to stop it
 * moiréing broke tiling at the seams. A photograph of paper has grain that no
 * amount of line-drawing reproduces, and it tiles because it was authored to.
 *
 * ONLY SHEETS ARE PAPER. The Floor is the live map and stays clean; a sheet is
 * a proposal you have drawn on top of it, so it is the thing that gets a
 * surface. The texture fades in as you enter a sheet and out as you leave,
 * which is also the cheapest possible reminder of which mode you are in.
 *
 * Defined once, at the document level, and referenced by every node through
 * `url(#…)`. SVG paint servers are shared, so a thousand cards cost one
 * definition and one image decode.
 */

/**
 * Tile size in node-local units. The 384px source is compressed into this, so
 * the grain reads fine on a ~220-unit file card rather than as blotches.
 */
const TILE = 132

function Stock({ id, tint, tintOpacity, grain, scale = 1 }: {
  id: string
  /** Wash laid under the grain. Colour lives here, never in the asset. */
  tint: string
  tintOpacity: number
  /** How strongly the scanned fibre shows through. */
  grain: number
  /** Per-stock tile scale, so a container is coarser stock than its contents. */
  scale?: number
}) {
  const size = TILE * scale
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse">
      <rect width={size} height={size} fill={tint} opacity={tintOpacity} />
      <image
        href={paperUrl}
        width={size}
        height={size}
        opacity={grain}
        preserveAspectRatio="none"
      />
    </pattern>
  )
}

/**
 * Mounted once, near the app root. Renders nothing visible - it exists only to
 * hold the paint servers the nodes point at.
 *
 * The three stocks differ in tile scale and grain strength rather than in
 * drawing, so a system still reads as heavier board than the files inside it,
 * and infra as a cooler technical stock - same paper, different cut.
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
        {/* Files: the pad's writing surface - where the symbols are listed, so
            it is the plain sheet you write ON. The yellow belongs on the header
            band above it (see --card-head), the way a notepad's colour is its
            binding strip and never the page you write on. */}
        <Stock id="axiom-paper-sheet" tint="#faf6ea" tintOpacity={0.55} grain={0.26} />
        {/* Systems: manila folder. Warmer and browner, coarser stock - what you
            keep the pads in. */}
        <Stock id="axiom-card-sheet" tint="#e8cf9a" tintOpacity={0.44} grain={0.36} scale={1.9} />
        {/* Infra: white spec sheet. Cool and plain, so equipment reads as
            issued rather than hand-written. */}
        <Stock id="axiom-blueprint-sheet" tint="#f6f4ec" tintOpacity={0.5} grain={0.2} scale={1.3} />
      </defs>
    </svg>
  )
}
