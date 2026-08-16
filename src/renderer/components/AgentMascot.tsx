import { useId } from 'react'
import '../styles/agentMascot.css'

export type AgentMascotState = 'sleeping' | 'connected' | 'proposal-ready'

export interface AgentMascotProps {
  state: AgentMascotState
  hostLabel?: string
  className?: string
}

/**
 * Axiom Field Agent Mascot - "Theodolite" (Final Synthesis).
 *
 * Synthesizes:
 * 1. Identity & Anatomy (Claude): Asymmetric skull, oversized theodolite lens barrel,
 *    companion eye, eyeshade visor, rubber-hose limbs, and drafting-compass legs.
 * 2. Wardrobe & Instrumentation (Gemini): Tailored surveyor coat with lapels, cravat,
 *    surveyor shield badge, tool pocket (ivory ruler + mini compass), micrometer ear dials,
 *    and phosphor-bronze coiled spring antenna with crown beacon bulb.
 * 3. Grounded Sleeping Pose (Codex): Seated naturally on its own rolled survey sheet,
 *    with compass legs folded cleanly to the side along the ground plane.
 * 4. Proposal Reveal & Graph (Gemini + Claude): Top-down vertical blueprint unfurl,
 *    repaired node-edge graph topology, and physical brass check-mark stamp payoff.
 */

const NS = 'axiom-final-gemini'
const cn = (...parts: string[]) => parts.map((p) => (p.startsWith(NS) ? p : `${NS}__${p}`)).join(' ')

type Mood = 'asleep' | 'connected' | 'proposal-ready'

/* ------------------------------------------------------------------ Head - */

interface HeadProps {
  mood: 'asleep' | 'connected' | 'proposal-ready'
  instanceId: string
}

