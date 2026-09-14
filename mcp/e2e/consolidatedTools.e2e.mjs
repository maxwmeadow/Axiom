import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness } from './mcpHarness.mjs'

/**
 * Proves the consolidated tool surface actually works end to end.
 *
 * The routing unit tests assert the table maps the right names. They cannot
 * catch the failure that matters: a consolidated tool handing a legacy handler
 * an argument under a name it does not read. That produces a passing table and
 * a tool that silently returns nothing.
 *
 * So every scope and every op is executed against a real archd here.
 */

let harness
let client

test.before(async () => {
  harness = await startHarness()
  client = harness.client
}, { timeout: 90000 })

test.after(() => harness?.stop())

test('the advertised surface is the consolidated one', async () => {
  const response = await client.request('tools/list', {})
  const names = response.result.tools.map(tool => tool.name)

  assert.ok(names.length <= 15, `advertised ${names.length} tools: ${names.join(', ')}`)
  assert.ok(names.includes('get_architecture'))
  assert.ok(names.includes('edit_systems'))
  assert.equal(names.includes('get_neighbors'), false, 'a merged tool is advertised again')
  assert.equal(names.includes('debug_runtime'), false, 'debug profile leaked into the default')
})

test('a legacy name still executes even though it is not advertised', async () => {
  // Existing agent configurations must keep working through the migration.
  const result = await client.callTool('get_systems_overview', {})
  assert.equal(result.isError, false, result.text)
})

test('every architecture scope returns without error', async () => {
  const files = harness.snapshot.files ?? []
  const systems = harness.snapshot.systems ?? []
  const fileId = files[0]?.id
  const systemId = systems[0]?.id ?? files[0]?.systemId

  const scopes = [
    ['overview', {}],
    ['unclassified', {}],
    ['files', {}],
    ['dependency_graph', {}],
    ['infra', {}],
    ['infra_catalog', {}],
    ['hotspots', { limit: 5 }],
    ['cross_dependencies', { limit: 5 }],
    ['node', { id: fileId }],
    ['neighbors', { id: fileId, depth: 1 }],
    ['infra_for_files', { ids: [fileId] }],
  ]
  if (systemId) {
    scopes.push(['system_files', { id: systemId }])
    scopes.push(['systems', { ids: [systemId] }])
    scopes.push(['family', { id: systemId, depth: 1 }])
  }

  for (const [scope, args] of scopes) {
    const result = await client.callTool('get_architecture', { scope, ...args })
    assert.equal(result.isError, false, `scope "${scope}" failed: ${result.text}`)
  }
})

test('an unknown scope fails loudly instead of returning nothing', async () => {
  const result = await client.callTool('get_architecture', { scope: 'nonsense' })
  assert.equal(result.isError, true)
  assert.match(result.text, /unknown op/)
})

test('symbols and function bodies both resolve', async () => {
  const files = harness.snapshot.files ?? []
  const target = files.find(file => file.relPath.endsWith('task_store.py')) ?? files[0]

  const symbols = await client.callTool('get_symbols', { fileIds: [target.id] })
  assert.equal(symbols.isError, false, symbols.text)

  const body = await client.callTool('get_symbols', { file: target.relPath, symbol: 'add' })
  assert.equal(body.isError, false, body.text)
})

test('search reaches the fixture', async () => {
  const result = await client.callTool('search_symbols', { query: 'TaskStore', limit: 5 })
  assert.equal(result.isError, false, result.text)
  assert.match(JSON.stringify(result.payload), /TaskStore/)
})

test('tracing works in both shapes', async () => {
  const files = harness.snapshot.files ?? []
  const caller = files.find(file => file.relPath.endsWith('index.py'))
  const callee = files.find(file => file.relPath.endsWith('task_store.py'))

  const graph = await client.callTool('trace_calls', {
    fileIds: [caller.id], direction: 'out', depth: 2,
  })
  assert.equal(graph.isError, false, graph.text)

  const path = await client.callTool('trace_calls', {
    from: caller.relPath, to: callee.relPath,
  })
  assert.equal(path.isError, false, path.text)
})

