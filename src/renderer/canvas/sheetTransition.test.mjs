import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySheetTransition,
  planSheetTransition,
  supersedeTransition,
  SHEET_MOVE_MS,
} from './sheetTransition.ts'

const plan = (overrides = {}) => planSheetTransition({
  direction: 'enter', movedIds: [], sheetOnlyIds: [], removedIds: [], ...overrides,
})

test('a node that exists in both worlds glides and is never faded', () => {
  const result = plan({ movedIds: ['live1'], sheetOnlyIds: ['planned1', 'live1'] })
  assert.deepEqual(result.movingIds, ['live1'])
  assert.deepEqual(result.appearingIds, ['planned1'], 'a moving node is never also faded')
})

test('entering: additions arrive, removals depart', () => {
  const result = plan({ sheetOnlyIds: ['planned1'], removedIds: ['live1'] })
  assert.deepEqual(result.appearingIds, ['planned1'])
  assert.deepEqual(result.departingIds, ['live1'])
})

test('leaving inverts it: the Floor takes its removed nodes back', () => {
  // A removal is an addition seen from the other side.
  const result = plan({
    direction: 'leave', sheetOnlyIds: ['planned1'], removedIds: ['live1'],
  })
  assert.deepEqual(result.appearingIds, ['live1'])
  assert.deepEqual(result.departingIds, ['planned1'])
})

test('a transition with nothing to show costs nothing', () => {
  const empty = plan()
  assert.equal(empty.durationMs, 0)
  const nodes = [{ id: 'a', style: {} }]
  assert.equal(applySheetTransition(nodes, empty, 0.5), nodes)
})

test('a null plan is a no-op', () => {
  const nodes = [{ id: 'a', style: {} }]
  assert.equal(applySheetTransition(nodes, null, 0.5), nodes)
})

test('opacity runs the right way for each role', () => {
  const nodes = [{ id: 'planned1', style: {} }, { id: 'live1', style: {} }]
  const entering = plan({ sheetOnlyIds: ['planned1'], removedIds: ['live1'] })

  const atStart = applySheetTransition(nodes, entering, 0)
  assert.equal(atStart[0].style.opacity, 0, 'the addition is not there yet')
  assert.equal(atStart[1].style.opacity, 1, 'the removed node is still there')

  const atEnd = applySheetTransition(nodes, entering, 1)
  assert.equal(atEnd[0].style.opacity, 1)
  assert.equal(atEnd[1].style.opacity, 0)
})

test('a half-faded node does not swallow clicks meant for the map', () => {
  const nodes = [{ id: 'planned1', style: {} }]
  const entering = plan({ sheetOnlyIds: ['planned1'] })
  assert.equal(applySheetTransition(nodes, entering, 0.2)[0].style.pointerEvents, 'none')
  assert.equal(applySheetTransition(nodes, entering, 0.9)[0].style.pointerEvents, undefined)
})

test('arrivals wait for the rearrangement; departures do not', () => {
  const nodes = [{ id: 'in', style: {} }, { id: 'out', style: {} }]
  const result = plan({ sheetOnlyIds: ['in'], removedIds: ['out'] })
  const out = applySheetTransition(nodes, result, 0.5)

  assert.match(out[0].style.transition, /ease-out 160ms/, 'arrival is delayed')
  assert.match(out[1].style.transition, /ease-out 0ms/, 'departure is immediate')
})

test('moving nodes get easing but never an opacity', () => {
  const nodes = [{ id: 'live1', style: {} }]
  const out = applySheetTransition(nodes, plan({ movedIds: ['live1'] }), 0.5)[0]

  assert.match(out.style.transition, new RegExp(`transform ${SHEET_MOVE_MS}ms`))
  assert.equal(out.style.opacity, undefined, 'a node that exists in both worlds never fades')
  assert.equal(out.data.sheetMoving, true)
})

test('progress is clamped so an overshooting animation cannot invert', () => {
  const nodes = [{ id: 'planned1', style: {} }]
  const entering = plan({ sheetOnlyIds: ['planned1'] })
  assert.equal(applySheetTransition(nodes, entering, -3)[0].style.opacity, 0)
  assert.equal(applySheetTransition(nodes, entering, 4)[0].style.opacity, 1)
})

test('switching sheets mid-flight takes out what the old sheet was bringing in', () => {
  // Otherwise the previous sheet's content is stranded half-visible forever.
  const previous = plan({ sheetOnlyIds: ['oldPlanned'] })
  const next = plan({ sheetOnlyIds: ['newPlanned'] })
  const merged = supersedeTransition(previous, next)

  assert.ok(merged.appearingIds.includes('newPlanned'))
  assert.ok(merged.departingIds.includes('oldPlanned'), 'stranded content is taken out')
})

test('superseding never re-fades something the new plan already accounts for', () => {
  const previous = plan({ sheetOnlyIds: ['shared'] })
  const next = plan({ movedIds: ['shared'] })
  const merged = supersedeTransition(previous, next)
  assert.deepEqual(merged.departingIds, [], 'a node now moving must not also fade')
})

test('the first transition needs no merge', () => {
  const next = plan({ movedIds: ['a'] })
  assert.equal(supersedeTransition(null, next), next)
})
