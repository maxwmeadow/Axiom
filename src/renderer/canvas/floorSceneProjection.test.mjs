import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFloorNodes } from './floorSceneProjection.ts'

const geometry = (x, y, width, height, scale = 1, interiorScale = 1) =>
  ({ x, y, width, height, scale, interiorScale })

test('projects canonical nested geometry into React Flow coordinates without quantizing', () => {
  const systemGeometry = geometry(10.25, 20.5, 620, 420, 0.5)
  const fileGeometry = geometry(30.125, 60.75, 220, 110)
  const descriptors = [
    { id: 'system', nodeType: 'system', parentId: null, depth: 0, geometry: systemGeometry, worldScale: 0.5, contentScale: 0.5 },
    { id: 'file', nodeType: 'file', parentId: 'system', depth: 1, geometry: fileGeometry, worldScale: 0.5, contentScale: 0.5 },
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
    contentScaleById: new Map([['system', 0.5], ['file', 0.5]]),
    currentZoom: 66.125,
  })

  assert.deepEqual(nodes.map(node => node.id), ['system', 'file'])
  assert.deepEqual(nodes[0].position, { x: 10.25, y: 20.5 })
  assert.deepEqual(nodes[0].style, { width: 310, height: 210 })
  assert.equal(nodes[0].initialWidth, 310)
  assert.equal(nodes[0].initialHeight, 210)
  assert.equal(nodes[0].data.directChildCount, 1)
  assert.equal(nodes[0].data.currentZoom, 66.125)

  assert.deepEqual(nodes[1].position, { x: 15.0625, y: 30.375 })
  assert.deepEqual(nodes[1].style, { width: 110, height: 55 })
  assert.equal(nodes[1].initialWidth, 110)
  assert.equal(nodes[1].initialHeight, 55)
  assert.equal(nodes[1].parentId, 'system')
  assert.equal(nodes[1].data.label, 'App.tsx')
})

test('projects platform infrastructure as a system and ordinary infrastructure as infra', () => {
  const platformGeometry = geometry(1, 2, 760, 520)
  const databaseGeometry = geometry(900, 20, 260, 160)
  const descriptors = [
    { id: 'platform', nodeType: 'infra', parentId: null, depth: 0, geometry: platformGeometry, worldScale: 1, contentScale: 1 },
    { id: 'database', nodeType: 'infra', parentId: null, depth: 0, geometry: databaseGeometry, worldScale: 1, contentScale: 1 },
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
    contentScaleById: new Map([['platform', 1], ['database', 1]]),
    currentZoom: 1,
  })

  assert.equal(nodes[0].type, 'system')
  assert.equal(nodes[0].data.umlKind, 'infra')
  assert.equal(nodes[0].data.umlMetadata.provider, 'aws')
  assert.equal(nodes[1].type, 'infra')
  assert.equal(nodes[1].data.status, 'proposed')
})

/**
 * The invariant that made interior compression possible at all. A container's
 * chrome is sized from `presentationScale`; if that value moved when the
 * container compressed its contents, the tab and title would GROW as the
 * interior shrank. Both terms are canonical, so it cannot.
 */
const compressionScene = (interiorScale) => {
  const systemGeometry = geometry(0, 0, 620, 420, 1, interiorScale)
  const fileGeometry = geometry(100, 100, 220, 110)
  return projectFloorNodes({
    systems: [{
      id: 'system', name: 'Renderer', source: 'directory', color: null,
      description: null, agentNotes: null, width: 620, height: 420,
    }],
    files: [{
      id: 'file', relPath: 'src/App.tsx', language: 'tsx', lineCount: 10,
      churnScore: 0, shape: '', shapeOverride: '', displayName: '', width: 220, height: 110,
    }],
    infraNodes: [],
    descriptors: [
      { id: 'system', nodeType: 'system', parentId: null, depth: 0, geometry: systemGeometry, worldScale: 1, contentScale: interiorScale },
      { id: 'file', nodeType: 'file', parentId: 'system', depth: 1, geometry: fileGeometry, worldScale: interiorScale, contentScale: interiorScale },
    ],
    siblingsByParent: new Map([[null, ['system']], ['system', ['file']]]),
    geometryById: new Map([['system', systemGeometry], ['file', fileGeometry]]),
    worldScaleById: new Map([['system', 1], ['file', interiorScale]]),
    contentScaleById: new Map([['system', interiorScale], ['file', interiorScale]]),
    currentZoom: 1,
  })
}

test('interior compression leaves the container itself completely untouched', () => {
  const [openSystem] = compressionScene(1)
  const [tightSystem] = compressionScene(0.5)

  assert.deepEqual(tightSystem.style, openSystem.style, 'rendered size must not move')
  assert.deepEqual(tightSystem.position, openSystem.position, 'position must not move')
  assert.equal(tightSystem.data.presentationScale, openSystem.data.presentationScale,
    'presentationScale drives the chrome and must be blind to compression')
  assert.equal(tightSystem.data.presentationBaseWidth, openSystem.data.presentationBaseWidth)
})

test('interior compression shrinks the contents, uniformly and in place', () => {
  const open = compressionScene(1)[1]
  const tight = compressionScene(0.5)[1]

  assert.deepEqual(tight.style, { width: 110, height: 55 }, 'child halves')
  assert.deepEqual(open.style, { width: 220, height: 110 })
  // Same multiple on both axes and on position: a similarity transform about
  // the frame origin, so relative arrangement survives exactly.
  assert.equal(tight.position.x / open.position.x, 0.5)
  assert.equal(tight.position.y / open.position.y, 0.5)
})

test('presentationScale carries no world-scale term, so depth is counted once', () => {
  const rootGeometry = geometry(0, 0, 620, 420, 1)
  const nestedGeometry = geometry(0, 0, 620, 420, 0.5)
  const nodes = projectFloorNodes({
    systems: [
      { id: 'root', name: 'Root', source: 'directory', color: null, description: null, agentNotes: null, width: 620, height: 420 },
      { id: 'nested', name: 'Nested', source: 'directory', color: null, description: null, agentNotes: null, width: 620, height: 420 },
    ],
    files: [],
    infraNodes: [],
    descriptors: [
      { id: 'root', nodeType: 'system', parentId: null, depth: 0, geometry: rootGeometry, worldScale: 1, contentScale: 1 },
      { id: 'nested', nodeType: 'system', parentId: 'root', depth: 1, geometry: nestedGeometry, worldScale: 0.5, contentScale: 0.5 },
    ],
    siblingsByParent: new Map([[null, ['root']], ['root', ['nested']]]),
    geometryById: new Map([['root', rootGeometry], ['nested', nestedGeometry]]),
    worldScaleById: new Map([['root', 1], ['nested', 0.5]]),
    contentScaleById: new Map([['root', 1], ['nested', 0.5]]),
    currentZoom: 1,
  })

  // Both frames are authored at their design size, so both read 1 regardless of
  // how deep they sit. Depth reaches the chrome only through DEPTH_TITLE_PX.
  assert.equal(nodes[0].data.presentationScale, 1)
  assert.equal(nodes[1].data.presentationScale, 1)
})