function Head({ mood, instanceId }: HeadProps) {
  const brassId = `${NS}-brass-${instanceId}`

  return (
    <g className={cn('head', `head--${mood}`)}>
      {/* Ear Dials (Micrometer Knobs) */}
      <g className={cn('earDial', 'earDial--left')}>
        <rect
          className={cn('brassFill')}
          fill={`url(#${brassId})`}
          x="-37"
          y="-12"
          width="8"
          height="22"
          rx="3"
        />
        <path className={cn('hair')} d="M-37 -6 h8 M-37 0 h8 M-37 6 h8" />
        <circle className={cn('rivet')} cx="-33" cy="0" r="1.5" />
      </g>
      <g className={cn('earDial', 'earDial--right')}>
        <rect
          className={cn('brassFill')}
          fill={`url(#${brassId})`}
          x="29"
          y="-12"
          width="8"
          height="22"
          rx="3"
        />
        <path className={cn('hair')} d="M29 -6 h8 M29 0 h8 M29 6 h8" />
        <circle className={cn('rivet')} cx="33" cy="0" r="1.5" />
      </g>

      {/* Lower Face & Jaw (Preserved Ivory Paper Face) */}
      <path
        className={cn('paper')}
        d="M-31 -18 C-31 -5 -31 10 -31 16 C-31 32 -18 38 0 38 C18 38 31 32 31 16 C31 10 31 -5 31 -18 Z"
      />
      {/* Riveted service seam on plain cheek */}
      <path className={cn('hair')} d="M22 -4 V22" />
      <circle className={cn('rivet')} cx="26" cy="-1" r="1.7" />
      <circle className={cn('rivet')} cx="26" cy="13" r="1.7" />

      {/* Tailored Surveyor Field Cap Crown (Cohesive headwear replacing bald dome) */}
      <path
        className={cn('sage')}
        d="M-32 -18 C-32 -38 -24 -52 0 -52 C24 -52 32 -38 32 -18 Z"
      />
      {/* Cap crown shadow & center seam */}
      <path
        className={cn('coatShadow')}
        d="M0 -52 C18 -52 32 -40 32 -18 C20 -20 0 -20 0 -52 Z"
      />
      <path className={cn('hair')} d="M0 -52 V-24" />

      {/* Brass Cap Crest Mount for Spirit Level */}
      <rect
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        x="-14"
        y="-55"
        width="28"
        height="5"
        rx="2"
      />

      {/* Spirit Level on Crown */}
      <path className={cn('hair')} d="M-11 -55 v-4 M11 -55 v-4" />
      <rect
        className={cn('spiritFrame')}
        fill={`url(#${brassId})`}
        x="-22"
        y="-68"
        width="44"
        height="13"
        rx="6.5"
      />
      <path className={cn('hair')} d="M-6 -66 v9 M6 -66 v9" />
      <circle
        className={cn('spiritBubble')}
        cx={mood === 'asleep' ? -14 : 0}
        cy="-61.5"
        r="3.6"
      />

      {/* Coiled Spring Antenna & Crown Beacon (Gemini addition) */}
      <g className={cn('beaconGroup')}>
        <path className={cn('antennaStem')} d="M0 -68 Q-5 -74 0 -79 Q5 -84 0 -89" />
        <path className={cn('antennaCoil')} d="M-4 -74 H4 M-4 -79 H4 M-4 -84 H4" />
        <ellipse
          className={cn('beaconCollar')}
          fill={`url(#${brassId})`}
          cx="0"
          cy="-89"
          rx="8"
          ry="3"
        />
        <path className={cn('beaconCage')} d="M-7 -89 C-7 -95 -3 -100 0 -101 C3 -100 7 -95 7 -89" />
        <path className={cn('beaconFinial')} d="M0 -101 V -105" />

        {mood !== 'connected' && (
          <>
            {/* Sleeping and proposal states retain the crown beacon. */}
            <circle className={cn('beaconAura')} cx="0" cy="-95" r="16" />
            <circle className={cn('beaconBulb')} cx="0" cy="-95" r="5.5" />
            <circle className={cn('beaconShine')} cx="-1.8" cy="-96.8" r="1.6" />
          </>
        )}

        {/* Connected Omnidirectional Telemetry Broadcast (Multi-directional Wave Arcs + Surveyor Datum Particles) */}
        {mood === 'connected' && (
          <g className={cn('telemetryBroadcast')} transform="translate(0 -95)">
            {/* Omnidirectional Wave Arcs: Left, Right & Overhead Zenith */}
            {/* Inner Left & Right Arcs */}
            <path className={cn('telemetryWave', 'telemetryWave--inner')} d="M-13 -8 A16 16 0 0 0 -18 6 M13 -8 A16 16 0 0 1 18 6" />
            {/* Outer Left & Right Arcs */}
            <path className={cn('telemetryWave', 'telemetryWave--outer')} d="M-22 -14 A26 26 0 0 0 -28 10 M22 -14 A26 26 0 0 1 28 10" />
            {/* Overhead Zenith Arc */}
            <path className={cn('telemetryWave', 'telemetryWave--zenith')} d="M-14 -18 A20 20 0 0 1 14 -18" />

            {/* Creative Floating Surveyor Telemetry Sparkles & Coordinate Datum Particles */}
            {/* Sparkle 1: Top-Left Surveyor Diamond */}
            <g className={cn('telemetryDatum', 'telemetryDatum--1')}>
              <path className={cn('telemetryDiamond')} d="M-18 -22 L-15 -25 L-12 -22 L-15 -19 Z" />
            </g>

            {/* Sparkle 2: Top-Right Crosshair Target Ping */}
            <g className={cn('telemetryDatum', 'telemetryDatum--2')}>
              <circle className={cn('telemetryReticle')} cx="20" cy="-22" r="3.5" />
              <path className={cn('telemetryCross')} d="M15 -22 H25 M20 -27 V-17" />
            </g>

            {/* Sparkle 3: Left Coordinate Delta Glyph */}
            <g className={cn('telemetryDatum', 'telemetryDatum--3')}>
              <text className={cn('telemetryGlyph')} x="-24" y="-4">
                Δ
              </text>
            </g>

            {/* Sparkle 4: Right Benchmark Sparkle Star */}
            <g className={cn('telemetryDatum', 'telemetryDatum--4')}>
              <path className={cn('telemetryStar')} d="M22 -2 L23.5 -5 L26.5 -6.5 L23.5 -8 L22 -11 L20.5 -8 L17.5 -6.5 L20.5 -5 Z" />
            </g>

            {/* Sparkle 5: Overhead Degree Pulse */}
            <g className={cn('telemetryDatum', 'telemetryDatum--5')}>
              <circle className={cn('telemetryDegree')} cx="0" cy="-28" r="2.2" />
            </g>
          </g>
        )}

        {/* Proposal Sparkle Rays */}
        {mood === 'proposal-ready' && (
          <g className={cn('proposalSparkles')}>
            <path
              d="M0 -113 V -107 M0 -83 V -77 M-14 -95 H -8 M8 -95 H 14 M-10 -105 L -5 -100 M10 -85 L 5 -90 M10 -105 L 5 -100 M-10 -85 L -5 -90"
              className={cn('sparkleRay')}
            />
          </g>
        )}
      </g>

      {/* Cap Headband with Brass Side Studs */}
      <path className={cn('cravat')} d="M-32 -24 C-16 -21 16 -21 32 -24 L32 -18 C16 -15 -16 -15 -32 -18 Z" />
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="-28"
        cy="-20"
        r="2.2"
      />
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="28"
        cy="-20"
        r="2.2"
      />

      {/* Cap Visor / Brim (Extending naturally from the cap band over the brow) */}
      {mood === 'asleep' ? (
        <g className={cn('visor')}>
          <path
            className={cn('sage')}
            d="M-36 -18 C-20 -4 20 -4 36 -18 C26 -6 -26 -6 -36 -18 Z"
          />
          <path className={cn('visorBrim')} d="M-34 -18 C-18 -6 18 -6 34 -18" />
        </g>
      ) : (
        <g className={cn('visor')}>
          <path
            className={cn('sage')}
            d="M-36 -18 C-20 -10 20 -10 36 -18 C26 -6 -26 -6 -36 -18 Z"
          />
          <path className={cn('visorBrim')} d="M-34 -18 C-18 -10 18 -10 34 -18" />
        </g>
      )}

      {/* Theodolite Lens Barrel - Oversized left reading optic (Claude + Gemini) */}
      <rect
        className={cn('brass')}
        fill={`url(#${brassId})`}
        x="-36"
        y="-10"
        width="13"
        height="20"
        rx="6"
      />
      <circle className={cn('paper')} cx="-12" cy="0" r="16.5" />
      <circle
        className={cn('brassRing')}
        fill={`url(#${brassId})`}
        cx="-12"
        cy="0"
        r="11"
      />

      {mood === 'asleep' ? (
        <path className={cn('lid')} d="M-25 -1 q13 10 26 0" />
      ) : (
        <g className={cn('iris')}>
          <circle cx="-12" cy={mood === 'proposal-ready' ? -1.5 : 0} r="6.6" className={cn('irisBody')} />
          {mood === 'connected' && (
            <path className={cn('lensReticle')} d="M-17 0 H-7 M-12 -5 V5" />
          )}
          {mood === 'proposal-ready' ? (
            <path
              className={cn('starGlint')}
              d="M-12 -6 L-10.8 -2.8 L-7.5 -1.5 L-10.8 -0.2 L-12 3 L-13.2 -0.2 L-16.5 -1.5 L-13.2 -2.8 Z"
            />
          ) : (
            <circle className={cn('glint')} cx="-15" cy="-2.5" r="2.1" />
          )}
        </g>
      )}

      {/* Knurled focus knob underneath lens */}
      <circle
        className={cn('brass')}
        fill={`url(#${brassId})`}
        cx="-33"
        cy="16"
        r="5.4"
      />
      <path className={cn('hair')} d="M-33 11 v-3 M-38 18 h-3 M-28 18 h3" />

      {/* Companion Right Eye */}
      {mood === 'asleep' ? (
        <>
          <path className={cn('lid')} d="M9 2 q7.5 7 15 0" />
          <path className={cn('hair')} d="M13 7 l-1 3 M20 7 l1 3" />
        </>
      ) : mood === 'proposal-ready' ? (
        <g>
          <path className={cn('wink')} d="M9 5 q7.5 -9 15 0" />
          <path className={cn('winkCrinkle')} d="M8 8 l-3 3 M25 8 l3 3" />
        </g>
      ) : (
        <>
          <circle className={cn('paper')} cx="16" cy="2" r="8" />
          <circle className={cn('pupil')} cx="17.5" cy="2" r="3.6" />
          <circle className={cn('glint')} cx="16" cy="0.5" r="1.2" />
        </>
      )}

      {/* Mouth */}
      {mood === 'asleep' && (
        <>
          <ellipse className={cn('mouthOpen')} cx="0" cy="25" rx="4.6" ry="5.6" />
          <path className={cn('hair')} d="M8 22 q5 3 9 1" />
          <circle className={cn('cheekBlush')} cx="-18" cy="18" r="3.5" />
          <circle className={cn('cheekBlush')} cx="20" cy="18" r="3.5" />
        </>
      )}
      {mood === 'connected' && (
        <>
          <path className={cn('mouth')} d="M-7 22 q9 7 17 -3" />
          <circle className={cn('cheekLive')} cx="-18" cy="18" r="4" />
          <circle className={cn('cheekLive')} cx="22" cy="18" r="4" />
        </>
      )}
      {mood === 'proposal-ready' && (
        <>
          <path className={cn('grin')} d="M-11 19 q13 16 25 -2 q-12 5 -25 2 Z" />
          <path className={cn('toothLine')} d="M-9 20 Q1 23 12 18" />
          <path className={cn('hair')} d="M-27 16 h-6 M-26 21 l-5 3" />
          <circle className={cn('cheekGold')} cx="-18" cy="18" r="4.5" />
          <circle className={cn('cheekGold')} cx="22" cy="18" r="4.5" />
        </>
      )}
    </g>
  )
}

