import assert from 'node:assert/strict'
import test from 'node:test'
import { regionConsumesWheel, routeWheelEvent, wheelScrollStep } from './wheelRouting.ts'

const scrollable = (overrides = {}) => ({
  overflowY: 'auto',
  scrollTop: 50,
  scrollHeight: 400,
  clientHeight: 100,
  ...overrides,
})

test('a scrollable list consumes the wheel only while it has room', () => {
  // Mid-list: both directions are the list's to consume.
  assert.equal(regionConsumesWheel(scrollable(), -1), true)
  assert.equal(regionConsumesWheel(scrollable(), 1), true)

  // At the top, scrolling up belongs to the canvas; down still scrolls.
  assert.equal(regionConsumesWheel(scrollable({ scrollTop: 0 }), -1), false)
  assert.equal(regionConsumesWheel(scrollable({ scrollTop: 0 }), 1), true)

  // At the bottom, the reverse.
  assert.equal(regionConsumesWheel(scrollable({ scrollTop: 300 }), 1), false)
  assert.equal(regionConsumesWheel(scrollable({ scrollTop: 300 }), -1), true)
})

test('a list that cannot scroll never steals canvas zoom', () => {
  // The common case: a file with two functions. Zoom must keep working over it.
  const short = scrollable({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 })
  assert.equal(regionConsumesWheel(short, 1), false)
  assert.equal(regionConsumesWheel(short, -1), false)

  // Not a scroll container at all.
  assert.equal(regionConsumesWheel(scrollable({ overflowY: 'visible' }), 1), false)
  assert.equal(regionConsumesWheel(scrollable({ overflowY: 'hidden' }), 1), false)
})

test('the wheel walk routes to nowheel, scrollable content, or canvas zoom', () => {
  const root = { classList: { contains: () => false }, parentElement: null }
  const plain = parent => ({
    classList: { contains: () => false },
    parentElement: parent,
  })
  const inert = { overflowY: 'visible', scrollTop: 0, scrollHeight: 0, clientHeight: 0 }
  const metricsFor = new Map()
  const read = element => metricsFor.get(element) ?? inert

  // A title inside a node: nothing consumes it, so the canvas zooms.
  const title = plain(plain(root))
  assert.equal(routeWheelEvent(title, 1, root, read).kind, 'zoom')

  // A symbol row inside a scrollable list that still has room. The route must
  // name the list itself, since that is the element Axiom scrolls.
  const list = plain(root)
  metricsFor.set(list, scrollable())
  const row = plain(list)
  const scrollRoute = routeWheelEvent(row, 1, root, read)
  assert.equal(scrollRoute.kind, 'scroll')
  assert.equal(scrollRoute.element, list)

  // Same row, but the list is scrolled to the bottom: canvas zoom resumes.
  metricsFor.set(list, scrollable({ scrollTop: 300 }))
  assert.equal(routeWheelEvent(row, 1, root, read).kind, 'zoom')

  // An explicit opt-out still wins outright (inputs, selects).
  const optedOut = { classList: { contains: name => name === 'nowheel' }, parentElement: root }
  assert.equal(routeWheelEvent(optedOut, 1, root, read).kind, 'ignore')
})

test('the canvas root never swallows zoom as node content', () => {
  const root = { classList: { contains: () => false }, parentElement: null }
  const read = element => (element === root ? scrollable() : {
    overflowY: 'visible', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  })
  const child = { classList: { contains: () => false }, parentElement: root }
  assert.equal(routeWheelEvent(child, 1, root, read).kind, 'zoom')
})

test('one wheel notch moves a couple of rows, not most of the list', () => {
  // A Chromium notch reports ~100px while a symbol row is ~12px. Forwarding
  // the raw delta jumped the whole list per notch and hit the boundary
  // immediately, which then handed the rest of the gesture to canvas zoom.
  const shortList = 60
  assert.equal(wheelScrollStep(100, shortList), 24)
  assert.equal(wheelScrollStep(-100, shortList), -24)

  // A taller region is allowed a proportionally bigger step.
  assert.equal(wheelScrollStep(100, 400), 80)

  // Trackpads send small deltas; those pass through untouched so fine
  // scrolling stays smooth rather than being quantized up.
  assert.equal(wheelScrollStep(3, 400), 3)
  assert.equal(wheelScrollStep(-3, 400), -3)
  assert.equal(wheelScrollStep(0, 400), 0)
})
