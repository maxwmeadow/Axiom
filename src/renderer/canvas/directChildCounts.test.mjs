import assert from 'node:assert/strict'
import test from 'node:test'
import { countDirectChildren } from './directChildCounts.ts'

test('counts seven file descriptors once instead of through overlapping categories', () => {
  const descriptors = Array.from({ length: 7 }, () => ({ parentId: 'tests' }))
  assert.equal(countDirectChildren(descriptors).get('tests'), 7)
})

test('counts mixed direct child types once and excludes roots and descendants', () => {
  const counts = countDirectChildren([
    { parentId: null },
    { parentId: 'system' }, // file
    { parentId: 'system' }, // child system
    { parentId: 'system' }, // infrastructure
    { parentId: 'nested' }, // descendant, not a direct child of system
  ])
  assert.equal(counts.get('system'), 3)
  assert.equal(counts.get('nested'), 1)
  assert.equal(counts.has(''), false)
})
