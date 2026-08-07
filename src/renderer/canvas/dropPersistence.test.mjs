import assert from 'node:assert/strict'
import test from 'node:test'
import { containPointWithin, planCanvasDrop } from './dropPersistence.ts'

const node = (id, overrides = {}) => ({
  id,
  type: 'infra',
  position: { x: 0, y: 0 },
  selected: false,
  data: { worldScale: 1 },
  style: { width: 100, height: 50 },
  ...overrides,
})

test('persists a free root drag at its exact absolute position', () => {
  const dragged = node('database', { selected: true })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'database',
    targetNodeId: null,
    allNodes: [dragged],
    absolutePositions: new Map([['database', { x: 123.125, y: 456.875 }]]),
    systemIds: new Set(),
    fileIds: new Set(),
    infraIds: new Set(['database']),
    floorLayouts: [],
    now: 99,
  })

  assert.deepEqual(plan.selectedIds, ['database'])
  assert.equal(plan.updates[0].positionX, 123.125)
  assert.equal(plan.updates[0].positionY, 456.875)
  assert.equal(plan.updates[0].parentNodeId, null)
  assert.equal(plan.optimisticLayouts[0].updatedAt, 99)
})

test('reparents into infrastructure using destination-local coordinates', () => {
  const target = node('platform', { type: 'system', style: { width: 1000, height: 800 } })
  const dragged = node('service', { type: 'system', selected: true })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'service',
    targetNodeId: 'platform',
    allNodes: [target, dragged],
    absolutePositions: new Map([
      ['platform', { x: 10, y: 20 }],
      ['service', { x: 110, y: 120 }],
    ]),
    systemIds: new Set(['service']),
    fileIds: new Set(),
    infraIds: new Set(['platform']),
    floorLayouts: [],
  })

  assert.equal(plan.updates[0].parentNodeId, 'platform')
  assert.equal(plan.updates[0].parentNodeType, 'infra')
  assert.equal(plan.updates[0].containmentKind, 'hosted_by')
  assert.equal(plan.updates[0].positionX, 100)
  // Clear of the frame's tab (~23 tall plus one gap), so it keeps the exact
  // spot it was dropped on. The old over-reserved header pushed it down here.
  assert.equal(plan.updates[0].positionY, 100)
})

