import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptySelection,
  selectedNodeIds,
  selectionAfterNodeChanges,
  singleNodeSelection,
  stampSelection,
} from './selectionController.ts'

test('click selection replaces the previous set and pane selection clears it', () => {
  assert.deepEqual([...singleNodeSelection('file')], ['file'])
  assert.equal(emptySelection().size, 0)
})

test('ordered React Flow changes add and remove lasso members without mutating the input', () => {
  const current = new Set(['existing', 'removed'])
  const next = selectionAfterNodeChanges(current, [
    { id: 'removed', type: 'select', selected: false },
    { id: 'first', type: 'select', selected: true },
    { id: 'second', type: 'select', selected: true },
    { id: 'ignored', type: 'position', position: { x: 1, y: 2 } },
  ])

  assert.deepEqual([...current], ['existing', 'removed'])
  assert.deepEqual([...next], ['existing', 'first', 'second'])
})

test('scene stamping merges lasso selection with the primary store selection', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const stamped = stampSelection(nodes, new Set(['a', 'c']), 'b')
  assert.deepEqual(selectedNodeIds(stamped), ['a', 'b', 'c'])
  assert.equal(nodes[0].selected, undefined)
})
