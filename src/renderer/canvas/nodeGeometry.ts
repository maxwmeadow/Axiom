/**
 * How a rendered React Flow node is read as COLLISION GEOMETRY.
 *
 * Every path that asks "what rectangle does the collision system see for this
 * node?" must come through here. Before this module the drop planner read node
 * sizes inline, the resize clamp read them again, and a debug view would have
 * read them a third time — three copies of the same three-way fallback chain,
 * free to drift. Drift here is invisible until a node repels from a boundary
 * that is not the one being drawn.
 *
 * Two size readings genuinely exist and are NOT interchangeable:
 *
 *   `measured` — what the DOM actually laid out. This is what collision uses,
 *                because it is what the user can see and bump into.
 *   `style`    — what the projection asked for. This is what the content-rect
 *                math uses, because insets are authored against requested size.
 *
 * They agree in a settled scene and disagree for a frame mid-measurement.
 * `nodeSizeDisagreement` exists so a debug view can say so out loud rather than
 * silently picking one.
 */
import type { Node } from '@xyflow/react'
import {
  contentRectFor,
  DROP_CLEARANCE,
  FRAME_ITEM_GAP,
  FRAME_ROOT_GAP,
  type Point,
  type Rect,
} from './frameGeometry.ts'

/** Node types that can hold other nodes. Anything else has no content rect. */
const FRAME_NODE_TYPES = new Set(['system', 'infra'])

export function positiveFinite(value: unknown, fallback = 1): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nodeData(node: Node): Record<string, unknown> {
  return (node.data ?? {}) as Record<string, unknown>
}

/** The world scale the node renders its OWN box at. */
export function nodeWorldScale(node: Node): number {
  return positiveFinite(nodeData(node).worldScale)
}

/**
 * The world scale this node hands to its children — its own scale times the
 * interior compression it applies. Falls back to its own scale, which is the
 * correct answer for an uncompressed frame.
 */
export function nodeContentScale(node: Node): number {
  return positiveFinite(nodeData(node).contentScale, nodeWorldScale(node))
}

export function nodeInteriorScale(node: Node): number {
  return positiveFinite(nodeData(node).interiorScale)
}

export function nodeDepth(node: Node): number {
  const depth = Number(nodeData(node).depth ?? 0)
  return Number.isFinite(depth) ? depth : 0
}

export function isFrameNode(node: Node): boolean {
  return FRAME_NODE_TYPES.has(node.type ?? '')
}

/**
 * The rect collision tests against, in absolute world coordinates. Measured
 * size wins: a node collides with what is on screen, not with what was asked
 * for.
 */
export function nodeWorldRect(node: Node, absolute: Point): Rect {
  return {
    x: absolute.x,
    y: absolute.y,
    width: positiveFinite(node.measured?.width ?? node.style?.width, 1),
    height: positiveFinite(node.measured?.height ?? node.style?.height, 1),
  }
}

/**
 * The frame's own size in its CANONICAL space — rendered size divided back out
 * by its world scale. Requested size wins here, matching the projection that
 * authored the insets.
 */
export function frameCanonicalSize(node: Node): { width: number; height: number } {
  const scale = nodeWorldScale(node)
  return {
    width: positiveFinite(node.style?.width ?? node.measured?.width, 1) / scale,
    height: positiveFinite(node.style?.height ?? node.measured?.height, 1) / scale,
  }
}

/**
 * The frame's usable interior in its OWN canonical space — tab band and gap
 * insets already removed.
 */
export function frameOwnContentRect(node: Node): Rect {
  return contentRectFor(frameCanonicalSize(node), nodeDepth(node), nodeWorldScale(node))
}

/**
 * The frame's usable interior in ABSOLUTE WORLD coordinates. This is the box a
 * dropped node is contained within, and the box a debug view must draw: a
 * frame's border is not where its usable space begins, because the tab sits
 * between them.
 */
export function frameWorldContentRect(node: Node, absolute: Point): Rect {
  const scale = nodeWorldScale(node)
  const box = frameOwnContentRect(node)
  return {
    x: absolute.x + box.x * scale,
    y: absolute.y + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  }
}

export interface WorldGap {
  /** Spacing in absolute world units. */
  gap: number
  /** Which constant produced it, for a debug readout. */
  source: 'FRAME_ROOT_GAP' | 'FRAME_ITEM_GAP' | 'DROP_CLEARANCE'
  /** Authored value before the content-scale conversion. */
  authored: number
  /** Content scale the authored value was converted through (1 at root). */
  contentScale: number
}

/**
 * The spacing Axiom LEAVES between occupants of `target` when it arranges them
 * itself — a pack, a tidy, a newly indexed node, or the tidy resting distance a
 * hand-dropped node is offered when it has to move at all.
 *
 * This is a preference about how a layout looks, not a rule a drop must obey.
 * `dropClearance` is the rule.
 *
 * FRAME_ITEM_GAP is authored in canonical units while placement runs in
 * absolute world units, so a frame nested at half scale must leave half the
 * world gap — otherwise the same arrangement packs differently by depth.
 */
export function packingGapWithin(target: Node | null): WorldGap {
  if (!target) {
    return {
      gap: FRAME_ROOT_GAP,
      source: 'FRAME_ROOT_GAP',
      authored: FRAME_ROOT_GAP,
      contentScale: 1,
    }
  }
  const contentScale = Math.max(0.0001, nodeContentScale(target))
  return {
    gap: FRAME_ITEM_GAP * contentScale,
    source: 'FRAME_ITEM_GAP',
    authored: FRAME_ITEM_GAP,
    contentScale,
  }
}

/**
 * The clearance a hand-placed node must actually respect — the only spacing
 * rule a drop can fail. Constant everywhere, at every depth, because its whole
 * job is keeping two rendered borders off the same line.
 */
export function dropClearance(): WorldGap {
  return {
    gap: DROP_CLEARANCE,
    source: 'DROP_CLEARANCE',
    authored: DROP_CLEARANCE,
    contentScale: 1,
  }
}

/** A rect grown on every side by `gap` — the region that repels a newcomer. */
export function clearanceRect(rect: Rect, gap: number): Rect {
  return {
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2,
  }
}

/**
 * Do these two rects conflict at `gap` clearance? Deliberately the same
 * predicate the packer uses (`packing.collides` with a single placed rect), so
 * a debug view can never disagree with the engine about what "blocked" means.
 */
export function conflictsAt(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}

/** Signed clearance between two rects: negative means they conflict. */
export function separationBetween(a: Rect, b: Rect): { x: number; y: number; min: number } {
  const x = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
  const y = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height))
  // Rects overlapping on both axes genuinely intersect; otherwise the axis that
  // is still clear is the one holding them apart.
  return { x, y, min: Math.max(x, y) }
}

/**
 * How far apart the two size readings are. Non-zero means the node is mid
 * measurement, or that the projection and the DOM disagree — in which case
 * collision and containment are running on different rectangles.
 */
export function nodeSizeDisagreement(node: Node): { width: number; height: number } {
  const measuredWidth = Number(node.measured?.width)
  const measuredHeight = Number(node.measured?.height)
  const styleWidth = Number(node.style?.width)
  const styleHeight = Number(node.style?.height)
  return {
    width: Number.isFinite(measuredWidth) && Number.isFinite(styleWidth)
      ? Math.abs(measuredWidth - styleWidth) : 0,
    height: Number.isFinite(measuredHeight) && Number.isFinite(styleHeight)
      ? Math.abs(measuredHeight - styleHeight) : 0,
  }
}
