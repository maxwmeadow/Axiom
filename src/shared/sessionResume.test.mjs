import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeDecision } from './sessionResume.ts'

const ready = (...ids) => new Set(ids)

test('quitting inside a finished project reopens it', () => {
  assert.deepEqual(
    resumeDecision({
      resumeProjectId: 'axiom',
      recentIds: ['axiom', 'other'],
      readyIds: ready('axiom', 'other'),
    }),
    { kind: 'resume', projectId: 'axiom' },
  )
})

test('deliberately backing out to the launcher is respected next launch', () => {
  assert.deepEqual(
    resumeDecision({
      resumeProjectId: null,
      recentIds: ['axiom'],
      readyIds: ready('axiom'),
    }),
    { kind: 'home' },
  )
})

test('a project removed while we were closed cannot be resumed', () => {
  assert.deepEqual(
    resumeDecision({
      resumeProjectId: 'deleted',
      recentIds: ['axiom'],
      readyIds: ready('axiom', 'deleted'),
    }),
    { kind: 'home' },
  )
})

test('a half-configured project still owes the user the setup path', () => {
  assert.deepEqual(
    resumeDecision({
      resumeProjectId: 'unfinished',
      recentIds: ['unfinished'],
      readyIds: ready(),
    }),
    { kind: 'home' },
  )
})

test('a first launch with no history lands on the launcher', () => {
  assert.deepEqual(
    resumeDecision({ resumeProjectId: null, recentIds: [], readyIds: ready() }),
    { kind: 'home' },
  )
})

test('resuming never picks a different project than the one recorded', () => {
  // Guards against drifting into "open the most recent", which would drag the
  // user back into a project they deliberately left.
  const decision = resumeDecision({
    resumeProjectId: 'older',
    recentIds: ['newest', 'older'],
    readyIds: ready('newest', 'older'),
  })
  assert.deepEqual(decision, { kind: 'resume', projectId: 'older' })
})
