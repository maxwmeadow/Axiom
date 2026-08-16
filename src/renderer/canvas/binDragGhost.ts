import type { Node } from '@xyflow/react'

/**
 * The node that follows the cursor between the Floor and the unsorted bin.
 *
 * Deliberately a module store rather than canvas state. Setting React state
 * during a drag re-renders the canvas that owns the gesture, and a re-render
 * mid-drag is what left nodes glued to the cursor: React Flow's drag is a
 * pointer gesture bound to a DOM element, and disturbing that element loses the
 * event that ends it. Only the small ghost layer subscribes here, so showing a
 * ghost costs one render of one component and never touches either canvas.
 *
 * Position is not part of the published state at all - it moves through the
 * element ref below, so following the cursor costs no renders whatsoever.
 */

export interface BinGhostContent {
  node: Node
  /** Rendered at the zoom of the canvas being left, so it does not jump size. */
  scale: number
}

type Listener = () => void

let content: BinGhostContent | null = null
let element: HTMLElement | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeBinGhost(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getBinGhost(): BinGhostContent | null {
  return content
}

export function showBinGhost(next: BinGhostContent): void {
  // Identity matters: re-publishing the same node would re-render the layer on
  // every pointer move, which is the cost this module exists to avoid.
  if (content && content.node === next.node && content.scale === next.scale) return
  content = next
  emit()
}

export function hideBinGhost(): void {
  revealRealNode()
  if (!content) return
  content = null
  element = null
  emit()
}

export function isBinGhostVisible(): boolean {
  return content !== null
}

/** The layer hands its element over so the drag can move it without rendering. */
export function registerBinGhostElement(next: HTMLElement | null): void {
  element = next
}

/**
 * Hide the real node while its ghost carries the gesture.
 *
 * Two copies of one node is worse than none: the original keeps its resize
 * chrome and lags a frame behind the cursor, so the thing you are aiming with
 * and the thing you are looking at disagree. Done straight to the DOM because
 * the alternative - re-rendering the canvas mid-drag - is what breaks the drag.
 */
let hiddenNode: HTMLElement | null = null

export function hideRealNode(nodeId: string): void {
  if (hiddenNode?.dataset.id === nodeId) return
  revealRealNode()
  const element = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
  )
  if (!element) return
  element.style.opacity = '0'
  element.style.pointerEvents = 'none'
  hiddenNode = element
}

export function revealRealNode(): void {
  if (!hiddenNode) return
  hiddenNode.style.opacity = ''
  hiddenNode.style.pointerEvents = ''
  hiddenNode = null
}

export function moveBinGhost(x: number, y: number, valid: boolean): void {
  if (!element) return
  element.style.left = `${x}px`
  element.style.top = `${y}px`
  if (valid) element.setAttribute('data-over-system', '')
  else element.removeAttribute('data-over-system')
}
