import assert from 'node:assert/strict'
import test from 'node:test'

import {
  absolutePositionsFromTree,
  buildCollisionModel,
  summarizeCollisionModel,
} from './collisionModel.ts'
import {
  DROP_CLEARANCE,
  FRAME_ITEM_GAP,
  FRAME_ROOT_GAP,
  contentRectFor,
} from './frameGeometry.ts'

const EPSILON = 0.001

function node({
  id,
  type = 'file',
  x = 0,
  y = 0,
  width = 200,
  height = 100,
  parentId = null,
  depth = 0,
  worldScale = 1,
  interiorScale = 1,
  selected = false,
}) {
  const contentScale = worldScale * interiorScale
  return {
    id,
    type,
    position: { x, y },
    parentId: parentId ?? undefined,
    selected,
    measured: { width, height },
    style: { width, height },
    data: { depth, worldScale, contentScale, interiorScale },
  }
}

function model(nodes, extra = {}) {
  return buildCollisionModel({
    layer: 'floor',
    nodes,
    absolutePositions: absolutePositionsFromTree(nodes),
    ...extra,
  })
}

function boxFor(built, kind, nodeId) {
  return built.boxes.find(box => box.kind === kind && box.nodeId === nodeId)
}

/** Edge-to-edge separation on the tighter axis; negative means overlap. */
function separation(a, b) {
  return Math.max(
    Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)),
    Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height)),
  )
}

// ── The unification claim ───────────────────────────────────────────────────

test('a Sheet and the Floor derive identical collision geometry from one scene', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'file', x: 900, y: 40 }),
    node({ id: 'child', x: 60, y: 120, parentId: 'sys', depth: 1 }),
  ]
  const absolutePositions = absolutePositionsFromTree(scene)
  const floor = buildCollisionModel({ layer: 'floor', nodes: scene, absolutePositions })
  const sheet = buildCollisionModel({
    layer: 'sheet',
    nodes: scene,
    absolutePositions,
    editableNodeIds: new Set(scene.map(candidate => candidate.id)),
  })

  assert.equal(floor.layer, 'floor')
  assert.equal(sheet.layer, 'sheet')
  // The layer badge and the editable set are the ONLY permitted differences.
  assert.deepEqual(
    floor.boxes.map(({ key, kind, rect }) => ({ key, kind, rect })),
    sheet.boxes.map(({ key, kind, rect }) => ({ key, kind, rect })),
  )
  assert.deepEqual(floor.gaps, sheet.gaps)
  assert.deepEqual(floor.issues, sheet.issues)
})

test('a sheet drag of a node the sheet cannot move reports nothing rather than lying', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'locked', x: 900, y: 40 }),
  ]
  const built = model(scene, {
    layer: 'sheet',
    draggedNodeId: 'locked',
    editableNodeIds: new Set(['sys']),
  })
  assert.equal(built.drag, null)
})

// ── Clearance is a property of the container ────────────────────────────────

test('packing gaps stay per-container, but the enforced clearance is flat everywhere', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'root-file', x: 1000, y: 0 }),
    node({ id: 'child', x: 60, y: 200, parentId: 'sys', depth: 1, worldScale: 0.5 }),
  ]
  const built = model(scene)

  // Axiom's own arrangements still spread roots further apart than occupants.
  const rootGap = built.gaps.find(entry => entry.frameId === null)
  assert.equal(rootGap.gap.gap, FRAME_ROOT_GAP)
  const sysGap = built.gaps.find(entry => entry.frameId === 'sys')
  assert.equal(sysGap.gap.gap, FRAME_ITEM_GAP)

  // But nothing is ever rejected for those. A hand-placed node answers to one
  // number, and it is the same number at the root plane and six levels down.
  assert.equal(built.clearance.gap, DROP_CLEARANCE)
  assert.equal(boxFor(built, 'clearance', 'root-file').gap, DROP_CLEARANCE)
  assert.equal(boxFor(built, 'clearance', 'child').gap, DROP_CLEARANCE)
  assert.equal(boxFor(built, 'clearance', 'sys').gap, DROP_CLEARANCE)
})

test('a compressed frame scales its occupants clearance into world units', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600, interiorScale: 0.5 }),
    node({ id: 'child', x: 60, y: 200, parentId: 'sys', depth: 1 }),
  ]
  const built = model(scene)
  const sysGap = built.gaps.find(entry => entry.frameId === 'sys')
  assert.equal(sysGap.gap.gap, FRAME_ITEM_GAP * 0.5)
  assert.equal(sysGap.gap.contentScale, 0.5)
})

// ── Drawn boxes match the engine ────────────────────────────────────────────

