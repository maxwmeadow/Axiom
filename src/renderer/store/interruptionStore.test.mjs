import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  raiseFailure,
  raiseNotice,
  resolveInterruption,
  useInterruptionStore,
} from './interruptionStore.ts'

const ids = () => useInterruptionStore.getState().items.map(item => item.id)

const raiseExpiring = (id, ttlMs) => {
  const now = Date.now()
  useInterruptionStore.getState().raise({
    id, kind: 'notice', title: id, createdAt: now, expiresAt: now + ttlMs,
  })
}

beforeEach(() => {
  useInterruptionStore.getState().clear()
})

// The bug this exists for: the lane used to schedule ONE timer at the soonest
// expiry and re-read on fire. Firing did not change `items`, so the effect
// never re-armed and only the first of several notices ever disappeared.
test('every expiring notice retires, not just the first', async () => {
  raiseExpiring('first', 20)
  raiseExpiring('second', 60)
  assert.deepEqual(ids().sort(), ['first', 'second'])

  await sleep(40)
  assert.deepEqual(ids(), ['second'], 'first should be gone, second still waiting')

  await sleep(60)
  assert.deepEqual(ids(), [], 'second must retire on its own too')
})

test('a failure has no expiry and outlives any number of notices', async () => {
  raiseFailure('broke', 'Something broke')
  raiseExpiring('note', 20)

  await sleep(50)
  assert.deepEqual(ids(), ['broke'])
})

test('re-raising an id replaces it instead of stacking duplicates', () => {
  raiseFailure('same', 'First wording')
  raiseFailure('same', 'Second wording')

  const items = useInterruptionStore.getState().items
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Second wording')
})

test('re-raising cancels the old timer so a refreshed entry is not cut short', async () => {
  raiseExpiring('refreshed', 20)
  raiseExpiring('refreshed', 120)

  await sleep(60)
  assert.deepEqual(ids(), ['refreshed'], 'the superseded 20ms timer must not fire')
})

test('resolving before expiry leaves no timer to fire later', async () => {
  raiseExpiring('withdrawn', 30)
  resolveInterruption('withdrawn')
  assert.deepEqual(ids(), [])

  raiseFailure('withdrawn', 'Reused id, different meaning')
  await sleep(50)
  assert.deepEqual(ids(), ['withdrawn'], 'a stale timer must not remove the new entry')
})

test('clearing a project cancels pending expiries', async () => {
  raiseExpiring('a', 30)
  raiseNotice('b', 'Copied')
  useInterruptionStore.getState().clear()

  raiseFailure('a', 'New project, same id')
  await sleep(60)
  assert.deepEqual(ids(), ['a'])
})
