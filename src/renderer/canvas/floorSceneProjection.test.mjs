import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFloorNodes } from './floorSceneProjection.ts'

const geometry = (x, y, width, height, scale = 1) => ({ x, y, width, height, scale })

test('projects canonical nested geometry into React Flow coordinates without quantizing', () => {
  const systemGeometry = geometry(10.25, 20.5, 620, 420, 0.5)
  const fileGeometry = geometry(30.125, 60.75, 220, 110)
  const descriptors = [
    { id: 'system', nodeType: 'system', parentId: null, depth: 0, geometry: systemGeometry, worldScale: 0.5 },
    { id: 'file', nodeType: 'file', parentId: 'system', depth: 1, geometry: fileGeometry, worldScale: 0.5 },
  ]

  const nodes = projectFloorNodes({
    systems: [{
      id: 'system', name: 'Renderer', source: 'directory', color: null,
      description: null, agentNotes: null, width: 620, height: 420,
    }],
    files: [{
      id: 'file', relPath: 'src/renderer/App.tsx', language: 'tsx', lineCount: 200,
      churnScore: 0.4, shape: '', shapeOverride: '', displayName: '', width: 220, height: 110,
    }],
    infraNodes: [],
    descriptors,
    siblingsByParent: new Map([[null, ['system']], ['system', ['file']]]),
    geometryById: new Map([['system', systemGeometry], ['file', fileGeometry]]),
    worldScaleById: new Map([['system', 0.5], ['file', 0.5]]),
    agentTouchedIds: new Set(['file']),
    currentZoom: 66.125,
  })

  assert.deepEqual(nodes.map(node => node.id), ['system', 'file'])
  assert.deepEqual(nodes[0].position, { x: 10.25, y: 20.5 })
  assert.deepEqual(nodes[0].style, { width: 310, height: 210 })
  assert.equal(nodes[0].data.directChildCount, 1)
  assert.equal(nodes[0].data.currentZoom, 66.125)

  assert.deepEqual(nodes[1].position, { x: 15.0625, y: 30.375 })
  assert.deepEqual(nodes[1].style, { width: 110, height: 55 })
  assert.equal(nodes[1].parentId, 'system')
  assert.equal(nodes[1].data.label, 'App.tsx')
  assert.equal(nodes[1].data.agentTouched, true)
})

test('projects platform infrastructure as a system and ordinary infrastructure as infra', () => {
  const platformGeometry = geometry(1, 2, 760, 520)
  const databaseGeometry = geometry(900, 20, 260, 160)
  const descriptors = [
    { id: 'platform', nodeType: 'infra', parentId: null, depth: 0, geometry: platformGeometry, worldScale: 1 },
    { id: 'database', nodeType: 'infra', parentId: null, depth: 0, geometry: databaseGeometry, worldScale: 1 },
  ]
  const infraNodes = [
    { id: 'platform', name: 'AWS', infraType: 'cloud', category: 'platform', provider: 'aws', service: '', subtype: '', status: 'confirmed' },
    { id: 'database', name: 'Postgres', infraType: 'postgres', category: 'database', provider: 'postgres', service: 'postgresql', subtype: 'sql', status: 'proposed' },
  ]

  const nodes = projectFloorNodes({
    systems: [],
    files: [],
    infraNodes,
    descriptors,
    siblingsByParent: new Map([[null, ['platform', 'database']]]),
    geometryById: new Map([['platform', platformGeometry], ['database', databaseGeometry]]),
    worldScaleById: new Map([['platform', 1], ['database', 1]]),
    agentTouchedIds: new Set(),
    currentZoom: 1,
  })

  assert.equal(nodes[0].type, 'system')
  assert.equal(nodes[0].data.umlKind, 'infra')
  assert.equal(nodes[0].data.umlMetadata.provider, 'aws')
  assert.equal(nodes[1].type, 'infra')
  assert.equal(nodes[1].data.status, 'proposed')
})
