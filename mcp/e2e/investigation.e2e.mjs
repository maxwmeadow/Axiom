import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness } from './mcpHarness.mjs'

/**
 * Proves the debugging loop an agent actually drives.
 *
 * Every piece of this was individually present and collectively unreachable:
 * `investigation` was advertised only behind AXIOM_MCP_PROFILE=debug, which
 * nothing set, so no agent could see the tool at all. These tests assert the
 * whole path - that it is advertised, that a session records, that work done
 * in between is captured without being asked for, and that stopping yields a
 * document the canvas can replay.
 */

let harness
let client

test.before(async () => {
  harness = await startHarness()
  client = harness.client
}, { timeout: 90000 })

test.after(() => harness?.stop())

test('an agent can see the recorder without opting into a profile', async () => {
  const response = await client.request('tools/list', {})
  const names = response.result.tools.map(tool => tool.name)
  assert.ok(names.includes('investigation'), 'investigation must be advertised by default')
  assert.equal(names.includes('debug_runtime'), false, 'value injection stays opt-in')
})

test('noting before starting says what to do instead of failing blankly', async () => {
  const result = await client.callTool('investigation', { op: 'note', text: 'too early' })
  assert.equal(result.isError, true)
  assert.match(result.text, /start/i, `unhelpful error: ${result.text}`)
})

test('a session records the work done inside it and replays as a document', async () => {
  const started = await client.callTool('investigation', { op: 'start', name: 'Checkout timeout' })
  assert.equal(started.isError, false, started.text)
  const id = started.payload?.id
  assert.ok(id, `no capture id returned: ${started.text}`)

  // Work an agent would do anyway. None of this asks to be recorded.
  const files = harness.snapshot.files ?? []
  const caller = files.find(file => file.relPath.endsWith('index.py')) ?? files[0]
  const traced = await client.callTool('trace_calls', { fileIds: [caller.id], direction: 'out', depth: 2 })
  assert.equal(traced.isError, false, traced.text)

  const noted = await client.callTool('investigation', { op: 'note', text: 'settle() returns unrounded cents' })
  assert.equal(noted.isError, false, noted.text)

  const stopped = await client.callTool('investigation', { op: 'stop' })
  assert.equal(stopped.isError, false, stopped.text)
  assert.equal(stopped.payload?.id, id, 'stop should finalize the session that was started')
  assert.ok((stopped.payload?.eventCount ?? 0) > 0, 'the trace and note should have been captured')

  const listed = await client.callTool('investigation', { op: 'list' })
  assert.equal(listed.isError, false, listed.text)
  const saved = (listed.payload?.investigations ?? []).find(item => item.id === id)
  assert.ok(saved, `the capture is missing from the list: ${listed.text}`)
  assert.equal(saved.status, 'saved', 'a stopped capture is saved, not left recording')

  // The canvas replays this document event by event, so it has to come back
  // with its timeline intact rather than as a summary.
  const fetched = await client.callTool('investigation', { op: 'get', id })
  assert.equal(fetched.isError, false, fetched.text)
  const events = fetched.payload?.events ?? []
  assert.ok(events.length > 0, 'a capture with no events cannot be replayed')
  assert.ok(
    events.some(event => event.type === 'investigation:note'),
    `the agent's note should be on the timeline: ${events.map(e => e.type).join(', ')}`,
  )
  // The claim is that work done inside a session is captured without being
  // asked for. A note alone satisfies a count, so assert the trace itself
  // landed - this is what makes replay show the path rather than a summary.
  assert.ok(
    events.some(event => event.type === 'call:trace'),
    `the trace the agent ran should be on the timeline: ${events.map(e => e.type).join(', ')}`,
  )
  assert.ok(
    events.every(event => typeof event.offsetMs === 'number'),
    'every event needs an offset for the replay transport to seek',
  )
})
