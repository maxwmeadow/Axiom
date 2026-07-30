import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAgentAttention, surfaceAgentAttention } from './agentAttentionProjection.ts'

function signal(targets, key, summary = 'read something') {
  return { targets, key, summary, tool: 'get_node' }
}

test('attention is a projection that leaves untouched nodes identical', () => {
  const nodes = [{ id: 'f1', data: { label: 'a' } }, { id: 'f2', data: {} }]
  const out = applyAgentAttention(nodes, { f1: signal(['f1'], 1) })

  assert.equal(out[0].data.agentReading, true)
  assert.equal(out[0].data.label, 'a', 'existing node data survives')
  assert.equal(out[1], nodes[1], 'unrelated nodes keep identity')
})

test('no attention means no work and no churn', () => {
  const nodes = [{ id: 'f1', data: {} }]
  assert.equal(applyAgentAttention(nodes, {}), nodes)
})

test('reading a hidden file lights the system containing it', () => {
  // A sweep across a zoomed-out codebase must not look like nothing happening.
  const nodes = [
    { id: 'sys', position: { x: 0, y: 0 }, data: {}, style: { opacity: 1 } },
    { id: 'f1', parentId: 'sys', position: { x: 0, y: 0 }, data: {}, style: { opacity: 0 } },
  ]
  const surfaced = surfaceAgentAttention(nodes, { f1: signal(['f1'], 1) })
  assert.ok(surfaced.sys, 'the visible ancestor carries the signal')
  assert.equal(surfaced.f1, undefined, 'the hidden node does not')
})

test('a visible node keeps its own attention', () => {
  const nodes = [{ id: 'f1', position: { x: 0, y: 0 }, data: {}, style: { opacity: 1 } }]
  const surfaced = surfaceAgentAttention(nodes, { f1: signal(['f1'], 1) })
  assert.equal(surfaced.f1.key, 1)
})

test('many hidden files under one container read as one glow', () => {
  const nodes = [
    { id: 'sys', position: { x: 0, y: 0 }, data: {}, style: { opacity: 1 } },
    { id: 'f1', parentId: 'sys', position: { x: 0, y: 0 }, data: {}, style: { opacity: 0 } },
    { id: 'f2', parentId: 'sys', position: { x: 0, y: 0 }, data: {}, style: { opacity: 0 } },
  ]
  const surfaced = surfaceAgentAttention(nodes, {
    f1: signal(['f1'], 1),
    f2: signal(['f2'], 5),
  })
  assert.equal(Object.keys(surfaced).length, 1, 'one container, one signal')
  assert.equal(surfaced.sys.key, 5, 'the newest read wins the shared ancestor')
})

test('surfacing nothing returns the same object', () => {
  const attention = {}
  assert.equal(surfaceAgentAttention([], attention), attention)
})
