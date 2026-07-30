import assert from 'node:assert/strict'
import test from 'node:test'
import {
  livingVisibilityIndex,
  surfaceLivingNodeFx,
  visibleLivingEndpoints,
} from './livingVisibility.ts'

const nodes = [
  { id: 'outer', style: { opacity: 1 }, data: {} },
  { id: 'inner', parentId: 'outer', style: { opacity: 0 }, data: {} },
  { id: 'file-a', parentId: 'inner', style: { opacity: 0 }, data: {} },
  { id: 'other', style: { opacity: 1 }, data: {} },
  { id: 'file-b', parentId: 'other', style: { opacity: 0 }, data: {} },
]

test('hidden activity reveals the real node at its authored geometry', () => {
  const index = livingVisibilityIndex(nodes)
  assert.equal(index.visibleNodeId('file-a'), 'outer')
  assert.equal(index.visibleNodeId('file-b'), 'other')

  const projected = surfaceLivingNodeFx(nodes, {
    'file-a': { kind: 'edit', key: 7 },
  })
  const file = projected.find(node => node.id === 'file-a')
  assert.deepEqual(file.data.fx, {
    kind: 'edit',
    key: 7,
  })
  assert.equal(file.data.livingReveal, true)
  assert.equal(file.style.opacity, 1)
  assert.equal(file.style.pointerEvents, 'none')
  assert.equal(projected.find(node => node.id === 'outer').data.fx, null)
})

test('the visible containing system opens a window at the hidden file rectangle', () => {
  const geometryNodes = [
    {
      id: 'system',
      position: { x: 300, y: 200 },
      style: { opacity: 1, width: 620, height: 420 },
      data: {},
    },
    {
      id: 'file',
      parentId: 'system',
      position: { x: 144, y: 176 },
      style: { opacity: 0, width: 220, height: 110 },
      data: {},
    },
  ]
  const projected = surfaceLivingNodeFx(geometryNodes, {
    file: { kind: 'edit', key: 11, traceId: 'L000011' },
  }, {
    labelById: new Map([['file', 'task_store.py']]),
  })

  assert.deepEqual(projected[0].data.livingWindows, [{
    traceId: 'L000011',
      key: 11,
      kind: 'edit',
      originId: 'file',
      x: 144,
    y: 176,
    width: 220,
    height: 110,
  }])
})

test('canonical ancestry survives a flattened or missing display node', () => {
  const semanticParentById = new Map([
    ['file-a', 'inner'],
    ['inner', 'outer'],
    ['outer', null],
  ])
  const flattened = nodes
    .filter(node => node.id !== 'inner')
    .map(node => node.id === 'file-a' ? { ...node, parentId: undefined } : node)

  const index = livingVisibilityIndex(flattened, { semanticParentById })
  assert.equal(index.visibleNodeId('file-a'), 'outer')
  assert.equal(index.visibleNodeId('inner'), 'outer')
})

test('concurrent hidden descendants each reveal their real scene node', () => {
  const labelById = new Map([
    ['file-a', 'alpha.ts'],
    ['inner', 'inner'],
  ])
  const projected = surfaceLivingNodeFx(nodes, {
    'file-a': { kind: 'edit', key: 7 },
    inner: { kind: 'flow-add', key: 8 },
  }, { labelById })
  assert.equal(projected.find(node => node.id === 'file-a').data.livingReveal, true)
  assert.equal(projected.find(node => node.id === 'inner').data.livingReveal, true)
  assert.equal(projected.find(node => node.id === 'outer').data.fx, null)
})

test('missing origins fall back to the nearest canonical visible ancestor', () => {
  const withoutOrigin = nodes.filter(node => node.id !== 'file-a' && node.id !== 'inner')
  const semanticParentById = new Map([
    ['file-a', 'inner'],
    ['inner', 'outer'],
    ['outer', null],
  ])
  const labelById = new Map([
    ['file-a', 'alpha.ts'],
  ])
  const projected = surfaceLivingNodeFx(withoutOrigin, {
    'file-a': { kind: 'edit', key: 7 },
  }, { labelById, semanticParentById })

  assert.deepEqual(projected.find(node => node.id === 'outer').data.fx, {
    kind: 'surface-update',
    key: 7,
    originIds: ['file-a'],
    originLabels: ['alpha.ts'],
    count: 1,
  })
})

test('living flows reroute between visible containers and suppress internal loops', () => {
  assert.deepEqual(visibleLivingEndpoints(nodes, 'file-a', 'file-b'), {
    source: 'outer',
    target: 'other',
  })
  assert.equal(visibleLivingEndpoints(nodes, 'file-a', 'inner'), null)
})

test('a visible file keeps its own activity signal', () => {
  const visibleNodes = nodes.map(node =>
    node.id === 'file-a' ? { ...node, style: { opacity: 1 } } : node)
  const surfaced = surfaceLivingNodeFx(visibleNodes, {
    'file-a': { kind: 'edit', key: 9 },
  })
  assert.deepEqual(surfaced.find(node => node.id === 'file-a').data.fx, {
    kind: 'edit',
    key: 9,
  })
})
