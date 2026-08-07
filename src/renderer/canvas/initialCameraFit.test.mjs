import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceSceneMeasurement, sceneMeasurementIsSettled } from './initialCameraFit.ts'

test('initial camera readiness requires the same measured scene across frames', () => {
  let state = { signature: null, stableFrames: 0 }
  state = advanceSceneMeasurement(state, 'a:0,0,200,100')
  assert.equal(sceneMeasurementIsSettled(state), false)
  state = advanceSceneMeasurement(state, 'a:0,0,200,100')
  assert.equal(sceneMeasurementIsSettled(state), true)
})

test('a projection change restarts camera settling from the new geometry', () => {
  let state = { signature: 'a:0,0,200,100', stableFrames: 1 }
  state = advanceSceneMeasurement(state, 'a:24,0,200,100')
  assert.deepEqual(state, { signature: 'a:24,0,200,100', stableFrames: 1 })
  assert.equal(sceneMeasurementIsSettled(state), false)
})

test('a missing node measurement invalidates earlier camera readiness', () => {
  const state = advanceSceneMeasurement(
    { signature: 'a:0,0,200,100', stableFrames: 2 },
    null,
  )
  assert.deepEqual(state, { signature: null, stableFrames: 0 })
  assert.equal(sceneMeasurementIsSettled(state), false)
})
