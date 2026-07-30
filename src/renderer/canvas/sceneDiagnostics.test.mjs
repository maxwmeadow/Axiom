import assert from 'node:assert/strict'
import test from 'node:test'
import { diffScene, sceneDeltaIsQuiet, sceneGeometry } from './sceneDiagnostics.ts'

const node = (id, x, y, overrides = {}) => ({
  id,
  position: { x, y },
  style: { width: 220, height: 110 },
  ...overrides,
})

test('a scene that did not change reports nothing', () => {
  const scene = sceneGeometry([node('a', 0, 0), node('b', 300, 0)])
  const delta = diffScene(scene, scene)
  assert.equal(sceneDeltaIsQuiet(delta), true)
  assert.equal(delta.largestMove, 0)
})

test('a teleporting node is reported with its exact displacement', () => {
  const before = sceneGeometry([node('a', 0, 0), node('b', 300, 0)])
  const after = sceneGeometry([node('a', 0, -900), node('b', 300, 0)])
  const delta = diffScene(before, after)

  assert.equal(sceneDeltaIsQuiet(delta), false)
  assert.equal(delta.moved.length, 1)
  assert.equal(delta.moved[0].id, 'a')
  assert.deepEqual(delta.moved[0].from, { x: 0, y: 0 })
  assert.deepEqual(delta.moved[0].to, { x: 0, y: -900 })
  assert.equal(delta.moved[0].dy, -900)
  assert.equal(delta.largestMove, 900)
})

test('resizes, reparents, additions and removals are each attributed', () => {
  const before = sceneGeometry([
    node('a', 0, 0),
    node('b', 300, 0, { parentId: 'sys-1' }),
    node('gone', 10, 10),
  ])
  const after = sceneGeometry([
    node('a', 0, 0, { style: { width: 440, height: 220 } }),
    node('b', 300, 0, { parentId: 'sys-2' }),
    node('fresh', 50, 50),
  ])
  const delta = diffScene(before, after)

  assert.deepEqual(delta.resized.map(item => item.id), ['a'])
  assert.deepEqual(delta.resized[0].to, { width: 440, height: 220 })
  assert.deepEqual(delta.reparented, [{ id: 'b', from: 'sys-1', to: 'sys-2' }])
  assert.deepEqual(delta.added, ['fresh'])
  assert.deepEqual(delta.removed, ['gone'])
  // A node that only appeared or vanished is not counted as movement.
  assert.equal(delta.largestMove, 0)
})
