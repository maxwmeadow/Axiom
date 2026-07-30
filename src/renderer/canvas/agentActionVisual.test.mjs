import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actionOwnsAnimation,
  agentAttentionFor,
  animationOwner,
  expireAttention,
  mergeAttention,
} from './agentActionVisual.ts'

function action(overrides = {}) {
  return {
    id: 1, workspaceId: 'ws', ts: 0, tool: 'get_node', kind: 'read',
    summary: 'looked at a node', targets: ['f1'], durationMs: 3, status: 'ok',
    ...overrides,
  }
}

// The whole point of this module: the watcher/semantic stream and the agent
// action stream both describe the same events, and only one may animate.

test('only reads animate from the action stream', () => {
  assert.equal(actionOwnsAnimation('read'), true)
  for (const kind of ['trace', 'write', 'plan', 'debug', 'narrate']) {
    assert.equal(actionOwnsAnimation(kind), false, `${kind} must defer to the semantic stream`)
  }
})

test('every non-animating kind names the stream that already covers it', () => {
  assert.match(animationOwner('trace'), /call:trace/)
  assert.match(animationOwner('write'), /graph:patch/)
  assert.match(animationOwner('plan'), /planned/)
  assert.match(animationOwner('debug'), /runtime/)
  assert.match(animationOwner('narrate'), /work:session/)
  assert.equal(animationOwner('read'), 'agent:action')
})

test('an agent editing systems does not double-animate with its own patch', () => {
  assert.equal(agentAttentionFor(action({ kind: 'write', tool: 'edit_systems' }), 1), null)
})

test('a traced call path does not double-animate with call:trace', () => {
  assert.equal(agentAttentionFor(action({ kind: 'trace', tool: 'get_call_path' }), 1), null)
})

test('a read produces the attention signal nothing else can show', () => {
  const signal = agentAttentionFor(action({ targets: ['f1', 'f2'] }), 7)
  assert.deepEqual(signal.targets, ['f1', 'f2'])
  assert.equal(signal.key, 7)
})

test('a failed action never lights anything up', () => {
  assert.equal(agentAttentionFor(action({ status: 'error' }), 1), null)
})

test('an action with no targets has nothing to show', () => {
  assert.equal(agentAttentionFor(action({ targets: [] }), 1), null)
})

test('repeated reads of one node deepen a single signal, never stack', () => {
  let state = {}
  state = mergeAttention(state, agentAttentionFor(action({ targets: ['f1'] }), 1))
  state = mergeAttention(state, agentAttentionFor(action({ targets: ['f1'] }), 2))
  assert.equal(Object.keys(state).length, 1)
  assert.equal(state.f1.key, 2, 'the newest signal wins the node')
})

test('expiry never clears a node a newer signal has claimed', () => {
  let state = {}
  state = mergeAttention(state, agentAttentionFor(action({ targets: ['f1', 'f2'] }), 1))
  state = mergeAttention(state, agentAttentionFor(action({ targets: ['f1'] }), 2))
  // Signal 1 times out while signal 2 still owns f1.
  state = expireAttention(state, 1)
  assert.equal(state.f1.key, 2, 'f1 stays lit by the newer read')
  assert.equal(state.f2, undefined, 'f2 was only in the expired signal')
})

test('expiring an unknown key leaves the set identity intact', () => {
  const state = mergeAttention({}, agentAttentionFor(action(), 1))
  assert.equal(expireAttention(state, 99), state, 'no churn for downstream memoization')
})
