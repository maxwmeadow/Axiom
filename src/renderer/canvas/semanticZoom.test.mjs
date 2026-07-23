import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REVEAL_CONTAINER_PX,
  applyZoomVisibility,
  makeFullyVisible,
} from './semanticZoom.ts'

const node = (id, width, height, options = {}) => ({
  id,
  position: { x: 0, y: 0 },
  style: { width, height },
  data: { depth: options.depth ?? 0 },
  ...(options.parentId ? { parentId: options.parentId } : {}),
})

test('contents reveal at the rendered geometric-mean threshold', () => {
  const subject = node('root', 120, 480)
  const below = applyZoomVisibility([subject], REVEAL_CONTAINER_PX / 240 - 0.001)[0]
  const atThreshold = applyZoomVisibility([subject], REVEAL_CONTAINER_PX / 240)[0]

  assert.equal(below.data.childrenVisible, 0)
  assert.equal(atThreshold.data.childrenVisible, 1)
})

test('a child cannot become visible before its parent reveals children', () => {
  const parent = node('parent', 100, 100, { depth: 0 })
  const child = node('child', 10_000, 10_000, { depth: 1, parentId: 'parent' })
  const result = applyZoomVisibility([child, parent], 1)

  assert.equal(result[0].style.opacity, 0)
  assert.equal(result[0].style.pointerEvents, 'none')
  assert.equal(result[0].data.childrenVisible, 0)
})

test('visibility is computed parent-first without changing render order', () => {
  const child = node('child', 20, 20, { depth: 1, parentId: 'parent' })
  const parent = node('parent', REVEAL_CONTAINER_PX, REVEAL_CONTAINER_PX)
  const result = applyZoomVisibility([child, parent], 1)

  assert.deepEqual(result.map(item => item.id), ['child', 'parent'])
  assert.equal(result[0].style.opacity, 1)
})

test('makeFullyVisible overrides temporary semantic-zoom hiding', () => {
  const hidden = applyZoomVisibility([
    node('child', 20, 20, { depth: 1, parentId: 'missing' }),
  ], 1)[0]
  const visible = makeFullyVisible(hidden)

  assert.equal(visible.style.opacity, 1)
  assert.equal(visible.style.pointerEvents, 'all')
  assert.equal(visible.data.selfScale, 1)
  assert.equal(visible.data.selfBlur, 0)
  assert.equal(visible.data.childrenVisible, 1)
})
