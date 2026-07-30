import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectFloorScene,
  partitionCanvasNodeChanges,
} from './sceneIntegrity.ts'

const node = (id, parentId, overrides = {}) => ({
  id,
  type: parentId ? 'file' : 'system',
  parentId,
  position: { x: 20, y: 30 },
  style: { width: 220, height: 110, opacity: 1 },
  initialWidth: 220,
  initialHeight: 110,
  data: {},
  ...overrides,
})

test('rejects structural view changes while preserving interaction changes', () => {
  const changes = [
    { type: 'dimensions', id: 'root', dimensions: { width: 620, height: 420 } },
    { type: 'remove', id: 'root' },
    { type: 'select', id: 'file', selected: true },
    { type: 'replace', id: 'file', item: node('file', 'root') },
    { type: 'add', item: node('other', null) },
  ]

  const result = partitionCanvasNodeChanges(changes)
  assert.deepEqual(result.interaction.map(change => change.type), ['dimensions', 'select'])
  assert.deepEqual(
    result.rejectedStructural.map(change => change.type),
    ['remove', 'replace', 'add'],
  )
})

test('rejects an empty scene when canonical graph data is populated', () => {
  assert.deepEqual(inspectFloorScene([], 17), {
    valid: false,
    reason: 'empty',
    nodeCount: 0,
    rootCount: 0,
    visibleRootCount: 0,
    invalidNodeIds: [],
  })
})

test('accepts semantic-zoom-hidden descendants when a visible root remains', () => {
  const result = inspectFloorScene([
    node('root', null),
    node('file', 'root', {
      style: { width: 220, height: 110, opacity: 0, pointerEvents: 'none' },
    }),
  ], 2)

  assert.equal(result.valid, true)
  assert.equal(result.rootCount, 1)
  assert.equal(result.visibleRootCount, 1)
})

test('rejects a stale scene whose ids do not match the canonical graph', () => {
  const result = inspectFloorScene(
    [node('old-root', null)],
    1,
    new Set(['new-root']),
  )
  assert.equal(result.reason, 'canonical-mismatch')
})

test('rejects rootless, invisible-root, and non-finite projections', () => {
  assert.equal(
    inspectFloorScene([
      node('a', 'b'),
      node('b', 'a'),
    ], 2).reason,
    'no-root',
  )
  assert.equal(
    inspectFloorScene([
      node('root', null, { style: { width: 620, height: 420, opacity: 0 } }),
    ], 1).reason,
    'no-visible-root',
  )
  const invalid = inspectFloorScene([
    node('root', null),
    node('file', 'root', { position: { x: Number.NaN, y: 30 } }),
  ], 2)
  assert.equal(invalid.reason, 'invalid-geometry')
  assert.deepEqual(invalid.invalidNodeIds, ['file'])
})
