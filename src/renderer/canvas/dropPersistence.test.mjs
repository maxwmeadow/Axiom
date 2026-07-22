import assert from 'node:assert/strict'
import test from 'node:test'
import { planFloorDrop, planSheetDrop } from './dropPersistence.ts'

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
  const plan = planFloorDrop({
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
  const plan = planFloorDrop({
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
  assert.equal(plan.updates[0].positionY, 100)
})

test('creates one sheet batch for selected live and planned roots', () => {
  const live = node('live', { type: 'file', selected: true, style: { width: 220, height: 110 } })
  const planned = node('planned:draft', { type: 'file', selected: true, style: { width: 240, height: 120 } })
  const plan = planSheetDrop({
    draggedNodeId: 'live',
    targetNodeId: null,
    allNodes: [live, planned],
    absolutePositions: new Map([
      ['live', { x: 10.5, y: 20.25 }],
      ['planned:draft', { x: 300.75, y: 200.5 }],
    ]),
    activeNodeIds: new Set(['live', 'planned:draft']),
    elements: [{ id: 'element-live', systemId: null, fileId: 'live', infraId: null }],
    planned: [{ id: 'draft' }],
  })

  assert.deepEqual(plan.selectedIds, ['live', 'planned:draft'])
  assert.deepEqual(plan.mutations.map(mutation => ({
    kind: mutation.kind,
    id: mutation.id,
    x: mutation.x,
    y: mutation.y,
  })), [
    { kind: 'element', id: 'element-live', x: 10.5, y: 20.25 },
    { kind: 'planned', id: 'draft', x: 300.75, y: 200.5 },
  ])
})
