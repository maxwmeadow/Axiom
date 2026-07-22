import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  easeViewportTowardZoom,
  nextWheelZoomTarget,
  zoomViewportAroundPoint,
} from './viewportMath.ts'

const flowPointAt = (viewport, point) => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
})

test('wheel targets accumulate by 1.15 and clamp to the canvas bounds', () => {
  assert.equal(nextWheelZoomTarget(1, -100), 1.15)
  assert.equal(nextWheelZoomTarget(1.15, 100), 1)
  assert.equal(nextWheelZoomTarget(99, -1), MAX_CANVAS_ZOOM)
  assert.equal(nextWheelZoomTarget(0.021, 1), MIN_CANVAS_ZOOM)
})

test('zooming preserves the exact flow coordinate beneath the pointer', () => {
  const viewport = { x: -21_085.95116372989, y: -40_588.90433756707, zoom: 66.125 }
  const pointer = { x: 1_037.25, y: 488.75 }
  const before = flowPointAt(viewport, pointer)
  const afterViewport = zoomViewportAroundPoint(viewport, pointer, 100)
  const after = flowPointAt(afterViewport, pointer)

  assert.ok(Math.abs(after.x - before.x) < 1e-12)
  assert.ok(Math.abs(after.y - before.y) < 1e-12)
})

test('easing advances 15 percent without moving the pointer anchor', () => {
  const viewport = { x: -400, y: 250, zoom: 4 }
  const pointer = { x: 700, y: 300 }
  const before = flowPointAt(viewport, pointer)
  const next = easeViewportTowardZoom(viewport, pointer, 10)
  const after = flowPointAt(next, pointer)

  assert.equal(next.zoom, 4.9)
  assert.ok(Math.abs(after.x - before.x) < 1e-12)
  assert.ok(Math.abs(after.y - before.y) < 1e-12)
})
