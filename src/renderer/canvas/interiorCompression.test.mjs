import assert from 'node:assert/strict'
import test from 'node:test'
import { slideIncomingIntoFreeSlot } from './dropPersistence.ts'
import { DROP_CLEARANCE } from './frameGeometry.ts'
import {
  INTERIOR_COMPRESSION_STEP,
  INTERIOR_LEGIBILITY_MIN_WORLD_SCALE,
  contentBoxAtCompression,
  planInteriorCompression,
} from './interiorCompression.ts'

// A 620x420 frame's content box, header and padding already removed.
const OWN_CONTENT = { x: 28, y: 54, width: 564, height: 338 }

const input = (overrides = {}) => ({
  ownContent: OWN_CONTENT,
  occupied: [],
  incoming: { width: 220, height: 110 },
  origin: { x: 28, y: 54 },
  interiorScale: 1,
  minChildWorldScale: 1,
  // The legal minimum, not the spacing a tidy would choose. Compression only
  // has to open a slot the drop can legally occupy.
  clearance: DROP_CLEARANCE,
  ...overrides,
})

/**
 * Fills the content box so nothing else can fit at the given compression. The
 * box grows as `interiorScale` falls, so a frame that already compresses needs
 * proportionally more children to be full.
 */
const packedSolid = (interiorScale = 1) => {
  const box = contentBoxAtCompression(OWN_CONTENT, interiorScale)
  const rects = []
  for (let y = box.y; y + 110 <= box.y + box.height; y += 122) {
    for (let x = box.x; x + 220 <= box.x + box.width; x += 232) {
      rects.push({ x, y, width: 220, height: 110 })
    }
  }
  return rects
}

test('compressing a frame enlarges the box its children are measured against', () => {
  const half = contentBoxAtCompression(OWN_CONTENT, 0.5)
  assert.equal(half.width, OWN_CONTENT.width * 2)
  assert.equal(half.height, OWN_CONTENT.height * 2)
  // The origin moves too: the inset is authored in the frame's own space.
  assert.equal(half.x, OWN_CONTENT.x * 2)
})

test('a frame with room is left completely alone', () => {
  const plan = planInteriorCompression(input(), slideIncomingIntoFreeSlot)
  assert.equal(plan.factor, 1)
  assert.equal(plan.interiorScale, 1)
  assert.equal(plan.atFloor, false)
})

test('a full frame compresses, and by at least one quantized step', () => {
  const plan = planInteriorCompression(
    input({ occupied: packedSolid() }),
    slideIncomingIntoFreeSlot,
  )
  assert.ok(plan.factor < 1, 'expected the interior to compress')
  assert.ok(
    plan.factor <= 1 - INTERIOR_COMPRESSION_STEP + 1e-9,
    `expected at least one ${INTERIOR_COMPRESSION_STEP} step, got ${plan.factor}`,
  )
  assert.equal(plan.interiorScale, plan.factor)
})

test('compression never moves a resident: only the newcomer is placed', () => {
  const occupied = packedSolid()
  const snapshot = JSON.stringify(occupied)
  const plan = planInteriorCompression(input({ occupied }), slideIncomingIntoFreeSlot)
  assert.equal(JSON.stringify(occupied), snapshot, 'residents must not be rewritten')
  // The newcomer lands clear of every resident, in the same coordinate space
  // the residents already occupy - their numbers never changed.
  const collides = occupied.some(rect =>
    plan.placement.x < rect.x + rect.width &&
    plan.placement.x + 220 > rect.x &&
    plan.placement.y < rect.y + rect.height &&
    plan.placement.y + 110 > rect.y)
  assert.equal(collides, false)
})

test('compression compounds through nesting instead of resetting per level', () => {
  // A frame that already compresses to 0.5 keeps compressing from there.
  const plan = planInteriorCompression(
    input({ occupied: packedSolid(0.5), interiorScale: 0.5 }),
    slideIncomingIntoFreeSlot,
  )
  assert.ok(plan.interiorScale < 0.5)
  assert.equal(plan.interiorScale, 0.5 * plan.factor)
})

test('the legibility floor stops compression and lets the frame overflow', () => {
  // Every child is already at the floor, so there is no headroom at all.
  const plan = planInteriorCompression(
    input({ occupied: packedSolid(), minChildWorldScale: INTERIOR_LEGIBILITY_MIN_WORLD_SCALE }),
    slideIncomingIntoFreeSlot,
  )
  assert.equal(plan.atFloor, true)
  assert.equal(plan.factor, 1, 'must not compress past the point of legibility')
  assert.equal(plan.interiorScale, 1)
})

test('a child already below the floor is never compressed further', () => {
  const plan = planInteriorCompression(
    input({ occupied: packedSolid(), minChildWorldScale: INTERIOR_LEGIBILITY_MIN_WORLD_SCALE / 2 }),
    slideIncomingIntoFreeSlot,
  )
  assert.equal(plan.factor, 1)
  assert.equal(plan.atFloor, true)
})

test('a frame holding small children gets less headroom than one holding large', () => {
  const roomy = planInteriorCompression(
    input({ occupied: packedSolid(), minChildWorldScale: 1 }),
    slideIncomingIntoFreeSlot,
  )
  const cramped = planInteriorCompression(
    input({ occupied: packedSolid(), minChildWorldScale: 0.3 }),
    slideIncomingIntoFreeSlot,
  )
  assert.ok(cramped.factor >= roomy.factor,
    'a frame of already-small children must not be compressed harder')
})
