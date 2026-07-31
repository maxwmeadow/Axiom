import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySheetTransition,
  planSheetTransition,
  supersedeTransition,
  SHEET_MOVE_MS,
} from './sheetTransition.ts'

test('moving and fading are different signals and never overlap', () => {
  // A node that exists in both worlds must glide, not fade — fading would say
  // it is being created or destroyed, which is untrue.
  const plan = planSheetTransition({
    direction: 'enter',
    movedIds: ['live1', 'live2'],
    sheetOnlyIds: ['planned1', 'live1'],
  })
  assert.deepEqual(plan.movingIds, ['live1', 'live2'])
  assert.deepEqual(plan.fadingIds, ['planned1'], 'a moving node is never also faded')
})

test('a transition with nothing to show costs nothing', () => {
  const plan = planSheetTransition({ direction: 'enter', movedIds: [], sheetOnlyIds: [] })
  assert.equal(plan.durationMs, 0)

  const nodes = [{ id: 'a', style: {} }]
  assert.equal(applySheetTransition(nodes, plan, 0.5), nodes)
})

test('a null plan is a no-op', () => {
  const nodes = [{ id: 'a', style: {} }]
  assert.equal(applySheetTransition(nodes, null, 0.5), nodes)
})

test('entering fades additions in, leaving fades them out', () => {
  const nodes = [{ id: 'planned1', style: {} }]
  const entering = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['planned1'],
  })
  const leaving = planSheetTransition({
    direction: 'leave', movedIds: [], sheetOnlyIds: ['planned1'],
  })

  assert.equal(applySheetTransition(nodes, entering, 0)[0].style.opacity, 0)
  assert.equal(applySheetTransition(nodes, entering, 1)[0].style.opacity, 1)
  assert.equal(applySheetTransition(nodes, leaving, 0)[0].style.opacity, 1)
  assert.equal(applySheetTransition(nodes, leaving, 1)[0].style.opacity, 0)
})

test('a half-faded addition does not swallow clicks meant for the map', () => {
  const nodes = [{ id: 'planned1', style: {} }]
  const plan = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['planned1'],
  })
  assert.equal(applySheetTransition(nodes, plan, 0.2)[0].style.pointerEvents, 'none')
  assert.equal(applySheetTransition(nodes, plan, 0.9)[0].style.pointerEvents, undefined)
})

test('moving nodes get easing but never an opacity', () => {
  const nodes = [{ id: 'live1', style: {} }]
  const plan = planSheetTransition({
    direction: 'enter', movedIds: ['live1'], sheetOnlyIds: [],
  })
  const out = applySheetTransition(nodes, plan, 0.5)[0]

  assert.match(out.style.transition, new RegExp(`transform ${SHEET_MOVE_MS}ms`))
  assert.equal(out.style.opacity, undefined, 'a node that exists in both worlds never fades')
  assert.equal(out.data.sheetMoving, true)
})

test('progress is clamped so an overshooting animation cannot invert', () => {
  const nodes = [{ id: 'planned1', style: {} }]
  const plan = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['planned1'],
  })
  assert.equal(applySheetTransition(nodes, plan, -3)[0].style.opacity, 0)
  assert.equal(applySheetTransition(nodes, plan, 4)[0].style.opacity, 1)
})

test('switching sheets mid-flight still clears the previous additions', () => {
  // Otherwise the old sheet's content is stranded half-visible forever.
  const previous = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['oldPlanned'],
  })
  const next = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['newPlanned'],
  })
  const merged = supersedeTransition(previous, next)

  assert.ok(merged.fadingIds.includes('newPlanned'))
  assert.ok(merged.fadingIds.includes('oldPlanned'), 'stranded content is taken out')
})

test('superseding does not re-fade something the new plan is moving', () => {
  const previous = planSheetTransition({
    direction: 'enter', movedIds: [], sheetOnlyIds: ['shared'],
  })
  const next = planSheetTransition({
    direction: 'enter', movedIds: ['shared'], sheetOnlyIds: [],
  })
  const merged = supersedeTransition(previous, next)
  assert.deepEqual(merged.fadingIds, [], 'a node now moving must not also fade')
})

test('the first transition needs no merge', () => {
  const next = planSheetTransition({
    direction: 'enter', movedIds: ['a'], sheetOnlyIds: [],
  })
  assert.equal(supersedeTransition(null, next), next)
})
