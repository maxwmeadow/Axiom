import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canPersistGeneratedFrame,
  growFrameToContainChildren,
  orderFramePlacementCandidates,
} from './incrementalFrameLayout.ts'

test('an unclassified file is not pinned to the root before classification settles', () => {
  assert.equal(canPersistGeneratedFrame('file', null), false)
  assert.equal(canPersistGeneratedFrame('file', 'services'), true)
  assert.equal(canPersistGeneratedFrame('system', null), true)
  assert.equal(canPersistGeneratedFrame('infra', null), true)
})

test('persisted siblings are registered before incoming nodes regardless of snapshot order', () => {
  const ordered = orderFramePlacementCandidates([
    { id: 'incoming-models', parentId: null, placementPriority: 2 },
    { id: 'persisted-services', parentId: null, placementPriority: 0 },
    { id: 'authored-root', parentId: null, placementPriority: 1 },
    { id: 'incoming-storage', parentId: null, placementPriority: 2 },
  ])

  assert.deepEqual(ordered.map(item => item.id), [
    'persisted-services',
    'authored-root',
    'incoming-models',
    'incoming-storage',
  ])
})

test('placement ordering remains local to each parent frame', () => {
  const ordered = orderFramePlacementCandidates([
    { id: 'new-service-file', parentId: 'services', placementPriority: 2 },
    { id: 'saved-model-file', parentId: 'models', placementPriority: 0 },
    { id: 'saved-service-file', parentId: 'services', placementPriority: 0 },
  ])

  assert.deepEqual(ordered.map(item => item.id), [
    'saved-model-file',
    'saved-service-file',
    'new-service-file',
  ])
})

test('a persisted frame only grows enough to contain a late child', () => {
  const frame = { x: 10, y: 20, width: 620, height: 420, scale: 1 }
  const result = growFrameToContainChildren(frame, [
    { x: 32, y: 90, width: 220, height: 110, scale: 1 },
    { x: 288, y: 90, width: 220, height: 110, scale: 1 },
    { x: 544, y: 90, width: 220, height: 110, scale: 1 },
  ], 32)

  assert.deepEqual(result, {
    x: 10,
    y: 20,
    width: 796,
    height: 420,
    scale: 1,
  })
})

test('existing authored dimensions never shrink', () => {
  const frame = { x: 10, y: 20, width: 900, height: 700, scale: 1 }
  const result = growFrameToContainChildren(frame, [
    { x: 32, y: 90, width: 220, height: 110, scale: 1 },
  ], 32)

  assert.deepEqual(result, frame)
})
