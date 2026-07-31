import assert from 'node:assert/strict'
import test from 'node:test'
import {
  absolutePosition,
  projectSheetNodes,
  sheetDeleteIntent,
  sheetRemovals,
} from './sheetProjection.ts'

function node(id, x, y, parentId) {
  return { id, position: { x, y }, parentId, data: {}, style: {} }
}

test('a sheet with no opinions changes nothing at all', () => {
  const nodes = [node('a', 0, 0), node('b', 10, 10)]
  const result = projectSheetNodes(nodes, [])
  assert.equal(result.nodes, nodes, 'identity preserved for memoization')
  assert.deepEqual(result.moved, [])
  assert.deepEqual(result.removed, [])
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
  // Absolute, because Floor coordinates are parent-relative and sheet ones are
  // not — the endpoints have to be comparable.
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

test('a removed node leaves the sheet picture but is still reported', () => {
  // Proposing removal is design intent. It must be expressible, and it must be
  // recoverable, so the projection has to hand back what it took out.
  const nodes = [node('a', 0, 0), node('b', 10, 10)]
  const result = projectSheetNodes(nodes, [], ['b'])

  assert.deepEqual(result.nodes.map(n => n.id), ['a'])
  assert.deepEqual(result.removed, ['b'])
})

test('removal wins over a move, so a node is never both gone and placed', () => {
  const nodes = [node('a', 0, 0)]
  const result = projectSheetNodes(nodes, [{ nodeId: 'a', x: 900, y: 900 }], ['a'])

  assert.deepEqual(result.nodes, [])
  assert.deepEqual(result.moved, [], 'a removed node is not also animated into place')
  assert.deepEqual(result.removed, ['a'])
})

test('removing a node the Floor no longer has is not reported as present', () => {
  const result = projectSheetNodes([node('a', 0, 0)], [], ['ghost'])
  assert.deepEqual(result.removed, [], 'only what was actually taken out of this picture')
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

test('deleting live code on a sheet proposes removal rather than destroying it', () => {
  const intent = sheetDeleteIntent({ onSheet: true, isSheetOnly: false })
  assert.equal(intent.kind, 'propose-removal')
  assert.equal(intent.destructive, false)
  assert.match(intent.restoreHint, /restore/i)
})

test('the same gesture on the Floor really does delete', () => {
  const intent = sheetDeleteIntent({ onSheet: false, isSheetOnly: false })
  assert.equal(intent.kind, 'delete-live')
  assert.equal(intent.destructive, true)
})

test('a sheet may truly delete its own content', () => {
  const intent = sheetDeleteIntent({ onSheet: true, isSheetOnly: true })
  assert.equal(intent.kind, 'sheet-element')
  assert.equal(intent.destructive, true)
})

test('removals are listed with names, not raw ids', () => {
  const removals = sheetRemovals(['f1'], new Map([['f1', 'api/handlers.py']]))
  assert.deepEqual(removals, [{ nodeId: 'f1', label: 'api/handlers.py', stillLive: true }])
})

test('a removal whose node genuinely disappeared is kept and marked', () => {
  // Silently dropping it would make the Removed list something you cannot
  // trust to be complete.
  const removals = sheetRemovals(['gone'], new Map())
  assert.equal(removals.length, 1)
  assert.equal(removals[0].stillLive, false)
  assert.equal(removals[0].label, 'gone')
})