test('the canonical drop planner limits selection without excluding collision residents', () => {
  const live = node('live', { type: 'file', selected: true, style: { width: 220, height: 110 } })
  const planned = node('planned:draft', { type: 'file', selected: true, style: { width: 240, height: 120 } })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'live',
    targetNodeId: null,
    allNodes: [live, planned],
    absolutePositions: new Map([
      ['live', { x: 10.5, y: 20.25 }],
      ['planned:draft', { x: 300.75, y: 200.5 }],
    ]),
    editableNodeIds: new Set(['live', 'planned:draft']),
    systemIds: new Set(),
    fileIds: new Set(['live', 'planned:draft']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  assert.deepEqual(plan.selectedIds, ['live', 'planned:draft'])
  assert.deepEqual(plan.updates.map(mutation => ({
    nodeId: mutation.nodeId,
    nodeType: mutation.nodeType,
    positionX: mutation.positionX,
    positionY: mutation.positionY,
  })), [
    { nodeId: 'live', nodeType: 'file', positionX: 10.5, positionY: 20.25 },
    { nodeId: 'planned:draft', nodeType: 'file', positionX: 300.75, positionY: 200.5 },
  ])
})

test('a dropped node is nudged fully inside the frame it landed in', () => {
  const bounds = { x: 100, y: 100, width: 400, height: 300 }
  const size = { width: 200, height: 100 }

  // Already inside: untouched.
  assert.deepEqual(containPointWithin({ x: 150, y: 150 }, size, bounds), { x: 150, y: 150 })

  // Hanging off each edge: pulled back so the whole rect fits.
  assert.deepEqual(containPointWithin({ x: 50, y: 150 }, size, bounds), { x: 100, y: 150 })
  assert.deepEqual(containPointWithin({ x: 450, y: 150 }, size, bounds), { x: 300, y: 150 })
  assert.deepEqual(containPointWithin({ x: 150, y: 50 }, size, bounds), { x: 150, y: 100 })
  assert.deepEqual(containPointWithin({ x: 150, y: 380 }, size, bounds), { x: 150, y: 300 })

  // Too big for the frame: pinned to the origin, overflowing one corner only.
  assert.deepEqual(
    containPointWithin({ x: 999, y: 999 }, { width: 900, height: 900 }, bounds),
    { x: 100, y: 100 },
  )

  // A root drop has no frame to be contained by.
  assert.deepEqual(containPointWithin({ x: -50, y: -50 }, size, null), { x: -50, y: -50 })
})

test('a crowded drop slides the newcomer instead of moving the residents', () => {
  const target = node('system', { type: 'system', style: { width: 900, height: 700 } })
  const residentA = node('a', { style: { width: 220, height: 110 } })
  const residentB = node('b', { style: { width: 220, height: 110 } })
  const dragged = node('incoming', { selected: true, style: { width: 220, height: 110 } })
  target.id = 'system'
  residentA.parentId = 'system'
  residentB.parentId = 'system'

  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'incoming',
    targetNodeId: 'system',
    allNodes: [target, residentA, residentB, dragged],
    absolutePositions: new Map([
      ['system', { x: 0, y: 0 }],
      // Residents sit inside the content box, stacked.
      ['a', { x: 60, y: 80 }],
      ['b', { x: 60, y: 220 }],
      // Dropped right on top of resident A.
      ['incoming', { x: 60, y: 80 }],
    ]),
    systemIds: new Set(['system']),
    fileIds: new Set(['a', 'b', 'incoming']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  const byId = new Map(plan.updates.map(update => [update.nodeId, update]))
  // The residents are not written at all — the strongest form of "they keep
  // the positions they already had", and proof no drop can nudge a bystander.
  assert.equal(byId.has('a'), false)
  assert.equal(byId.has('b'), false)
  // The newcomer moved off them rather than shoving them aside.
  const incoming = byId.get('incoming')
  assert.ok(
    incoming.positionX !== 60 || incoming.positionY !== 80,
    'newcomer should have slid clear of the resident it landed on',
  )
})

test('a same-parent move resolves collisions through the canonical packer', () => {
  const target = node('system', { type: 'system', style: { width: 900, height: 700 } })
  const resident = node('resident', {
    type: 'file',
    parentId: 'system',
    style: { width: 220, height: 110 },
  })
  const dragged = node('dragged', {
    type: 'file',
    parentId: 'system',
    selected: true,
    style: { width: 220, height: 110 },
  })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'dragged',
    targetNodeId: 'system',
    allNodes: [target, resident, dragged],
    absolutePositions: new Map([
      ['system', { x: 0, y: 0 }],
      ['resident', { x: 60, y: 100 }],
      ['dragged', { x: 60, y: 100 }],
    ]),
    systemIds: new Set(['system']),
    fileIds: new Set(['resident', 'dragged']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  const settled = plan.updates.find(update => update.nodeId === 'dragged')
  assert.ok(settled.positionX !== 60 || settled.positionY !== 100)
  assert.equal(plan.updates.some(update => update.nodeId === 'system'), false,
    'an in-place collision must not progressively compress its parent')
})

test('root nodes use the same collision placement as framed children', () => {
  const resident = node('resident', { style: { width: 220, height: 110 } })
  const dragged = node('dragged', {
    selected: true,
    style: { width: 220, height: 110 },
  })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'dragged',
    targetNodeId: null,
    allNodes: [resident, dragged],
    absolutePositions: new Map([
      ['resident', { x: 100, y: 100 }],
      ['dragged', { x: 100, y: 100 }],
    ]),
    systemIds: new Set(),
    fileIds: new Set(),
    infraIds: new Set(['resident', 'dragged']),
    floorLayouts: [],
  })

  const settled = plan.updates.find(update => update.nodeId === 'dragged')
  assert.ok(settled.positionX !== 100 || settled.positionY !== 100)
  assert.deepEqual(plan.updates.map(update => update.nodeId), ['dragged'])
})

test('a fragmented same-parent collision performs a deterministic sibling repack', () => {
  const target = node('frame', { type: 'system', style: { width: 520, height: 320 } })
  const residentA = node('a', {
    type: 'file', parentId: 'frame', style: { width: 220, height: 110 },
  })
  const residentB = node('b', {
    type: 'file', parentId: 'frame', style: { width: 220, height: 110 },
  })
  const dragged = node('dragged', {
    type: 'file', parentId: 'frame', selected: true, style: { width: 220, height: 110 },
  })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'dragged',
    targetNodeId: 'frame',
    allNodes: [target, residentA, residentB, dragged],
    absolutePositions: new Map([
      ['frame', { x: 0, y: 0 }],
      ['a', { x: 28, y: 54 }],
      ['b', { x: 150, y: 150 }],
      ['dragged', { x: 28, y: 54 }],
    ]),
    systemIds: new Set(['frame']),
    fileIds: new Set(['a', 'b', 'dragged']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  assert.deepEqual(new Set(plan.updates.map(update => update.nodeId)), new Set(['a', 'b', 'dragged']))
  assert.equal(plan.updates.some(update => update.nodeId === 'frame'), false)
})

test('a newcomer adopts the size its new siblings already use', () => {
  const target = node('system', { type: 'system', style: { width: 900, height: 700 } })
  const resident = node('a', { style: { width: 110, height: 55 }, data: { worldScale: 0.5 } })
  const dragged = node('incoming', { selected: true, data: { worldScale: 1 } })
  target.id = 'system'
  target.data = { worldScale: 1 }
  resident.parentId = 'system'

  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'incoming',
    targetNodeId: 'system',
    allNodes: [target, resident, dragged],
    absolutePositions: new Map([
      ['system', { x: 0, y: 0 }],
      ['a', { x: 60, y: 80 }],
      ['incoming', { x: 400, y: 300 }],
    ]),
    systemIds: new Set(['system']),
    fileIds: new Set(['a', 'incoming']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  const incoming = plan.updates.find(update => update.nodeId === 'incoming')
  // Sibling world scale 0.5 inside a target of world scale 1.
  assert.equal(incoming.scale, 0.5)
})

test('invalid projected scales cannot corrupt persisted geometry', () => {
  const target = node('system', {
    type: 'system',
    style: { width: 900, height: 700 },
    data: { worldScale: Number.NaN, contentScale: 'invalid', interiorScale: 0 },
  })
  const dragged = node('incoming', {
    selected: true,
    data: { worldScale: 'invalid' },
  })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'incoming',
    targetNodeId: 'system',
    allNodes: [target, dragged],
    absolutePositions: new Map([
      ['system', { x: 0, y: 0 }],
      ['incoming', { x: 100, y: 120 }],
    ]),
    systemIds: new Set(['system']),
    fileIds: new Set(['incoming']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  for (const update of plan.updates) {
    for (const value of [
      update.positionX, update.positionY, update.width, update.height,
      update.scale, update.interiorScale,
    ]) assert.ok(Number.isFinite(value) && value > 0)
  }
})

// --- Case 3: the frame has no room at all -----------------------------------

/** A 620x420 frame packed solid with 220x110 children at world scale 1. */
const crowdedFrame = () => {
  const target = node('frame', { type: 'system', style: { width: 620, height: 420 } })
  const residents = []
  const positions = new Map([['frame', { x: 0, y: 0 }]])
  let index = 0
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 2; column++) {
      const id = 'resident' + index++
      residents.push(node(id, { type: 'file', parentId: 'frame', style: { width: 220, height: 110 } }))
      positions.set(id, { x: 28 + column * 232, y: 54 + row * 122 })
    }
  }
  const dragged = node('newcomer', { type: 'file', selected: true, style: { width: 220, height: 110 } })
  positions.set('newcomer', { x: 200, y: 200 })
  return { target, residents, dragged, positions }
}

const crowdedPlan = (floorLayouts = []) => {
  const { target, residents, dragged, positions } = crowdedFrame()
  return planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'newcomer',
    targetNodeId: 'frame',
    allNodes: [target, ...residents, dragged],
    absolutePositions: positions,
    systemIds: new Set(['frame']),
    fileIds: new Set([...residents.map(item => item.id), 'newcomer']),
    infraIds: new Set(),
    floorLayouts,
  })
}