test('a frame interior box is the box the drop is actually contained within', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 120, y: 80, width: 800, height: 600 }),
    node({ id: 'file', x: 400, y: 300 }),
  ]
  const built = model(scene, { draggedNodeId: 'file', targetNodeId: 'sys' })
  const drawn = boxFor(built, 'content', 'sys')
  // Same rect the planner clamps against, up to the absolute-position offset.
  assert.deepEqual(built.drag.destination, drawn.rect)

  const expected = contentRectFor({ width: 800, height: 600 }, 0, 1)
  assert.ok(Math.abs(drawn.rect.x - (120 + expected.x)) < EPSILON)
  assert.ok(Math.abs(drawn.rect.y - (80 + expected.y)) < EPSILON)
  assert.ok(Math.abs(drawn.rect.width - expected.width) < EPSILON)
  assert.ok(Math.abs(drawn.rect.height - expected.height) < EPSILON)
  // A frame's usable space starts BELOW its tab, not at its top border.
  assert.ok(drawn.rect.y > 80 + expected.x, 'interior top must clear the tab band')
})

test('a node may be dropped right up against a system without being flung away', () => {
  // The reported symptom, and the regression this guards. The file sits 10
  // units clear of the system: not overlapping, not touching, well outside the
  // distance two borders need. That was legal all along, and used to be
  // rejected anyway for sitting inside the 96-unit root packing gap.
  const system = node({ id: 'sys', type: 'system', x: 0, y: 400, width: 800, height: 600 })
  const file = node({ id: 'file', x: 300, y: 290, width: 200, height: 100, selected: true })
  const built = model([system, file], { draggedNodeId: 'file' })

  assert.equal(separation(boxFor(built, 'node', 'file').rect, boxFor(built, 'node', 'sys').rect), 10)
  assert.ok(10 < FRAME_ROOT_GAP, 'the release point must be inside the old packing gap')
  assert.equal(built.drag.repelDistance, 0, 'a legal drop must not move at all')
  assert.deepEqual(built.drag.landing, { x: 300, y: 290, width: 200, height: 100 })
  assert.equal(built.drag.blockers.length, 0)
})

test('an overlapping drop moves the minimum that separates the two borders', () => {
  const system = node({ id: 'sys', type: 'system', x: 0, y: 400, width: 800, height: 600 })
  // Released 80 units INTO the system — genuinely overlapping, so it must move.
  const file = node({ id: 'file', x: 300, y: 380, width: 200, height: 100, selected: true })
  const built = model([system, file], { draggedNodeId: 'file' })

  const systemRect = boxFor(built, 'node', 'sys').rect
  const landed = separation(built.drag.landing, systemRect)
  assert.ok(
    Math.abs(landed - DROP_CLEARANCE) < 1,
    `landed ${landed} away, expected the ${DROP_CLEARANCE} its borders need`,
  )
  // It moved out of an 80-unit overlap, and not one unit further.
  assert.ok(Math.abs(built.drag.repelDistance - (80 + DROP_CLEARANCE)) < 1)
  assert.ok(built.drag.repelDistance < FRAME_ROOT_GAP + 20, 'must not fly a full packing gap')
  // Borders never share a line.
  assert.ok(landed > 0, 'landed rects must not touch edge to edge')
})

test('inside a frame the same rule applies — nudged clear of the sibling, still inside', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'resident', x: 100, y: 200, width: 200, height: 100, parentId: 'sys', depth: 1 }),
    // Released overlapping the resident by 40 units horizontally.
    node({ id: 'file', x: 260, y: 200, width: 200, height: 100, parentId: 'sys', depth: 1, selected: true }),
  ]
  const built = model(scene, { draggedNodeId: 'file', targetNodeId: 'sys' })

  const residentRect = boxFor(built, 'node', 'resident').rect
  const landed = separation(built.drag.landing, residentRect)
  assert.ok(Math.abs(landed - DROP_CLEARANCE) < 1, `landed ${landed} away, expected ${DROP_CLEARANCE}`)
  assert.ok(landed > 0, 'borders must not share a line')
  assert.ok(built.drag.repelDistance < 60, 'a nudge, not a relocation')

  // And it stayed inside the frame it was dropped into.
  const interior = boxFor(built, 'content', 'sys').rect
  assert.ok(built.drag.landing.x >= interior.x - 0.5)
  assert.ok(built.drag.landing.x + built.drag.landing.width <= interior.x + interior.width + 0.5)
  assert.equal(built.issues.filter(issue => issue.code === 'escapes-parent').length, 0)
})

test('a drop that has to move never lands on the packing gap by accident', () => {
  const scene = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'resident', x: 100, y: 200, width: 200, height: 100, parentId: 'sys', depth: 1 }),
    node({ id: 'file', x: 260, y: 200, width: 200, height: 100, parentId: 'sys', depth: 1, selected: true }),
  ]
  const built = model(scene, { draggedNodeId: 'file', targetNodeId: 'sys' })
  const landed = separation(built.drag.landing, boxFor(built, 'node', 'resident').rect)
  assert.ok(landed < FRAME_ITEM_GAP, 'the in-frame packing gap must not act as a floor')
})

