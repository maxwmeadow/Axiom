import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptySelection,
  isAdditiveEvent,
  selectedNodeIds,
  selectionAfterDragStart,
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

test('the scene is painted from the selection set and from nothing else', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const stamped = stampSelection(nodes, new Set(['a', 'c']))
  assert.deepEqual(selectedNodeIds(stamped), ['a', 'c'])
  assert.equal(nodes[0].selected, undefined)

  // Nodes leaving the set are actively cleared, not merely left alone. A second
  // notion of a "current" node used to be merged in here, which meant a node
  // revealed from the search bar could never be deselected by any gesture.
  const cleared = stampSelection(stamped, new Set(['b']))
  assert.deepEqual(selectedNodeIds(cleared), ['b'])
})

// ── Clicking ────────────────────────────────────────────────────────────────

test('a modifier press reaches the selection as ordered changes, not as a rule to redo', () => {
  // React Flow performs the toggle on pointer down; Axiom only reconciles it.
  // Re-deriving the toggle here is what cancelled a modifier click out.
  const afterCtrlClickAddingB = selectionAfterNodeChanges(new Set(['a']), [
    { id: 'b', type: 'select', selected: true },
  ])
  assert.deepEqual([...afterCtrlClickAddingB], ['a', 'b'])

  const afterCtrlClickRemovingA = selectionAfterNodeChanges(afterCtrlClickAddingB, [
    { id: 'a', type: 'select', selected: false },
  ])
  assert.deepEqual([...afterCtrlClickRemovingA], ['b'])
})

test('a plain press arrives as a deselect of everything else plus one select', () => {
  const next = selectionAfterNodeChanges(new Set(['a', 'b']), [
    { id: 'a', type: 'select', selected: false },
    { id: 'b', type: 'select', selected: false },
    { id: 'c', type: 'select', selected: true },
  ])
  assert.deepEqual([...next], ['c'])
})

test('ctrl, cmd and shift all mean "add"; a bare click does not', () => {
  assert.equal(isAdditiveEvent({ ctrlKey: true }), true)
  assert.equal(isAdditiveEvent({ metaKey: true }), true)
  assert.equal(isAdditiveEvent({ shiftKey: true }), true)
  assert.equal(isAdditiveEvent({}), false)
  assert.equal(isAdditiveEvent({ ctrlKey: false, metaKey: false, shiftKey: false }), false)
})

// ── Dragging ────────────────────────────────────────────────────────────────

test('grabbing an unselected node drops whatever was selected before it', () => {
  // The reported bug: move one node, then grab a different one, and both stayed
  // selected - so the next drag carried the first node along with it.
  assert.deepEqual([...selectionAfterDragStart(new Set(['moved-earlier']), 'grabbed')], ['grabbed'])
  assert.deepEqual([...selectionAfterDragStart(new Set(['a', 'b', 'c']), 'grabbed')], ['grabbed'])
})

test('grabbing a node that is part of a group keeps the group so all of it moves', () => {
  const group = new Set(['a', 'b', 'c'])
  assert.deepEqual([...selectionAfterDragStart(group, 'b')].sort(), ['a', 'b', 'c'])
  // A copy, so a gesture cannot write back into the live set by accident.
  assert.notEqual(selectionAfterDragStart(group, 'b'), group)
})

test('one gesture at a time: click, drag, then grab something else never accumulates', () => {
  let selection = singleNodeSelection('A')
  selection = selectionAfterDragStart(selection, 'A')
  assert.deepEqual([...selection], ['A'])

  selection = selectionAfterDragStart(selection, 'B')
  assert.deepEqual([...selection], ['B'])

  // And the scene agrees - A is not left highlighted behind the gesture.
  assert.deepEqual(selectedNodeIds(stampSelection([{ id: 'A' }, { id: 'B' }], selection)), ['B'])
})

test('a deliberate group survives a drag of one of its members', () => {
  // Built the way a real ctrl-click group is: React Flow's select changes.
  let selection = singleNodeSelection('A')
  selection = selectionAfterNodeChanges(selection, [{ id: 'B', type: 'select', selected: true }])
  selection = selectionAfterNodeChanges(selection, [{ id: 'C', type: 'select', selected: true }])
  selection = selectionAfterDragStart(selection, 'B')
  assert.deepEqual([...selection].sort(), ['A', 'B', 'C'])
})
