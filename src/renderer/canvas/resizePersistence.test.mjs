import assert from 'node:assert/strict'
import test from 'node:test'
import { planFloorResize, planSheetResize, replaceFloorLayouts } from './resizePersistence.ts'

const node = (id, overrides = {}) => ({
  id,
  position: { x: 0, y: 0 },
  data: { frameScale: 1, worldScale: 1 },
  style: { width: 100, height: 50 },
  ...overrides,
})

test('plans an optimistic Floor resize and compensates direct children', () => {
  const parent = node('system')
  const child = node('file', { parentId: 'system' })
  const start = { x: 0, y: 0, width: 620, height: 420, children: new Map([['file', { x: 100, y: 120 }]]) }
  const plan = planFloorResize({
    workspaceId: 'workspace',
    nodeId: 'system',
    node: parent,
    start,
    end: { x: 10, y: 20, width: 700, height: 500 },
    nodes: [parent, child],
    systemIds: new Set(['system']),
    fileIds: new Set(['file']),
    infraIds: new Set(),
    floorLayouts: [],
    now: 1234,
  })

  assert.deepEqual(plan.updates[0], {
    nodeId: 'system', nodeType: 'system', parentNodeId: null, parentNodeType: null,
    containmentKind: 'root', positionX: 10, positionY: 20,
    width: 700, height: 500, scale: 1,
  })
  assert.equal(plan.updates[1].positionX, 90)
  assert.equal(plan.updates[1].positionY, 100)
  assert.equal(plan.optimisticLayouts[0].workspaceId, 'workspace')
  assert.equal(plan.optimisticLayouts[0].updatedAt, 1234)
  assert.deepEqual([...plan.changedKeys], ['system:system', 'file:file'])
})

test('preserves previous child dimensions and produces a precise rollback set', () => {
  const parent = node('platform', { data: { frameScale: 0.5, worldScale: 0.5 } })
  const child = node('service', { parentId: 'platform', data: { frameScale: 0.75, worldScale: 0.375 } })
  const previousChild = {
    workspaceId: 'workspace', nodeId: 'service', nodeType: 'system',
    parentNodeId: 'platform', parentNodeType: 'infra', containmentKind: 'hosted_by',
    positionX: 20, positionY: 30, width: 333.25, height: 222.75, scale: 0.75, updatedAt: 10,
  }
  const untouched = { ...previousChild, nodeId: 'untouched', updatedAt: 11 }
  const plan = planFloorResize({
    workspaceId: 'workspace', nodeId: 'platform', node: parent,
    start: { x: 0, y: 0, width: 380, height: 260, children: new Map([['service', { x: 20, y: 30 }]]) },
    end: { x: 0, y: 0, width: 400.5, height: 280.25 },
    nodes: [parent, child],
    systemIds: new Set(['service']), fileIds: new Set(), infraIds: new Set(['platform']),
    floorLayouts: [previousChild, untouched], now: 20,
  })

  assert.equal(plan.updates[1].width, 333.25)
  assert.equal(plan.updates[1].height, 222.75)
  assert.deepEqual(plan.previousLayouts, [previousChild])
  assert.deepEqual(replaceFloorLayouts(plan.optimisticLayouts.concat(untouched), plan.previousLayouts, plan.changedKeys), [untouched, previousChild])
})

test('maps sheet live and planned nodes to one resize batch', () => {
  const parent = node('planned:parent', { data: { frameScale: 1, worldScale: 1 } })
  const mutations = planSheetResize({
    nodeId: 'planned:parent',
    node: parent,
    start: { x: 0, y: 0, width: 300, height: 200, children: new Map([['live-child', { x: 40, y: 50 }]]) },
    end: { x: 5, y: 10, width: 360, height: 240 },
    elements: [{ id: 'element-child', systemId: 'live-child', fileId: null, infraId: null }],
    planned: [{ id: 'parent' }],
  })

  assert.deepEqual(mutations, [
    { kind: 'planned', id: 'parent', x: 5, y: 10, parentSystemId: null, width: 360, height: 240, scale: 1 },
    { kind: 'element', id: 'element-child', x: 35, y: 40, parentSystemId: 'planned:parent' },
  ])
})
