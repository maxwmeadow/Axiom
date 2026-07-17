import assert from 'node:assert/strict'
import test from 'node:test'
import { childPositionAfterParentResize, fitPresentationScale, floatingResizeGeometry, minimumContainerSize, resizeChanged, toCanonicalResizeGeometry } from './resizeGeometry.ts'

const unlimitedBounds = { minWidth: 1, minHeight: 1, maxWidth: Number.MAX_VALUE, maxHeight: Number.MAX_VALUE }

test('preserves floating-point resize precision at 100x zoom', () => {
  const result = floatingResizeGeometry(
    { x: 332, y: 70, width: 4, height: 1 },
    { horizontal: 'right', vertical: 'bottom' },
    { x: 12, y: 108 },
    100,
    unlimitedBounds,
  )
  assert.deepEqual(result, { x: 332, y: 70, width: 4.12, height: 2.08 })
})

test('does not asymmetrically floor a one-pixel negative resize', () => {
  const result = floatingResizeGeometry(
    { x: 0, y: 0, width: 4, height: 4 },
    { horizontal: 'right', vertical: null },
    { x: -1, y: 0 },
    100,
    unlimitedBounds,
  )
  assert.equal(result.width, 3.99)
})

test('left and top minimum clamps preserve the opposite edges', () => {
  const result = floatingResizeGeometry(
    { x: 10, y: 20, width: 4, height: 2 },
    { horizontal: 'left', vertical: 'top' },
    { x: 1000, y: 1000 },
    100,
    unlimitedBounds,
  )
  assert.deepEqual(result, { x: 13, y: 21, width: 1, height: 1 })
  assert.equal(result.x + result.width, 14)
  assert.equal(result.y + result.height, 22)
})

test('keeps width and height independent for a root frame', () => {
  const result = toCanonicalResizeGeometry({ x: 10, y: 20, width: 900, height: 300 }, 1, 1, false)
  assert.deepEqual(result, { x: 10, y: 20, width: 900, height: 300, parentWorldScale: 1 })
})

test('removes world scale from nested dimensions and only ancestor scale from position', () => {
  const result = toCanonicalResizeGeometry({ x: 150, y: 75, width: 300, height: 120 }, 0.375, 0.75, true)
  assert.deepEqual(result, { x: 300, y: 150, width: 800, height: 320, parentWorldScale: 0.5 })
})

test('persists north-west origin movement and compensates direct children', () => {
  const parentStart = { x: 100, y: 80 }
  const parentEnd = { x: 60, y: 50 }
  assert.deepEqual(
    childPositionAfterParentResize({ x: 50, y: 40 }, parentStart, parentEnd, 0.5),
    { x: 180, y: 140 },
  )
  assert.equal(resizeChanged({ ...parentStart, width: 200, height: 100 }, { ...parentEnd, width: 240, height: 130 }), true)
})

test('container minimum protects children from all four resize directions', () => {
  const minimum = minimumContainerSize(
    { width: 600, height: 420 },
    [
      { x: 90, y: 80, width: 140, height: 100 },
      { x: 360, y: 230, width: 160, height: 110 },
    ],
    { left: 28, right: 28, top: 54, bottom: 28 },
    { width: 120, height: 82 },
  )
  assert.deepEqual(minimum, {
    width: 548, // right handle: 520 + 28; left handle only needs 600 - 90 + 28
    height: 394, // top handle: 420 - 80 + 54; bottom handle only needs 340 + 28
  })
})

test('empty container retains the structural frame minimum', () => {
  assert.deepEqual(
    minimumContainerSize(
      { width: 600, height: 420 }, [],
      { left: 28, right: 28, top: 54, bottom: 28 },
      { width: 120, height: 82 },
    ),
    { width: 120, height: 82 },
  )
})

test('same-aspect frames preserve the same logical presentation at every size', () => {
  assert.equal(fitPresentationScale(220, 110, 220, 110), 1)
  assert.equal(fitPresentationScale(110, 55, 220, 110), 0.5)
  assert.equal(fitPresentationScale(440, 220, 220, 110), 2)
})

test('the limiting axis controls presentation scale for arbitrary aspect ratios', () => {
  assert.equal(fitPresentationScale(440, 110, 220, 110), 1)
  assert.equal(fitPresentationScale(110, 220, 220, 110), 0.5)
})