test('an overlapping drop names the box it was pushed out of, measured against the clearance', () => {
  const system = node({ id: 'sys', type: 'system', x: 0, y: 400, width: 800, height: 600 })
  const file = node({ id: 'file', x: 300, y: 380, width: 200, height: 100, selected: true })
  const built = model([system, file], { draggedNodeId: 'file' })

  assert.deepEqual(built.drag.blockers.map(blocker => blocker.nodeId), ['sys'])
  assert.equal(built.drag.blockers[0].required, DROP_CLEARANCE)
  assert.ok(built.drag.blockers[0].separation < 0, 'a blocker is a genuine overlap now')
  assert.ok(built.boxes.some(box => box.kind === 'blocker' && box.nodeId === 'sys'))

  // The halo drawn for the system is the region that actually rejected it.
  const systemRect = boxFor(built, 'node', 'sys').rect
  const halo = boxFor(built, 'clearance', 'sys').rect
  assert.equal(halo.x, systemRect.x - DROP_CLEARANCE)
  assert.equal(halo.width, systemRect.width + DROP_CLEARANCE * 2)
  assert.ok(separation(built.drag.landing, halo) > -1, 'the landing must sit outside the drawn halo')
})

test('a drop with room around it is not moved at all', () => {
  const system = node({ id: 'sys', type: 'system', x: 0, y: 400, width: 800, height: 600 })
  const file = node({ id: 'file', x: 300, y: 100, width: 200, height: 100, selected: true })
  const built = model([system, file], { draggedNodeId: 'file' })

  assert.equal(built.drag.blockers.length, 0)
  assert.ok(built.drag.repelDistance < EPSILON)
  assert.deepEqual(built.drag.landing, { x: 300, y: 100, width: 200, height: 100 })
})

// ── Standing invariants ─────────────────────────────────────────────────────

test('siblings closer than their clearance are reported, overlaps as errors', () => {
  const scene = [
    node({ id: 'a', x: 0, y: 0, width: 200, height: 100 }),
    node({ id: 'b', x: 150, y: 0, width: 200, height: 100 }),
  ]
  const built = model(scene)
  const conflict = built.issues.find(issue => issue.code === 'sibling-conflict')
  assert.ok(conflict)
  assert.equal(conflict.severity, 'error')
  assert.deepEqual(conflict.nodeIds.sort(), ['a', 'b'])
})

test('a child hanging outside its parent interior is an error, a seated one is silent', () => {
  const seated = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'child', x: 60, y: 200, parentId: 'sys', depth: 1 }),
  ]
  assert.equal(model(seated).issues.filter(issue => issue.code === 'escapes-parent').length, 0)

  const escaping = [
    node({ id: 'sys', type: 'system', x: 0, y: 0, width: 800, height: 600 }),
    node({ id: 'child', x: 700, y: 200, parentId: 'sys', depth: 1, width: 400 }),
  ]
  const issue = model(escaping).issues.find(candidate => candidate.code === 'escapes-parent')
  assert.ok(issue)
  assert.equal(issue.severity, 'error')
})

test('a node whose measured size differs from its requested size is called out', () => {
  const mismatched = node({ id: 'file', width: 200, height: 100 })
  mismatched.measured = { width: 260, height: 100 }
  const issue = model([mismatched]).issues.find(candidate => candidate.code === 'size-disagreement')
  assert.ok(issue)
  // Collision uses measured, so that is the rect drawn.
  assert.equal(boxFor(model([mismatched]), 'node', 'file').rect.width, 260)
})

test('an unmeasured node still yields a usable rect instead of a zero-size one', () => {
  const bare = { id: 'ghost', type: 'file', position: { x: 5, y: 7 }, data: {} }
  const built = model([bare])
  const rect = boxFor(built, 'node', 'ghost').rect
  assert.deepEqual(rect, { x: 5, y: 7, width: 1, height: 1 })
})

// ── Reporting ───────────────────────────────────────────────────────────────

test('the console summary states the layer, every clearance and the drag outcome', () => {
  const system = node({ id: 'sys', type: 'system', x: 0, y: 400, width: 800, height: 600 })
  const file = node({ id: 'file', x: 300, y: 380, width: 200, height: 100, selected: true })
  const lines = summarizeCollisionModel(model([system, file], { draggedNodeId: 'file' })).join('\n')

  assert.match(lines, /layer=floor/)
  assert.match(lines, new RegExp(`clearance \\(enforced\\): ${DROP_CLEARANCE}`))
  assert.match(lines, new RegExp(`packing gap root plane: ${FRAME_ROOT_GAP}`))
  assert.match(lines, /root-slide/)
  assert.match(lines, /blocked by sys/)
})
