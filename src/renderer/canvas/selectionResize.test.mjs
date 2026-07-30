import assert from 'node:assert/strict'
import test from 'node:test'
import { rectContainsRect, scaleSelectionRects, selectionResizeScale } from './selectionResize.ts'

const limits = { minWidth: 24, minHeight: 24 }

test('doubling the grabbed node doubles the whole selection frame', () => {
  const start = { x: 0, y: 0, width: 100, height: 100 }
  const next = { x: 0, y: 0, width: 200, height: 200 }
  const [member] = scaleSelectionRects(start, next, [
    { id: 'b', x: 200, y: 100, width: 100, height: 50 },
  ], limits)

  // Its offset from the anchor scales with the frame, and so does its size.
  assert.deepEqual(member, { id: 'b', x: 400, y: 200, width: 200, height: 100 })
})

test('a north-west handle anchors on the opposite corner', () => {
  // Dragging north-west moves the origin and grows the box; the resizer folds
  // that into `next`, so the far corner must stay put for every member.
  const start = { x: 100, y: 100, width: 100, height: 100 }
  const next = { x: 50, y: 50, width: 150, height: 150 }
  const [member] = scaleSelectionRects(start, next, [
    { id: 'b', x: 100, y: 100, width: 100, height: 100 },
  ], limits)

  // A member sitting exactly on the anchor tracks the anchor exactly.
  assert.equal(member.x, 50)
  assert.equal(member.y, 50)
  assert.equal(member.width, 150)
  assert.equal(member.height, 150)
})

test('members never collapse below the minimum edge', () => {
  const start = { x: 0, y: 0, width: 1000, height: 1000 }
  const next = { x: 0, y: 0, width: 10, height: 10 }
  const [member] = scaleSelectionRects(start, next, [
    { id: 'b', x: 500, y: 500, width: 200, height: 200 },
  ], limits)

  assert.equal(member.width, 24)
  assert.equal(member.height, 24)
})

test('degenerate starting geometry cannot produce NaN or inverted scaling', () => {
  assert.deepEqual(
    selectionResizeScale({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 50, height: 50 }),
    { sx: 1, sy: 1 },
  )
  assert.deepEqual(
    selectionResizeScale({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 0 }),
    { sx: 1, sy: 1 },
  )

  const [member] = scaleSelectionRects(
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 0, y: 0, width: 100, height: 100 },
    [{ id: 'b', x: 10, y: 10, width: 50, height: 50 }],
    limits,
  )
  assert.ok(Number.isFinite(member.x) && Number.isFinite(member.width))
})

test('an empty selection is a no-op', () => {
  assert.deepEqual(
    scaleSelectionRects(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 200, height: 200 },
      [],
      limits,
    ),
    [],
  )
})

test('rectContainsRect tests the whole rect, not a point', () => {
  const parent = { x: 0, y: 0, width: 500, height: 400 }

  assert.equal(rectContainsRect(parent, { x: 10, y: 10, width: 100, height: 100 }), true)
  // Flush against every edge still counts as inside.
  assert.equal(rectContainsRect(parent, { x: 0, y: 0, width: 500, height: 400 }), true)

  // The case that broke drop targeting: a node grabbed near its right side,
  // whose left edge has crossed out of the frame. Its centre and the cursor
  // are still inside, but the node is not.
  assert.equal(rectContainsRect(parent, { x: -20, y: 100, width: 200, height: 100 }), false)
  assert.equal(rectContainsRect(parent, { x: 400, y: 100, width: 200, height: 100 }), false)
  assert.equal(rectContainsRect(parent, { x: 100, y: -5, width: 100, height: 100 }), false)
  assert.equal(rectContainsRect(parent, { x: 100, y: 350, width: 100, height: 100 }), false)
})
