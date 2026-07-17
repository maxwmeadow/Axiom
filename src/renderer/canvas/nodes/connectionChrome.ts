import type { CSSProperties } from 'react'

const safeScale = (scale: number): number => Number.isFinite(scale) && scale > 0 ? scale : 1

/**
 * One interaction contract for every React Flow connection handle.
 *
 * React Flow's default 5px minimum is expressed in world coordinates. At
 * 100x zoom that becomes a 500px invisible hit target, which can cover the
 * entire node and steal dragging/resizing. Stamp the complete geometry inline
 * so both the visible shape and its hit target follow Axiom presentation size.
 */
export function connectionHandleProps(
  isConnectable: boolean,
  presentationScale: number,
  position?: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>,
) {
  const scale = safeScale(presentationScale)
  const style: CSSProperties = {
    opacity: 0,
    width: `${6 * scale}px`,
    height: `${6 * scale}px`,
    minWidth: 0,
    minHeight: 0,
    borderWidth: `${scale}px`,
    pointerEvents: isConnectable ? undefined : 'none',
  }
  if (position) {
    for (const [side, value] of Object.entries(position)) {
      if (typeof value === 'number') style[side as 'top' | 'right' | 'bottom' | 'left'] = `${value * scale}px`
    }
  }
  return {
    isConnectable,
    isConnectableStart: isConnectable,
    isConnectableEnd: isConnectable,
    style,
  } as const
}