test('a drop into a full frame compresses its interior and moves nobody', () => {
  const plan = crowdedPlan()
  const written = new Set(plan.updates.map(update => update.nodeId))

  assert.ok(written.has('newcomer'), 'the newcomer gets a row')
  assert.ok(written.has('frame'), 'the container gets a row for its new interior scale')
  for (const id of ['resident0', 'resident1', 'resident2', 'resident3', 'resident4', 'resident5']) {
    assert.equal(written.has(id), false, `resident ${id} must never be rewritten`)
  }

  const frameUpdate = plan.updates.find(update => update.nodeId === 'frame')
  assert.ok(frameUpdate.interiorScale < 1, 'the interior compresses')
  // The container's own geometry is untouched — that is the entire point.
  assert.equal(frameUpdate.width, 620)
  assert.equal(frameUpdate.height, 420)
  assert.equal(frameUpdate.scale, 1)
  assert.equal(frameUpdate.positionX, 0)
  assert.equal(frameUpdate.positionY, 0)
})

test('the compressed frame reuses its persisted geometry rather than reprojecting it', () => {
  const previous = {
    workspaceId: 'workspace', nodeId: 'frame', nodeType: 'system',
    parentNodeId: null, parentNodeType: null, containmentKind: 'root',
    positionX: 12.5, positionY: 34.25, width: 620, height: 420,
    scale: 1, interiorScale: 1, updatedAt: 5,
  }
  const frameUpdate = crowdedPlan([previous]).updates.find(update => update.nodeId === 'frame')
  assert.equal(frameUpdate.positionX, 12.5)
  assert.equal(frameUpdate.positionY, 34.25)
  assert.ok(frameUpdate.interiorScale < 1)
})

