import assert from 'node:assert/strict'
import test from 'node:test'
import { packFrame, placeIncoming, placeNearest } from './packing.ts'

const GAP = 36

function rectsOf(items, result) {
  return items.map(item => {
    const pos = result.positions.get(item.id)
    assert.ok(pos, `missing position for ${item.id}`)
    return { id: item.id, x: pos.x, y: pos.y, width: item.width, height: item.height }
  })
}

function assertNoOverlap(rects, clearance) {
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const left = rects[a]
      const right = rects[b]
      const overlaps = left.x < right.x + right.width + clearance &&
        left.x + left.width + clearance > right.x &&
        left.y < right.y + right.height + clearance &&
        left.y + left.height + clearance > right.y
      assert.ok(!overlaps, `${left.id} and ${right.id} closer than ${clearance}`)
    }
  }
}

function mixedItems(count) {
  const items = []
  for (let index = 0; index < count; index++) {
    items.push(index % 5 === 0
      ? { id: `sys-${index}`, width: 620, height: 420 }
      : { id: `file-${index}`, width: 220, height: 110 })
  }
  return items
}

test('no two items sit closer than the minimum gap', () => {
  const items = mixedItems(24)
  const result = packFrame(items, { baseGap: GAP })
  assertNoOverlap(rectsOf(items, result), GAP - 1)
})

test('cluster is normalized to a (0,0) origin and bounds match contents', () => {
  const items = mixedItems(9)
  const result = packFrame(items, { baseGap: GAP })
  const rects = rectsOf(items, result)
  const minX = Math.min(...rects.map(rect => rect.x))
  const minY = Math.min(...rects.map(rect => rect.y))
  const maxX = Math.max(...rects.map(rect => rect.x + rect.width))
  const maxY = Math.max(...rects.map(rect => rect.y + rect.height))
  assert.equal(minX, 0)
  assert.equal(minY, 0)
  assert.equal(result.width, maxX)
  assert.equal(result.height, maxY)
})

test('same contents always pack identically regardless of input order', () => {
  const items = mixedItems(15)
  const first = packFrame(items, { baseGap: GAP })
  const second = packFrame([...items].reverse(), { baseGap: GAP })
  for (const item of items) {
    assert.deepEqual(second.positions.get(item.id), first.positions.get(item.id))
  }
})

test('cluster stays compact instead of degenerating into a strip', () => {
  const items = mixedItems(20)
  const result = packFrame(items, { baseGap: GAP })
  const ratio = Math.max(result.width, result.height) / Math.min(result.width, result.height)
  assert.ok(ratio < 3, `aspect ratio ${ratio.toFixed(2)} is strip-like`)
  const itemArea = items.reduce((sum, item) => sum + item.width * item.height, 0)
  const fill = itemArea / (result.width * result.height)
  assert.ok(fill > 0.3, `fill ${fill.toFixed(2)} is too sparse`)
})

test('neighbors align flush to shared edges', () => {
  const items = []
  for (let index = 0; index < 16; index++) items.push({ id: `file-${index}`, width: 220, height: 110 })
  const result = packFrame(items, { baseGap: GAP })
  const xs = items.map(item => result.positions.get(item.id).x)
  const ys = items.map(item => result.positions.get(item.id).y)
  const distinct = values => new Set(values.map(value => Math.round(value))).size
  assert.ok(distinct(xs) < items.length, 'no two items share an x edge')
  assert.ok(distinct(ys) < items.length, 'no two items share a y edge')
})

test('gaps between neighbors are dynamic, not a fixed grid pitch', () => {
  // Mixed sizes cannot tile a uniform pitch; the packer should still produce
  // a valid cluster where spacing varies rather than snapping to one module.
  const items = mixedItems(12)
  const result = packFrame(items, { baseGap: GAP })
  const rects = rectsOf(items, result)
  const gaps = new Set()
  for (const left of rects) {
    for (const right of rects) {
      if (left === right) continue
      const horizontal = right.x - (left.x + left.width)
      const overlapY = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
      if (horizontal >= GAP - 1 && overlapY > 0) gaps.add(Math.round(horizontal))
    }
  }
  assert.ok(gaps.size > 1, 'every horizontal gap collapsed to one pitch')
})

