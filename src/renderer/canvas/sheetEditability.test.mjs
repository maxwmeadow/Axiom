import assert from 'node:assert/strict'
import test from 'node:test'
import { sheetEditableNodeIds } from './sheetEditability.ts'

test('an active sheet can move every live canvas node on first drag', () => {
  const editable = sheetEditableNodeIds({
    activeSheetId: 'sheet-a',
    liveNodeIds: ['live-system', 'live-file', 'live-class', 'live-infra'],
    activePlannedNodeIds: ['planned:owned'],
    activeLayoutNodeIds: [],
  })

  assert.equal(editable.has('live-file'), true)
  assert.equal(editable.has('live-class'), true)
  assert.equal(editable.has('planned:owned'), true)
})

test('planned nodes from secondary sheets do not become editable', () => {
  const editable = sheetEditableNodeIds({
    activeSheetId: 'sheet-a',
    liveNodeIds: ['live-file'],
    activePlannedNodeIds: ['planned:owned'],
    activeLayoutNodeIds: [],
  })

  assert.equal(editable.has('planned:secondary'), false)
})

test('visible sheets without an active sheet stay read-only', () => {
  const editable = sheetEditableNodeIds({
    activeSheetId: null,
    liveNodeIds: ['live-file'],
    activePlannedNodeIds: ['planned:owned'],
    activeLayoutNodeIds: ['live-file'],
  })

  assert.deepEqual([...editable], [])
})
