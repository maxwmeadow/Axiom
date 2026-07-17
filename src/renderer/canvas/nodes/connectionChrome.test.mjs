import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionHandleProps } from './connectionChrome.ts'

test('connection hitboxes scale in world space without React Flow minimums', () => {
  const props = connectionHandleProps(true, 0.01)

  assert.equal(props.style.width, '0.06px')
  assert.equal(props.style.height, '0.06px')
  assert.equal(props.style.minWidth, 0)
  assert.equal(props.style.minHeight, 0)
  assert.equal(props.style.pointerEvents, undefined)
})

test('disabled connection handles cannot consume node interactions', () => {
  const props = connectionHandleProps(false, 0.01)

  assert.equal(props.isConnectable, false)
  assert.equal(props.isConnectableStart, false)
  assert.equal(props.isConnectableEnd, false)
  assert.equal(props.style.pointerEvents, 'none')
})

test('connection-handle offsets use the same presentation scale', () => {
  const props = connectionHandleProps(true, 0.01, { right: -6 })

  assert.equal(props.style.right, '-0.06px')
})
