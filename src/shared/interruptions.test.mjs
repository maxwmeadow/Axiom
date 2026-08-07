import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isDismissible,
  isExpired,
  laneState,
  nextExpiry,
  rankInterruptions,
} from './interruptions.ts'

const at = (id, kind, createdAt, extra = {}) => ({
  id, kind, title: id, createdAt, ...extra,
})

test('a blocking decision outranks everything raised before it', () => {
  const ranked = rankInterruptions([
    at('notice', 'notice', 1),
    at('invite', 'invitation', 2),
    at('broke', 'failure', 3),
    at('answer-me', 'decision', 400),
  ], 0)

  assert.deepEqual(ranked.map(i => i.id), ['answer-me', 'broke', 'invite', 'notice'])
})

test('within one kind the oldest is shown first so a backlog drains in order', () => {
  const ranked = rankInterruptions([
    at('third', 'failure', 30),
    at('first', 'failure', 10),
    at('second', 'failure', 20),
  ], 0)

  assert.deepEqual(ranked.map(i => i.id), ['first', 'second', 'third'])
})

test('identical timestamps still order stably instead of flickering', () => {
  const items = [at('b', 'failure', 5), at('a', 'failure', 5)]
  assert.deepEqual(rankInterruptions(items, 0).map(i => i.id), ['a', 'b'])
  assert.deepEqual(rankInterruptions(items.slice().reverse(), 0).map(i => i.id), ['a', 'b'])
})

test('the lane shows exactly one item and counts the rest honestly', () => {
  const state = laneState([
    at('a', 'failure', 1),
    at('b', 'invitation', 2),
    at('c', 'notice', 3),
  ], 0)

  assert.equal(state.current?.id, 'a')
  assert.equal(state.waiting, 2)
})

test('an empty queue leaves the lane with nothing to render', () => {
  assert.deepEqual(laneState([], 0), { current: null, waiting: 0 })
})

test('expired notices leave the queue without being dismissed', () => {
  const items = [
    at('gone', 'notice', 1, { expiresAt: 100 }),
    at('stays', 'invitation', 2),
  ]

  assert.equal(isExpired(items[0], 100), true)
  assert.equal(isExpired(items[0], 99), false)
  assert.equal(laneState(items, 150).current?.id, 'stays')
  assert.equal(laneState(items, 150).waiting, 0)
})

test('an entry with no expiry outlives any clock', () => {
  assert.equal(isExpired(at('forever', 'failure', 1), Number.MAX_SAFE_INTEGER), false)
})

test('a decision can never be dismissed, whatever the caller asked for', () => {
  assert.equal(isDismissible(at('d', 'decision', 1, { dismissible: true })), false)
  assert.equal(isDismissible(at('f', 'failure', 1)), true)
  assert.equal(isDismissible(at('f', 'failure', 1, { dismissible: false })), false)
})

test('the lane wakes only for the soonest expiry, and not at all without one', () => {
  assert.equal(nextExpiry([
    at('late', 'notice', 1, { expiresAt: 900 }),
    at('soon', 'notice', 1, { expiresAt: 300 }),
    at('never', 'failure', 1),
  ], 0), 300)

  assert.equal(nextExpiry([at('never', 'failure', 1)], 0), null)
  // Already-expired entries are removed on the next read, not scheduled for.
  assert.equal(nextExpiry([at('past', 'notice', 1, { expiresAt: 50 })], 100), null)
})