test('an agent can curate the architecture map', async () => {
  // This is the bidirectional thesis: the indexer gets most of the way, the
  // agent closes the gap. If these break, the product premise breaks.
  const created = await client.callTool('edit_systems', {
    op: 'create', name: 'HarnessSystem', description: 'created by the e2e harness',
  })
  assert.equal(created.isError, false, created.text)
  const systemId = created.payload?.systemId ?? created.payload?.id
  assert.ok(systemId, `create returned no id: ${created.text}`)

  const renamed = await client.callTool('edit_systems', {
    op: 'update', systemId, name: 'HarnessRenamed',
  })
  assert.equal(renamed.isError, false, renamed.text)

  const files = harness.snapshot.files ?? []
  const assigned = await client.callTool('edit_systems', {
    op: 'assign', systemId, fileIds: [files[0].id],
  })
  assert.equal(assigned.isError, false, assigned.text)

  const removed = await client.callTool('edit_systems', { op: 'delete', systemId })
  assert.equal(removed.isError, false, removed.text)
})

test('sheet ops route correctly', async () => {
  const listed = await client.callTool('edit_sheet', { op: 'list' })
  assert.equal(listed.isError, false, listed.text)

  const created = await client.callTool('edit_sheet', {
    op: 'create', name: 'HarnessSheet', purpose: 'e2e',
  })
  assert.equal(created.isError, false, created.text)

  const fetched = await client.callTool('edit_sheet', { op: 'get', sheet: 'HarnessSheet' })
  assert.equal(fetched.isError, false, fetched.text)
})

test('infra catalog and creation route correctly', async () => {
  // The service must exist in the registry, so read the catalog rather than
  // guessing a name - guessing is what a real agent would get wrong too.
  const catalog = await client.callTool('get_architecture', { scope: 'infra_catalog' })
  assert.equal(catalog.isError, false, catalog.text)
  const services = Array.isArray(catalog.payload)
    ? catalog.payload
    : catalog.payload?.services ?? []
  assert.ok(services.length > 0, `registry returned no services: ${catalog.text}`)
  const service = services[0]

  const created = await client.callTool('edit_infra', {
    op: 'create',
    name: 'HarnessInfra',
    service: service.id ?? service.service ?? service.name,
    category: service.category,
  })
  assert.equal(created.isError, false, created.text)
})

test('the work session lifecycle runs through two tools', async () => {
  const started = await client.callTool('start_work', {
    goal: 'Exercise the consolidated surface', agent: 'harness',
  })
  assert.equal(started.isError, false, started.text)
  assert.equal(started.payload.rootId, harness.snapshot.files[0].rootId)

  const noted = await client.callTool('update_work', { note: 'halfway through' })
  assert.equal(noted.isError, false, noted.text)

  const finished = await client.callTool('update_work', {
    done: true, summary: 'surface verified end to end',
  })
  assert.equal(finished.isError, false, finished.text)
})

test('the inbox answers without blocking', async () => {
  const result = await client.callTool('get_inbox', {})
  assert.equal(result.isError, false, result.text)
})

test('agent actions are logged with targets the canvas can light up', async () => {
  // The action log is what makes agent work visible. If a call does not land
  // here, the canvas cannot show it and the visual log stays empty.
  const files = harness.snapshot.files ?? []
  await client.callTool('get_architecture', { scope: 'node', id: files[0].id })

  // Logging is fire-and-forget on the MCP side.
  await new Promise(resolve => setTimeout(resolve, 600))

  const res = await fetch(
    `${harness.apiBase}/api/agent/actions?workspace=${harness.workspaceId}&limit=50`,
  )
  assert.ok(res.ok, `agent log fetch failed: ${res.status}`)
  const actions = await res.json()
  assert.ok(actions.length > 0, 'no agent actions were recorded')

  // Logged under the name the agent called, not the legacy name it routed to.
  const architecture = actions.find(action => action.tool === 'get_architecture')
  assert.ok(architecture, `expected a get_architecture entry, got: ${
    actions.map(a => a.tool).join(', ')}`)
  assert.equal(architecture.rootId, harness.snapshot.files[0].rootId)
  assert.equal(architecture.agent, 'axiom-harness')
  assert.equal(architecture.kind, 'read')
  assert.ok(
    architecture.targets.includes(files[0].id),
    'the read did not record the node it looked at',
  )

  const write = actions.find(action => action.kind === 'write')
  assert.ok(write, 'architecture curation was not logged as a write')
})

test('the running MCP process renews a harness-tagged presence lease', async () => {
  let presence
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await fetch(
      `${harness.apiBase}/api/agent/presence?workspace=${harness.workspaceId}`,
    )
    assert.ok(res.ok, `agent presence fetch failed: ${res.status}`)
    presence = await res.json()
    if (presence.connected) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  assert.equal(presence?.connected, true)
  assert.ok(
    presence.connections.some(connection => connection.hostId === 'axiom-harness'),
    `missing tagged harness presence: ${JSON.stringify(presence)}`,
  )
})