/* ----------------------------------------------------------------- Torso - */

interface TorsoProps {
  instanceId: string
}

function Torso({ instanceId }: TorsoProps) {
  const brassId = `${NS}-brass-${instanceId}`

  return (
    <g className={cn('torso')}>
      {/* Tailored Canvas & Enamel Field Coat */}
      <path
        className={cn('sage')}
        d="M-30 -36 C-30 -47 30 -47 30 -36 L35 24 C37 44 -37 44 -35 24 Z"
      />
      <path className={cn('coatShadow')} d="M0 -36 C18 -36 30 -42 30 -36 L35 24 C37 44 10 44 0 42 Z" />
      <path className={cn('coatHatch')} d="M-28 -30 L-20 -38 M-24 -20 L-14 -30 M-20 -10 L-8 -22" />

      {/* Cream Notched Lapels - Extends fully across collar to both shoulder seams */}
      <path className={cn('lapel')} d="M-20 -38 L-28 -36 L-30 -22 L-16 0 L-4 -8 Z" />
      <path className={cn('lapel')} d="M20 -38 L28 -36 L30 -22 L16 0 L4 -8 Z" />

      {/* Dark Green Cravat & Brass Tie-Pin */}
      <path className={cn('cravat')} d="M-5 -14 L0 -19 L5 -14 L4 3 L0 7 L-4 3 Z" />
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="0"
        cy="-7"
        r="1.8"
      />

      {/* Polished Brass Coat Buttons */}
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="0"
        cy="13"
        r="2.8"
      />
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="0"
        cy="26"
        r="2.8"
      />

      {/* Left Breast Tool Pocket (Ivory Ruler + Mini Brass Compass) */}
      <g className={cn('pocket')}>
        {/* Ivory Drafting Ruler */}
        <rect className={cn('ruler')} x="-25" y="-6" width="5.5" height="13" rx="1" />
        <path className={cn('rulerTicks')} d="M-25 -3 h2.5 M-25 0 h3.5 M-25 3 h2.5" />
        {/* Miniature Brass Divider / Compass */}
        <path className={cn('miniCompass')} d="M-17 -4 L-14 3 M-17 -4 L-20 3" />
        <circle className={cn('miniCompassJoint')} cx="-17" cy="-4" r="1.3" />
        {/* Pocket Pouch */}
        <path className={cn('pocketPouch')} d="M-27 2 H-11 V14 C-11 18 -15 20 -19 20 C-23 20 -27 18 -27 14 Z" />
      </g>

      {/* Axiom Field Surveyor Shield Badge (Right Chest) */}
      <g className={cn('badge')}>
        <path
          className={cn('badgeShield')}
          fill={`url(#${brassId})`}
          d="M13 4 H25 V13 C25 18 19 21 19 21 C19 21 13 18 13 13 Z"
        />
        <path className={cn('badgeDelta')} d="M15 7 H23 L19 14 Z" />
      </g>
    </g>
  )
}

