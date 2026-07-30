import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingStage } from './onboarding.ts'

const ready = {
  baselineReady: true,
  sheetReady: true,
  planned: true,
  dispatched: true,
  realized: true,
}

test('onboarding stops at the first unproven payoff milestone', () => {
  assert.equal(onboardingStage({ ...ready, baselineReady: false }), 'baseline')
  assert.equal(onboardingStage({ ...ready, sheetReady: false }), 'sheet')
  assert.equal(onboardingStage({ ...ready, planned: false }), 'draw')
  assert.equal(onboardingStage({ ...ready, dispatched: false }), 'dispatch')
  assert.equal(onboardingStage({ ...ready, realized: false }), 'build')
})

test('onboarding completes only after a dispatched plan is realized', () => {
  assert.equal(onboardingStage(ready), 'complete')
  assert.equal(onboardingStage({ ...ready, dispatched: false }), 'dispatch')
})
