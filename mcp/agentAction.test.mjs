import assert from 'node:assert/strict'
import test from 'node:test'
import { actionKind, actionSummary, actionTargets } from './agentAction.ts'

test('reads are the default so a new tool is still captured', () => {
  assert.equal(actionKind('some_tool_added_next_month'), 'read')
  assert.equal(actionKind('get_architecture'), 'read')
})

test('kinds separate the things the canvas animates differently', () => {
  assert.equal(actionKind('get_call_path'), 'trace')
  assert.equal(actionKind('get_data_flow'), 'trace')
  assert.equal(actionKind('edit_systems'), 'write')
  assert.equal(actionKind('merge_systems'), 'write')
  assert.equal(actionKind('plan_element'), 'plan')
  assert.equal(actionKind('inject_value'), 'debug')
  assert.equal(actionKind('start_work'), 'narrate')
})

test('targets come from whichever id-bearing argument the tool used', () => {
  assert.deepEqual(actionTargets('get_node', { nodeId: 'n1' }), ['n1'])
  assert.deepEqual(
    actionTargets('assign_files_to_system', { fileIds: ['f1', 'f2'], systemId: 's1' }),
    ['f1', 'f2', 's1'],
  )
})

test('the consolidated id/ids vocabulary is recognised', () => {
  // get_architecture takes a generic `id`. Missing it meant every read through
  // the new surface recorded no targets, so the canvas lit nothing at all.
  assert.deepEqual(actionTargets('get_architecture', { scope: 'node', id: 'n1' }), ['n1'])
  assert.deepEqual(
    actionTargets('get_architecture', { scope: 'systems', ids: ['s1', 's2'] }),
    ['s1', 's2'],
  )
})

test('a traced path targets every hop, not just the endpoints', () => {
  const targets = actionTargets(
    'get_call_path',
    { from: 'a', to: 'c' },
    { steps: [
      { callerFile: 'a', calleeFile: 'b' },
      { callerFile: 'b', calleeFile: 'c' },
    ] },
  )
  assert.deepEqual(targets, ['a', 'c', 'b'], 'the middle of the path is the interesting part')
})

test('a data-flow slice targets every file it touched', () => {
  const targets = actionTargets('get_data_flow', { variable: 'token' }, { fileIds: ['f1', 'f2'] })
  assert.deepEqual(targets, ['f1', 'f2'])
})

test('targets are deduplicated so one node is lit once', () => {
  const targets = actionTargets('get_call_path', { from: 'a', to: 'a' }, {
    steps: [{ callerFile: 'a', calleeFile: 'a' }],
  })
  assert.deepEqual(targets, ['a'])
})

test('an action with nothing to point at yields no targets', () => {
  assert.deepEqual(actionTargets('get_systems_overview', {}), [])
})

test('summaries read like a sentence, not a tool name', () => {
  assert.equal(
    actionSummary('get_call_path', { from: 'handlers.py', to: 'store.py' }),
    'Traced handlers.py → store.py',
  )
  assert.equal(actionSummary('create_system', { name: 'Storage' }), 'Created system Storage')
  assert.equal(actionSummary('start_work', { goal: 'Add caching' }), 'Started work: Add caching')
  assert.equal(actionSummary('search_symbols', { query: 'TaskStore' }), 'Searched symbols for "TaskStore"')
})

test('an unmapped tool degrades to a readable name rather than nothing', () => {
  assert.equal(actionSummary('get_systems_overview', {}), 'get systems overview')
})

test('every advertised tool is classified as the thing it actually does', () => {
  // The log records the name the agent called, not the legacy name it routes
  // to, so the consolidated surface has to appear in these sets. trace_calls
  // did not, and was filed as a read.
  assert.equal(actionKind('trace_calls'), 'trace')
  assert.equal(actionKind('get_data_flow'), 'trace')
  assert.equal(actionKind('edit_systems'), 'write')
  assert.equal(actionKind('investigation'), 'debug')
  assert.equal(actionKind('update_work'), 'narrate')
  assert.equal(actionKind('get_architecture'), 'read')
})