test('a drop with room does not touch the container at all', () => {
  const target = node('frame', { type: 'system', style: { width: 620, height: 420 } })
  const dragged = node('newcomer', { type: 'file', selected: true, style: { width: 220, height: 110 } })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'newcomer',
    targetNodeId: 'frame',
    allNodes: [target, dragged],
    absolutePositions: new Map([['frame', { x: 0, y: 0 }], ['newcomer', { x: 60, y: 100 }]]),
    systemIds: new Set(['frame']),
    fileIds: new Set(['newcomer']),
    infraIds: new Set(),
    floorLayouts: [],
  })
  assert.deepEqual(plan.updates.map(update => update.nodeId), ['newcomer'])
})

// --- Two-phase commit: every correction must be watchable --------------------

test('a reparenting drop arrives where it was released, then animates to its slot', () => {
  const target = node('frame', { type: 'system', style: { width: 620, height: 420 } })
  // Released overhanging the frame's left edge, cursor inside — the exact case
  // that used to teleport, because the reparent and the push happened at once.
  const dragged = node('newcomer', { type: 'file', selected: true, style: { width: 220, height: 110 } })
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'newcomer',
    targetNodeId: 'frame',
    allNodes: [target, dragged],
    absolutePositions: new Map([['frame', { x: 0, y: 0 }], ['newcomer', { x: -40, y: 200 }]]),
    systemIds: new Set(['frame']),
    fileIds: new Set(['newcomer']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  const arrival = plan.arrivalLayouts.find(item => item.nodeId === 'newcomer')
  const settled = plan.optimisticLayouts.find(item => item.nodeId === 'newcomer')

  // Phase one is the release point exactly — still overhanging.
  assert.equal(arrival.positionX, -40)
  assert.equal(arrival.positionY, 200)
  // Phase two pushes it clear of the edge, so there is a real distance to move.
  assert.ok(settled.positionX > arrival.positionX,
    'the correction must be a movement, not the first frame the node renders at')
  // Both phases are the same row under the same new parent: the reparent
  // itself is visually a no-op, which is what lets the push animate.
  assert.equal(arrival.parentNodeId, 'frame')
  assert.equal(settled.parentNodeId, 'frame')
})

test('the size-parity change is animated rather than applied on arrival', () => {
  const target = node('frame', { type: 'system', style: { width: 900, height: 700 } })
  const resident = node('a', { style: { width: 110, height: 55 }, data: { worldScale: 0.5 } })
  const dragged = node('newcomer', { selected: true, data: { worldScale: 1 } })
  resident.parentId = 'frame'
  const plan = planCanvasDrop({
    workspaceId: 'workspace',
    draggedNodeId: 'newcomer',
    targetNodeId: 'frame',
    allNodes: [target, resident, dragged],
    absolutePositions: new Map([
      ['frame', { x: 0, y: 0 }],
      ['a', { x: 40, y: 60 }],
      ['newcomer', { x: 400, y: 400 }],
    ]),
    systemIds: new Set(['frame']),
    fileIds: new Set(['a', 'newcomer']),
    infraIds: new Set(),
    floorLayouts: [],
  })

  const arrival = plan.arrivalLayouts.find(item => item.nodeId === 'newcomer')
  const settled = plan.optimisticLayouts.find(item => item.nodeId === 'newcomer')
  assert.equal(arrival.scale, 1, 'arrives at the size it was dragged at')
  assert.equal(settled.scale, 0.5, 'then shrinks to match its new siblings')
})

test('interior compression starts uncompressed so the shrink is visible', () => {
  const plan = crowdedPlan()
  const arrival = plan.arrivalLayouts.find(item => item.nodeId === 'frame')
  const settled = plan.optimisticLayouts.find(item => item.nodeId === 'frame')
  assert.equal(arrival.interiorScale, 1)
  assert.ok(settled.interiorScale < 1)
})