/* ------------------------------------------------------------------ Legs - */

interface CompassLegsProps {
  spread: number
  instanceId: string
}

function CompassLegs({ spread, instanceId }: CompassLegsProps) {
  const brassId = `${NS}-brass-${instanceId}`

  return (
    <g className={cn('legs')}>
      {/* Left Needle Leg */}
      <g transform={`rotate(${-spread})`}>
        <path className={cn('paper')} d="M-9 -4 L3 -4 L-5 72 L-15 70 Z" />
        <path className={cn('needle')} d="M-15 70 L-5 72 L-9 94 Z" />
      </g>

      {/* Right Graphite Leg with Brass Ferrule */}
      <g transform={`rotate(${spread})`}>
        <path className={cn('paper')} d="M-3 -4 L9 -4 L15 72 L5 74 Z" />
        <rect
          className={cn('brassFill')}
          fill={`url(#${brassId})`}
          x="4"
          y="60"
          width="13"
          height="8"
          rx="1.5"
          transform="rotate(6 10 64)"
        />
        <path className={cn('graphite')} d="M5 74 L15 72 L12 92 Z" />
      </g>

      {/* Central Brass Hip Pivot Joint */}
      <circle
        className={cn('brassFill')}
        fill={`url(#${brassId})`}
        cx="0"
        cy="0"
        r="10"
      />
      <circle className={cn('rivet')} cx="0" cy="0" r="2.6" />
    </g>
  )
}