test('single item packs at the origin', () => {
  const result = packFrame([{ id: 'only', width: 300, height: 200 }], { baseGap: GAP })
  assert.deepEqual(result.positions.get('only'), { x: 0, y: 0 })
  assert.equal(result.width, 300)
  assert.equal(result.height, 200)
})

test('placeIncoming avoids every occupied rect', () => {
  const items = mixedItems(10)
  const packedResult = packFrame(items, { baseGap: GAP })
  const occupied = rectsOf(items, packedResult)
  const incoming = { id: 'late-file', width: 220, height: 110 }
  const spot = placeIncoming(incoming, occupied, { baseGap: GAP, origin: { x: 0, y: 0 } })
  assertNoOverlap([...occupied, { ...incoming, ...spot }], GAP - 1)
})

test('placeIncoming lands at the origin when the frame is empty', () => {
  const spot = placeIncoming({ id: 'first', width: 220, height: 110 }, [], {
    baseGap: GAP, origin: { x: 42, y: 76 },
  })
  assert.deepEqual(spot, { x: 42, y: 76 })
})

test('placeNearest returns a slot near the release point, not near the cluster', () => {
  const bounds = { x: 0, y: 0, width: 900, height: 700 }
  const occupied = [{ x: 0, y: 0, width: 220, height: 110 }]
  const spot = placeNearest({ id: 'n', width: 220, height: 110 }, occupied,
    { baseGap: 12, bounds, preferred: { x: 600, y: 500 } })
  // Released in empty space: it should not be dragged back to the cluster.
  assert.deepEqual(spot, { x: 600, y: 500 })
})

test('placeNearest slides the minimum distance off a collision', () => {
  const bounds = { x: 0, y: 0, width: 900, height: 700 }
  const occupied = [{ x: 0, y: 0, width: 220, height: 110 }]
  const spot = placeNearest({ id: 'n', width: 220, height: 110 }, occupied,
    { baseGap: 12, bounds, preferred: { x: 10, y: 10 } })
  assert.ok(Math.hypot(spot.x - 10, spot.y - 10) < 200, `slid too far: ${JSON.stringify(spot)}`)
  // And it genuinely clears the resident.
  assert.ok(spot.x >= 232 || spot.y >= 122, `still overlapping: ${JSON.stringify(spot)}`)
})

test('placeNearest never returns a slot outside its bounds', () => {
  const bounds = { x: 50, y: 60, width: 400, height: 300 }
  const spot = placeNearest({ id: 'n', width: 220, height: 110 }, [],
    { baseGap: 12, bounds, preferred: { x: 9999, y: 9999 } })
  assert.ok(spot.x >= bounds.x && spot.x + 220 <= bounds.x + bounds.width)
  assert.ok(spot.y >= bounds.y && spot.y + 110 <= bounds.y + bounds.height)
})

test('placeNearest reports null only when the frame is genuinely full', () => {
  const bounds = { x: 0, y: 0, width: 250, height: 140 }
  // Empty frame with room: must find the slot rather than claim it is full,
  // which is what used to send a drop into a needless interior compression.
  assert.ok(placeNearest({ id: 'n', width: 220, height: 110 }, [],
    { baseGap: 12, bounds, preferred: { x: 200, y: 200 } }))
  // Genuinely occupied: null is correct.
  assert.equal(placeNearest({ id: 'n', width: 220, height: 110 },
    [{ x: 0, y: 0, width: 250, height: 140 }],
    { baseGap: 12, bounds, preferred: { x: 0, y: 0 } }), null)
})

test('placeNearest resolves root collisions without artificial bounds', () => {
  const spot = placeNearest(
    { id: 'incoming', width: 220, height: 110 },
    [{ x: 100, y: 100, width: 220, height: 110 }],
    { baseGap: 72, bounds: null, preferred: { x: 100, y: 100 } },
  )
  assert.ok(spot)
  assert.notDeepEqual(spot, { x: 100, y: 100 })
})
