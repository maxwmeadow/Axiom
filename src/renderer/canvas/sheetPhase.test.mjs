import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IDLE_PHASE,
  clearedPhase,
  nextSheetPhase,
  settledPhase,
} from './sheetPhase.ts'

test('arriving at a sheet begins by entering', () => {
  const next = nextSheetPhase(IDLE_PHASE, 'sheet-1')
  assert.deepEqual(next, { phase: 'entering', sheetId: 'sheet-1' })
})

test('leaving KEEPS the sheet id so its chrome is still there to animate', () => {
  // This is the whole point. Dropping the id at the same moment as the phase
  // is what made the exit snap: there was nothing left on screen to fade.
  const active = { phase: 'active', sheetId: 'sheet-1' }
  assert.deepEqual(nextSheetPhase(active, null), { phase: 'leaving', sheetId: 'sheet-1' })
})

test('the exit is symmetric with the entry, not instant', () => {
  let state = nextSheetPhase(IDLE_PHASE, 'sheet-1')
  assert.equal(state.phase, 'entering')
  state = settledPhase(state)
  assert.equal(state.phase, 'active')
  state = nextSheetPhase(state, null)
  assert.equal(state.phase, 'leaving', 'exit has a phase of its own')
  state = clearedPhase(state)
  assert.deepEqual(state, IDLE_PHASE)
})

test('switching between two sheets re-enters instead of leaving', () => {
  // The board never goes away, so fading out and back in would read as a
  // flicker rather than as a change of sheet.
  const active = { phase: 'active', sheetId: 'sheet-1' }
  const next = nextSheetPhase(active, 'sheet-2')
  assert.deepEqual(next, { phase: 'entering', sheetId: 'sheet-2' })
})

test('staying on the same sheet is stable, so nothing re-animates', () => {
  const active = { phase: 'active', sheetId: 'sheet-1' }
  assert.equal(nextSheetPhase(active, 'sheet-1'), active, 'identity preserved')

  const entering = { phase: 'entering', sheetId: 'sheet-1' }
  assert.equal(nextSheetPhase(entering, 'sheet-1'), entering)
})

test('leaving twice does not restart the exit', () => {
  const leaving = { phase: 'leaving', sheetId: 'sheet-1' }
  assert.equal(nextSheetPhase(leaving, null), leaving)
})

test('re-opening a sheet mid-exit cancels the departure', () => {
  const leaving = { phase: 'leaving', sheetId: 'sheet-1' }
  const next = nextSheetPhase(leaving, 'sheet-1')
  assert.deepEqual(next, { phase: 'entering', sheetId: 'sheet-1' })
})

test('idle stays idle', () => {
  assert.equal(nextSheetPhase(IDLE_PHASE, null), IDLE_PHASE)
})

test('settling and clearing only act on their own phase', () => {
  const active = { phase: 'active', sheetId: 'sheet-1' }
  assert.equal(settledPhase(active), active)
  assert.equal(clearedPhase(active), active)
  assert.equal(clearedPhase(IDLE_PHASE), IDLE_PHASE)
})
