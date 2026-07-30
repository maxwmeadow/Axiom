import assert from 'node:assert/strict'
import test from 'node:test'
import {
  editNodeFxKind,
  livingFlowEndpoints,
  relationshipVisual,
} from './livingChoreography.ts'

test('every real file edit uses the same node signal', () => {
  assert.equal(editNodeFxKind(true, true), 'edit')
  assert.equal(editNodeFxKind(true, false), null)
  assert.equal(editNodeFxKind(false, true), 'enter')
})

test('relationship lifecycle colors cannot be confused', () => {
  assert.deepEqual(relationshipVisual({ change: 'added' }), {
    color: '#2fa35d', targetKind: 'flow-add',
  })
  assert.deepEqual(relationshipVisual({ change: 'updated' }), {
    color: '#3c8f92', targetKind: 'flow-update',
  })
  assert.deepEqual(relationshipVisual({ change: 'removed' }), {
    color: '#b6534b', targetKind: 'flow-remove',
  })
})

test('living flows originate at the file that caused the relationship change', () => {
  assert.deepEqual(
    livingFlowEndpoints({ src: 'caller', dst: 'callee', originId: 'callee' }),
    { source: 'callee', target: 'caller' },
  )
  assert.deepEqual(
    livingFlowEndpoints({ src: 'caller', dst: 'callee', originId: 'caller' }),
    { source: 'caller', target: 'callee' },
  )
  assert.deepEqual(
    livingFlowEndpoints({ src: 'caller', dst: 'callee' }),
    { source: 'caller', target: 'callee' },
  )
})
