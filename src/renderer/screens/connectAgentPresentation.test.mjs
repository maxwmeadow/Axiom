import assert from 'node:assert/strict'
import test from 'node:test'

import { commandKind, presentAgentHost } from './connectAgentPresentation.ts'

const host = overrides => ({
  id: 'codex',
  label: 'Codex',
  detected: true,
  configured: false,
  configuredPaths: [],
  unreadablePaths: [],
  workflowInstalled: false,
  workflowPath: null,
  configPath: 'config.toml',
  command: '$axiom-map',
  ...overrides,
})

test('agent host signal has one unambiguous state and action', () => {
  assert.deepEqual(presentAgentHost(host({ detected: false }), undefined, false), {
    state: 'missing',
    detail: 'Codex was not found on this machine. Install it before adding Axiom.',
    action: 'none',
  })
  assert.equal(presentAgentHost(host({}), undefined, false).state, 'available')
  assert.equal(presentAgentHost(host({ configured: true }), undefined, false).state, 'repair')
  assert.equal(presentAgentHost(host({ configured: true, workflowInstalled: true }), undefined, false).state, 'installed')
  assert.equal(presentAgentHost(host({ configured: true, workflowInstalled: true }), undefined, true).state, 'live')
})

test('a successful install immediately reads as installed while host inspection refreshes', () => {
  assert.equal(presentAgentHost(host({}), { ok: true, detail: 'done', paths: [] }, false).state, 'installed')
})

test('each harness invocation is described by its actual syntax', () => {
  assert.equal(commandKind('/axiom-map'), 'slash command')
  assert.equal(commandKind('$axiom-map'), 'skill command')
  assert.equal(commandKind('Use the axiom-map skill'), 'instruction')
})