/* --------------------------------------------------------------- Helpers - */

function RubberHoseArm({ d, className }: { d: string; className?: string }) {
  return (
    <g className={className}>
      <path className={cn('hoseInk')} d={d} />
      <path className={cn('hoseCore')} d={d} />
    </g>
  )
}

function SurveyorGlove({
  x,
  y,
  r = 0,
  className,
}: {
  x: number
  y: number
  r?: number
  className?: string
}) {
  return (
    <g className={className}>
      <g transform={`translate(${x} ${y}) rotate(${r})`}>
        <path
          className={cn('paper')}
          d="M-11 -4 C-13 -13 -4 -18 4 -14 C12 -17 18 -10 15 -2 C18 6 11 13 3 11 C-6 13 -13 6 -11 -4 Z"
        />
        <path className={cn('hair')} d="M-4 -12 q3 8 0 15 M6 -13 q3 8 1 16" />
        <ellipse className={cn('gloveCuff')} cx="0" cy="11" rx="7" ry="3" />
      </g>
    </g>
  )
}

/* -------------------------------------------------------- Blueprint Sheet - */

interface BlueprintSheetProps {
  instanceId: string
}

function BlueprintSheet({ instanceId }: BlueprintSheetProps) {
  const gridId = `${NS}-grid-${instanceId}`

  return (
    <g className={cn('sheet')}>
      {/* Parchment Drop Shadow */}
      <rect
        className={cn('sheetShadow')}
        x="68"
        y="156"
        width="184"
        height="114"
        rx="4"
      />

      {/* Blueprint Teal Body */}
      <rect
        className={cn('sheetBody')}
        x="68"
        y="152"
        width="184"
        height="114"
        rx="4"
      />

      {/* Coordinate Drafting Grid Fill */}
      <rect
        className={cn('sheetGridFill')}
        fill={`url(#${gridId})`}
        x="68"
        y="152"
        width="184"
        height="114"
        rx="4"
      />

      {/* Paper Fold Creases */}
      <path className={cn('sheetFold')} d="M129 152 V266 M190 152 V266" />

      {/* Title Header Text without distracting white highlight bar */}
      <text className={cn('sheetTitle')} x="78" y="166">
        AXIOM ARCHITECTURE MAP // VERIFIED
      </text>

      {/* ========================================================
          Repaired Architecture Graph Topology
          Node 1: CLIENT (x: 78, y: 180, w: 36, h: 20)
          Node 2: CORE   (x: 139, y: 174, w: 42, h: 26) - Key Node
          Node 3: CANVAS (x: 206, y: 180, w: 38, h: 20)
          Node 4: MCP    (x: 139, y: 222, w: 42, h: 20)
          ======================================================== */}

      {/* Routed Edges - Terminate cleanly at node borders */}
      {/* Edge: CLIENT -> CORE (Right of Client at 114 to Left of Core at 139, y=190) */}
      <path className={cn('sheetEdge')} d="M 114 190 H 139" />
      <circle className={cn('sheetPin', 'sheetPin--live')} cx="126.5" cy="190" r="2" />

      {/* Edge: CORE -> CANVAS (Right of Core at 181 to Left of Canvas at 206, y=190) */}
      <path className={cn('sheetEdge')} d="M 181 190 H 206" />
      <circle className={cn('sheetPin', 'sheetPin--live')} cx="193.5" cy="190" r="2" />

      {/* Edge: CORE -> MCP (Bottom of Core at 200 to Top of MCP at 222, x=160) */}
      <path className={cn('sheetEdge')} d="M 160 200 V 222" />
      <circle className={cn('sheetPin', 'sheetPin--live')} cx="160" cy="211" r="2" />

      {/* Edge: CLIENT -> MCP Bus Feed (Bottom of Client at (96, 200) -> (96, 232) -> Left of MCP at (139, 232)) */}
      <path className={cn('sheetEdge', 'sheetEdge--bus')} d="M 96 200 V 232 H 139" />
      <circle className={cn('sheetPin')} cx="96" cy="200" r="1.8" />

      {/* Node 1: CLIENT */}
      <g className={cn('node')}>
        <rect className={cn('sheetNode')} x="78" y="180" width="36" height="20" rx="2" />
        <rect className={cn('nodeBar')} x="78" y="180" width="36" height="5" rx="1" />
        <text className={cn('nodeLabel')} x="84" y="194">
          CLIENT
        </text>
      </g>

      {/* Node 2: CORE (Highlighted Centerpiece) */}
      <g className={cn('node', 'node--core')}>
        <rect className={cn('sheetNode', 'sheetNode--core')} x="139" y="174" width="42" height="26" rx="2" />
        <rect className={cn('nodeGlow')} x="138" y="173" width="44" height="28" rx="3" />
        <rect className={cn('nodeBar', 'nodeBar--core')} x="139" y="174" width="42" height="6" rx="1" />
        <text className={cn('nodeLabel', 'nodeLabel--core')} x="148" y="192">
          CORE
        </text>
      </g>

      {/* Node 3: CANVAS */}
      <g className={cn('node')}>
        <rect className={cn('sheetNode')} x="206" y="180" width="38" height="20" rx="2" />
        <rect className={cn('nodeBar')} x="206" y="180" width="38" height="5" rx="1" />
        <text className={cn('nodeLabel')} x="210" y="194">
          CANVAS
        </text>
      </g>

      {/* Node 4: MCP */}
      <g className={cn('node')}>
        <rect className={cn('sheetNode')} x="139" y="222" width="42" height="20" rx="2" />
        <rect className={cn('nodeBar')} x="139" y="222" width="42" height="5" rx="1" />
        <text className={cn('nodeLabel')} x="151" y="236">
          MCP
        </text>
      </g>

      {/* Verification Legend (Bottom Left) */}
      <path className={cn('sheetLine')} d="M78 248 h42 M78 254 h28" />

      {/* Struck Brass Approval Stamp Payoff (Positioned on the far right) */}
      <g className={cn('stamp')}>
        <g transform="translate(220 236) rotate(-12)">
          <circle className={cn('stampWash')} cx="0" cy="0" r="20" />
          <circle className={cn('stampRing')} cx="0" cy="0" r="20" />
          <circle className={cn('stampInner')} cx="0" cy="0" r="14" />
          <path className={cn('stampCheck')} d="M-6 0 l5 6 l10 -13" />
        </g>
      </g>

      {/* Impact Starburst Flash */}
      <g className={cn('stampBurst')}>
        <g transform="translate(220 236)">
          <path d="M0 -28 V-36 M20 -20 l6 -6 M28 0 h8 M20 20 l6 6 M-20 -20 l-6 -6 M-28 0 h-8" />
        </g>
      </g>
    </g>
  )
}

