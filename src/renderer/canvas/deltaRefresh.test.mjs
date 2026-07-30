import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeToDeltaRefresh } from './deltaRefresh.ts'

test('returning to the app refreshes the Morning Delta until unsubscribed', () => {
  const target = new EventTarget()
  let refreshes = 0
  const unsubscribe = subscribeToDeltaRefresh(target, () => {
    refreshes += 1
  })

  target.dispatchEvent(new Event('focus'))
  target.dispatchEvent(new Event('focus'))
  assert.equal(refreshes, 2)

  unsubscribe()
  target.dispatchEvent(new Event('focus'))
  assert.equal(refreshes, 2)
})
