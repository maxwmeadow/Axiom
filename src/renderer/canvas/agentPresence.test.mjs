import assert from 'node:assert/strict'
import test from 'node:test'
import { stampAgentPresence } from './agentPresence.ts'

function session(overrides = {}) {
  return {
    id: 'work-1', workspaceId: 'ws', agent: 'claude', goal: 'Refactor auth',
    notes: [], focusSystemIds: ['auth'], focusFileIds: ['token.ts'],
    startedAt: 1, endedAt: 0, ...overrides,
  }
}

test('stamps the same active agent onto each declared boundary', () => {
  const nodes = [
    { id: 'auth', data: { name: 'Auth' } },
    { id: 'token.ts', data: { label: 'token.ts' } },
    { id: 'other', data: { label: 'other.ts' } },
  ]
  const projected = stampAgentPresence(nodes, [session()])
  assert.deepEqual(projected[0].data.agentPresence, [{
    id: 'work-1', agent: 'claude', goal: 'Refactor auth',
  }])
  assert.deepEqual(projected[1].data.agentPresence, projected[0].data.agentPresence)
  assert.equal(projected[2], nodes[2])
})

test('keeps parallel agents visible on a shared boundary', () => {
  const projected = stampAgentPresence(
    [{ id: 'auth', data: {} }],
    [
      session(),
      session({ id: 'work-2', agent: 'gemini', goal: 'Audit tokens' }),
    ],
  )
  assert.deepEqual(projected[0].data.agentPresence.map(p => p.agent), ['claude', 'gemini'])
})

test('ignores finished sessions and preserves node identity when no scope is active', () => {
  const nodes = [{ id: 'auth', data: {} }]
  const projected = stampAgentPresence(nodes, [session({ endedAt: 10 })])
  assert.equal(projected, nodes)
})
