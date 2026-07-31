import assert from 'node:assert/strict'
import test from 'node:test'
import {
  absolutePosition,
  projectSheetNodes,
  sheetDeleteVerdict,
} from './sheetProjection.ts'

function node(id, x, y, parentId) {
  return { id, position: { x, y }, parentId, data: {}, style: {} }
}

test('a sheet with no opinions changes nothing at all', () => {
  const nodes = [node('a', 0, 0), node('b', 10, 10)]
  const result = projectSheetNodes(nodes, [])
  assert.equal(result.nodes, nodes, 'identity preserved for memoization')
  assert.deepEqual(result.moved, [])
})

test('nodes the sheet says nothing about stay exactly where the Floor put them', () => {
  // The old implementation dimmed these into inert scenery, which is what made
  // a sheet feel like drawing on glass over the architecture.
  const nodes = [node('a', 0, 0), node('b', 10, 10)]
  const result = projectSheetNodes(nodes, [{ nodeId: 'a', x: 500, y: 500 }])

  const untouched = result.nodes.find(n => n.id === 'b')
  assert.equal(untouched, nodes[1], 'unmentioned nodes are not even re-created')
})

test('a moved node reports both endpoints so the transition can animate it', () => {
  const nodes = [node('sys', 100, 100), node('file', 20, 30, 'sys')]
  const result = projectSheetNodes(nodes, [{ nodeId: 'file', x: 900, y: 900 }])

  assert.equal(result.moved.length, 1)
  // Absolute, because Floor coordinates are parent-relative and sheet ones
  // are not — the endpoints have to be comparable.
  assert.deepEqual(result.moved[0].from, { x: 120, y: 130 })
  assert.deepEqual(result.moved[0].to, { x: 900, y: 900 })
})

test('a moved node detaches from Floor containment', () => {
  // A proposed architecture is not bound by the current one; that is the point.
  const nodes = [node('sys', 100, 100), node('file', 20, 30, 'sys')]
  const result = projectSheetNodes(nodes, [{ nodeId: 'file', x: 900, y: 900 }])
  const moved = result.nodes.find(n => n.id === 'file')

  assert.equal(moved.parentId, undefined)
  assert.deepEqual(moved.position, { x: 900, y: 900 })
  assert.equal(moved.data.sheetPlaced, true)
})

test('a sheet may re-parent a node into a different system', () => {
  const nodes = [node('sysA', 0, 0), node('sysB', 500, 0), node('file', 10, 10, 'sysA')]
  const result = projectSheetNodes(nodes, [
    { nodeId: 'file', x: 20, y: 20, parentSystemId: 'sysB' },
  ])
  assert.equal(result.nodes.find(n => n.id === 'file').parentId, 'sysB')
})

test('absolute position walks the whole ancestor chain', () => {
  const nodes = [node('root', 100, 100), node('mid', 10, 10, 'root'), node('leaf', 1, 2, 'mid')]
  const byId = new Map(nodes.map(n => [n.id, n]))
  assert.deepEqual(absolutePosition(nodes[2], byId), { x: 111, y: 112 })
})

test('a cyclic parent chain cannot hang the projection', () => {
  const a = { id: 'a', position: { x: 1, y: 1 }, parentId: 'b' }
  const b = { id: 'b', position: { x: 2, y: 2 }, parentId: 'a' }
  const byId = new Map([['a', a], ['b', b]])
  assert.deepEqual(absolutePosition(a, byId), { x: 3, y: 3 })
})

test('live code cannot be deleted from a sheet', () => {
  const verdict = sheetDeleteVerdict('f1', { isSheetOnly: false, hasOverride: false })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.kind, 'anchored')
  assert.match(verdict.reason, /Floor/)
})

test('deleting a moved live node offers to return it to the Floor instead', () => {
  const verdict = sheetDeleteVerdict('f1', { isSheetOnly: false, hasOverride: true })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.kind, 'reset-to-floor')
})

test("a sheet may delete its own content", () => {
  const verdict = sheetDeleteVerdict('planned:1', { isSheetOnly: true, hasOverride: false })
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.kind, 'sheet-element')
})
