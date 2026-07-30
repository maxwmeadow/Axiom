import assert from 'node:assert/strict'
import test from 'node:test'
import { placeIncoming } from './packing.ts'

/**
 * The defect these lock down: a node with no persisted row had its position
 * recomputed by `placeIncoming` on EVERY projection, scored against the live
 * bounds and centroid of everything else in its frame. So writing one row —
 * which any drop does — moved every unpersisted node around it.
 */

const GAP = 12
const ORIGIN = { x: 12, y: 40 }
const item = { id: 'newcomer', width: 220, height: 110 }

test('placeIncoming is genuinely unstable under a neighbour change', () => {
  const before = [{ x: 12, y: 40, width: 220, height: 110 }]
  const after = [{ x: 400, y: 300, width: 220, height: 110 }]
  const a = placeIncoming(item, before, { baseGap: GAP, origin: ORIGIN })
  const b = placeIncoming(item, after, { baseGap: GAP, origin: ORIGIN })
  assert.notDeepEqual(a, b,
    'if this ever becomes stable the caching below is still correct, but the ' +
    'bug it fixes would no longer be reproducible from here')
})

/** The projection rule, extracted exactly as buildFloorFrameLayout applies it. */
function resolvePlacement(cache, id, parentId, priority, occupied) {
  if (priority !== 2) {
    cache.delete(id)
    return null
  }
  const remembered = cache.get(id)
  if (remembered && remembered.parentId === parentId) return { x: remembered.x, y: remembered.y }
  const spot = placeIncoming({ ...item, id }, occupied, { baseGap: GAP, origin: ORIGIN })
  cache.set(id, { parentId, x: spot.x, y: spot.y })
  return spot
}

test('a remembered placement survives a neighbour being moved', () => {
  const cache = new Map()
  const first = resolvePlacement(cache, 'unclassified', 'frame', 2,
    [{ x: 12, y: 40, width: 220, height: 110 }])
  // A drop writes a row for a sibling; the frame's contents shift.
  const second = resolvePlacement(cache, 'unclassified', 'frame', 2,
    [{ x: 600, y: 500, width: 220, height: 110 }])
  assert.deepEqual(second, { x: first.x, y: first.y },
    'an unrelated drop must not move a node that has no row of its own')
})

test('the placement is re-decided when the node changes parent', () => {
  const cache = new Map()
  resolvePlacement(cache, 'moved', 'frameA', 2, [{ x: 12, y: 40, width: 220, height: 110 }])
  const inB = resolvePlacement(cache, 'moved', 'frameB', 2, [])
  assert.deepEqual(inB, ORIGIN, 'a new frame gets a fresh decision, not stale coordinates')
  assert.equal(cache.get('moved').parentId, 'frameB')
})

test('gaining real geometry discards the remembered guess', () => {
  const cache = new Map()
  resolvePlacement(cache, 'settled', 'frame', 2, [{ x: 12, y: 40, width: 220, height: 110 }])
  assert.equal(cache.has('settled'), true)
  // Priority 0 = it now has a persisted row; the guess must not outlive it.
  resolvePlacement(cache, 'settled', 'frame', 0, [])
  assert.equal(cache.has('settled'), false)
})

test('many unpersisted siblings all hold still across repeated projections', () => {
  const cache = new Map()
  const ids = ['f1', 'f2', 'f3', 'f4']
  const project = occupied => ids.map(id => resolvePlacement(cache, id, null, 2, occupied))
  const first = project([{ x: 0, y: 0, width: 220, height: 110 }])
  // Three further projections, each with the frame's contents rearranged.
  for (const moved of [200, 500, 900]) {
    const again = project([{ x: moved, y: moved, width: 220, height: 110 }])
    assert.deepEqual(again, first, 'no unpersisted node may drift between projections')
  }
})