/* ------------------------------------------------------------- Main State - */

export function AgentMascot({ state, hostLabel, className }: AgentMascotProps) {
  const rawId = useId()
  const instanceId = rawId.replace(/[^a-zA-Z0-9_-]/g, '')

  const brassId = `${NS}-brass-${instanceId}`
  const sageId = `${NS}-sage-${instanceId}`
  const gridId = `${NS}-grid-${instanceId}`
  const titleId = `${NS}-title-${instanceId}`
  const descId = `${NS}-desc-${instanceId}`

  const host = hostLabel?.trim() || 'the agent'

  const copy =
    state === 'sleeping'
      ? {
          title: 'Field agent asleep',
          desc: `The Axiom field agent is resting seated on its rolled survey sheet with its compass legs folded to the side, visor drawn over its theodolite lens, and crown beacon dormant. No agent is connected.`,
          caption: 'Asleep - no agent connected.',
        }
      : state === 'connected'
        ? {
            title: 'Field agent awake and listening',
            desc: `The Axiom field agent has sprung upright on its compass legs, thumbed its visor back, and is calibrating its theodolite lens while its level bubble glows live green with active telemetry. ${host} is connected and listening.`,
            caption: `Awake - ${host} is connected and listening.`,
          }
        : {
            title: 'Field agent presenting the survey',
            desc: `The Axiom field agent is grinning triumphantly over the top edge of a verified architecture blueprint held open in both mitts, showing clean mapped systems and a freshly struck brass approval stamp. The architecture proposal from ${host} is ready to review.`,
            caption: `Survey complete - the architecture proposal from ${host} is ready to review.`,
          }

  return (
    <div className={[NS, className].filter(Boolean).join(' ')} data-state={state}>
      <svg
        viewBox="0 0 320 320"
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        className={cn('svg')}
      >
        <title id={titleId}>{copy.title}</title>
        <desc id={descId}>{copy.desc}</desc>

        <defs>
          {/* Metallic Polished Brass Linear Gradient */}
          <linearGradient id={brassId} x1="0" y1="0" x2="0.75" y2="1">
            <stop offset="0" stopColor="#f6e39d" />
            <stop offset="0.48" stopColor="#d8b151" />
            <stop offset="1" stopColor="#8d641d" />
          </linearGradient>

          {/* Enamel Sage Shell Gradient */}
          <linearGradient id={sageId} x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#a4bea0" />
            <stop offset="0.5" stopColor="#819b8e" />
            <stop offset="1" stopColor="#5d7b6d" />
          </linearGradient>

          {/* Blueprint Drafting Coordinate Grid Pattern */}
          <pattern id={gridId} width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M12 0 V12 M0 12 H12" className={cn('sheetGridLine')} />
          </pattern>
        </defs>

        {/* Ground Contact Shadow */}
        <ellipse className={cn('groundShadow')} cx="160" cy="288" rx="88" ry="12" />

        {/* ========================================================
            1. SLEEPING POSE (Codex Grounded Survey Roll + Claude Character)
            ======================================================== */}
        {state === 'sleeping' && (
          <g className={cn('pose', 'pose--sleeping')}>
            {/* Drifting Surveyor Slumber Dream Particles */}
            <g className={cn('sleepMarks')}>
              {/* Particle 1: Small Sleepy z + Tiny Cross Spark */}
              <g className={cn('mark', 'mark--1')}>
                <g transform="translate(196 142)">
                  <path className={cn('markZ')} d="M-3.5 -4.5 H3.5 L-3.5 4.5 H3.5" />
                  <path className={cn('markSpark')} d="M7 -2 H11 M9 -4 V0" />
                </g>
              </g>

              {/* Particle 2: Surveyor Target Reticle */}
              <g className={cn('mark', 'mark--2')}>
                <g transform="translate(222 118)">
                  <circle className={cn('markRing')} cx="0" cy="0" r="6" />
                  <path className={cn('markCross')} d="M-9 0 H9 M0 -9 V9" />
                </g>
              </g>

              {/* Particle 3: Medium Drafting Z with Crossbar + Delta */}
              <g className={cn('mark', 'mark--3')}>
                <g transform="translate(244 94)">
                  <path className={cn('markZ', 'markZ--med')} d="M-5.5 -7 H5.5 L-5.5 7 H5.5 M-2.5 0 H2.5" />
                  <text className={cn('markDeltaText')} x="10" y="2">
                    Δ
                  </text>
                </g>
              </g>

              {/* Particle 4: Degree Bubble + Benchmark Star */}
              <g className={cn('mark', 'mark--4')}>
                <g transform="translate(262 70)">
                  <circle className={cn('markDegree')} cx="-5" cy="-4" r="2.5" />
                  <path className={cn('markCross')} d="M3 -4 L9 4 M3 4 L9 -4" />
                </g>
              </g>

              {/* Particle 5: Large Sleepy Drafting Z */}
              <g className={cn('mark', 'mark--5')}>
                <g transform="translate(278 46)">
                  <path className={cn('markZ', 'markZ--large')} d="M-7 -9 H7 L-7 9 H7 M-3.5 0 H3.5" />
                </g>
              </g>

              {/* Particle 6: Drafting Angle Notation & Sparkle */}
              <g className={cn('mark', 'mark--6')}>
                <g transform="translate(254 36)">
                  <path className={cn('markAngle')} d="M-4 -5 L-4 3 H4 M-2 0 A3 3 0 0 0 -4 -2" />
                  <circle className={cn('markDegree')} cx="7" cy="-2" r="1.8" />
                </g>
              </g>
            </g>

            {/* Hefty Rolled Survey Plan */}
            <g className={cn('surveyRoll')} transform="translate(150 270) rotate(-2)">
              <rect className={cn('rollBody')} x="-86" y="-13" width="172" height="26" rx="13" />
              <ellipse className={cn('rollEnd')} cx="86" cy="0" rx="7" ry="13" />
              <path className={cn('rollSpiral')} d="M86 -8 C83 -5 83 5 86 8 C88 10 90 6 88 0" />
              <path className={cn('rollRibbon')} d="M-42 -14 Q-46 0 -42 14 M32 -14 Q28 0 32 14" />
              <path className={cn('rollBow')} d="M-44 -14 Q-48 -22 -40 -20 Q-42 -14 -44 -14" />
            </g>

            {/* Main Seated Body on Roll - ALL limbs, torso, and head move together in breather animation */}
            <g className={cn('body', 'breather')}>
              {/* Right Arm (Back arm): emerges naturally from behind right shoulder (178, 182) */}
              <RubberHoseArm className={cn('arm')} d="M178 182 C204 204 216 230 208 252" />
              <SurveyorGlove x={208} y={254} r={18} />

              {/* Torso & Compass Legs seated on top of roll at (152, 216) */}
              <g transform="translate(152 216) rotate(-4)">
                <Torso instanceId={instanceId} />
                {/* Compass Legs locked directly onto the shirt button center axis (x=0, y=38) */}
                <g transform="translate(0 38) rotate(-72)">
                  <CompassLegs spread={5} instanceId={instanceId} />
                </g>
              </g>

              {/* Left Arm (Front arm): emerges cleanly from left shoulder (122, 184) down to roll */}
              <RubberHoseArm className={cn('arm')} d="M122 184 C102 204 96 230 100 250" />
              <SurveyorGlove x={100} y={254} r={-16} />

              {/* Rubber-hose Neck */}
              <path className={cn('neckInk')} d="M147 186 q-2 9 3 16" />
              <path className={cn('neck')} d="M147 186 q-2 9 3 16" />

              {/* Slumped Asleep Head */}
              <g className={cn('headMount')}>
                <g transform="translate(138 154) rotate(-14)">
                  <Head mood="asleep" instanceId={instanceId} />
                </g>
              </g>
            </g>
          </g>
        )}

        {/* ========================================================
            2. CONNECTED POSE (Claude Expressive Focus + Gemini Telemetry)
            ======================================================== */}
        {state === 'connected' && (
          <g className={cn('pose', 'pose--connected')}>
            {/* Upright Active Body - ALL limbs, torso, and head move together in breather animation */}
            <g className={cn('body', 'breatherAwake')}>
              {/* Right Arm (Back arm): starts cleanly from behind right shoulder (186, 126) */}
              <RubberHoseArm className={cn('arm')} d="M186 126 C214 134 230 160 228 180" />
              <SurveyorGlove x={228} y={186} r={22} />

              {/* Torso & Compass Legs centered at (160, 158) */}
              <g transform="translate(160 158)">
                <Torso instanceId={instanceId} />
                {/* Compass Legs locked directly onto the shirt button center axis (x=0, y=38) */}
                <g transform="translate(0 38)">
                  <CompassLegs spread={17} instanceId={instanceId} />
                </g>
              </g>

              {/* Left Arm (Front arm): starts cleanly from left shoulder (132, 126) tuning focus knob */}
              <RubberHoseArm className={cn('arm')} d="M132 126 C108 122 104 110 118 104" />
              <SurveyorGlove x={118} y={104} r={-28} className={cn('focusHand')} />

              {/* Neck */}
              <path className={cn('neckInk')} d="M154 128 q0 9 4 14" />
              <path className={cn('neck')} d="M154 128 q0 9 4 14" />

              {/* Alert Head */}
              <g className={cn('headMount')}>
                <g transform="translate(158 96) rotate(4)">
                  <Head mood="connected" instanceId={instanceId} />
                </g>
              </g>
            </g>
          </g>
        )}

        {/* ========================================================
            3. PROPOSAL-READY POSE (Gemini Top-Down Reveal + Claude Blueprint)
            ======================================================== */}
        {state === 'proposal-ready' && (
          <g className={cn('pose', 'pose--proposal')}>
            {/* Proud Upright Body - ALL limbs, torso, head, and map move together */}
            <g className={cn('body')}>
              {/* Left Arm: starts from behind left shoulder (134, 130) arching to map edge */}
              <RubberHoseArm className={cn('arm')} d="M134 130 C110 120 86 138 76 164" />

              {/* Right Arm: starts from behind right shoulder (186, 130) arching to map edge */}
              <RubberHoseArm className={cn('arm')} d="M186 130 C210 120 234 138 244 164" />

              {/* Torso & Compass Legs centered at (160, 158) */}
              <g transform="translate(160 158)">
                <Torso instanceId={instanceId} />
                {/* Compass Legs locked directly onto the shirt button center axis (x=0, y=38) */}
                <g transform="translate(0 38)">
                  <CompassLegs spread={20} instanceId={instanceId} />
                </g>
              </g>

              {/* Neck - centered directly between torso (x=160) and head (x=160) */}
              <path className={cn('neckInk')} d="M160 126 v14" />
              <path className={cn('neck')} d="M160 126 v14" />

              {/* Pleased Head - centered at (160, 92) */}
              <g className={cn('headMount')}>
                <g transform="translate(160 92)">
                  <Head mood="proposal-ready" instanceId={instanceId} />
                </g>
              </g>

              {/* Unfurled Blueprint Sheet */}
              <BlueprintSheet instanceId={instanceId} />

              {/* Hands Gripping Blueprint */}
              <SurveyorGlove x={76} y={164} r={-18} />
              <SurveyorGlove x={244} y={164} r={18} />
            </g>
          </g>
        )}
      </svg>

      {/* Accessible Polite Status Caption */}
      <p className={cn('caption')} aria-live="polite">
        {copy.caption}
      </p>
    </div>
  )
}

export default AgentMascot
