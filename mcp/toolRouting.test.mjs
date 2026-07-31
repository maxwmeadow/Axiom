import assert from 'node:assert/strict'
import test from 'node:test'
import { coveredLegacyTools, routeTool } from './toolRouting.ts'

test('an unconsolidated name falls through untouched', () => {
  assert.equal(routeTool('search_symbols', { query: 'x' }), null)
  assert.equal(routeTool('plan_element', {}), null)
})

test('one architecture question reaches every graph read', () => {
  const cases = {
    overview: 'get_systems_overview',
    unclassified: 'get_unclassified_files',
    system_files: 'get_system_files',
    systems: 'get_systems_with_files',
    files: 'get_raw_files',
    node: 'get_node',
    neighbors: 'get_neighbors',
    family: 'get_family',
    cross_dependencies: 'get_cross_system_dependencies',
    dependency_graph: 'get_call_graph',
    infra: 'list_infra',
    infra_for_files: 'get_infra_for_files',
    infra_catalog: 'list_infra_services',
    hotspots: 'get_activity_hotspots',
  }
  for (const [scope, tool] of Object.entries(cases)) {
    assert.equal(routeTool('get_architecture', { scope }).tool, tool, scope)
  }
})

test('one id is spread onto whatever the legacy read calls it', () => {
  // The agent should not have to know that one endpoint says systemId and
  // another says id for the same thing.
  const system = routeTool('get_architecture', { scope: 'system_files', id: 's1' })
  assert.equal(system.args.systemId, 's1')

  const node = routeTool('get_architecture', { scope: 'node', id: 'n1' })
  assert.equal(node.args.id, 'n1')

  const files = routeTool('get_architecture', { scope: 'infra_for_files', ids: ['f1'] })
  assert.deepEqual(files.args.fileIds, ['f1'])

  const family = routeTool('get_architecture', { scope: 'family', id: 's1', depth: 2 })
  assert.equal(family.args.descendantDepth, 2)
})

test('undefined arguments never reach a legacy handler', () => {
  const routed = routeTool('get_architecture', { scope: 'overview' })
  assert.deepEqual(Object.keys(routed.args), [], 'no undefined keys leak through')
})

test('an unknown scope fails loudly and lists the valid ones', () => {
  assert.throws(
    () => routeTool('get_architecture', { scope: 'nonsense' }),
    /unknown op "nonsense".*overview/s,
  )
})

test('architecture curation reaches every write, because agents own the map', () => {
  const cases = {
    create: 'create_system',
    update: 'update_system',
    delete: 'delete_system',
    assign: 'assign_files_to_system',
    merge: 'merge_systems',
    bulk: 'update_systems_bulk',
  }
  for (const [op, tool] of Object.entries(cases)) {
    assert.equal(routeTool('edit_systems', { op }).tool, tool, op)
  }
})

test('the op discriminator is stripped before the legacy handler sees it', () => {
  const routed = routeTool('edit_systems', { op: 'create', name: 'Storage', parentId: 'p1' })
  assert.deepEqual(routed.args, { name: 'Storage', parentId: 'p1' })
  assert.equal('op' in routed.args, false)
})

test('infra and sheet ops route the same way', () => {
  assert.equal(routeTool('edit_infra', { op: 'connect' }).tool, 'connect_infra')
  assert.equal(routeTool('edit_sheet', { op: 'annotate' }).tool, 'annotate_sheet')
  assert.throws(() => routeTool('edit_infra', { op: 'explode' }), /unknown op/)
})

test('symbols and bodies are one question with a detail flag', () => {
  assert.equal(
    routeTool('get_symbols', { fileIds: ['f1'] }).tool,
    'get_symbols_for_files',
  )
  const body = routeTool('get_symbols', { file: 'a.py', symbol: 'run' })
  assert.equal(body.tool, 'get_function_body')
  assert.deepEqual(body.args, { file: 'a.py', symbol: 'run' })
})

test('tracing picks the endpoint that matches what was asked', () => {
  assert.equal(routeTool('trace_calls', { from: 'a', to: 'b' }).tool, 'get_call_path')
  const graph = routeTool('trace_calls', { fileIds: ['f1'], direction: 'out', depth: 2 })
  assert.equal(graph.tool, 'get_call_graph_for_files')
  assert.equal(graph.args.depth, 2)
})

test('an empty fileIds list is not a call-graph request', () => {
  assert.equal(routeTool('trace_calls', { from: 'a', to: 'b', fileIds: [] }).tool, 'get_call_path')
})

test('the inbox blocks only when asked to wait', () => {
  assert.equal(routeTool('get_inbox', {}).tool, 'get_canvas_updates')
  const waiting = routeTool('get_inbox', { waitSeconds: 30 })
  assert.equal(waiting.tool, 'await_canvas')
  assert.equal(waiting.args.timeoutSeconds, 30)
  assert.equal(routeTool('get_inbox', { waitSeconds: 0 }).tool, 'get_canvas_updates')
})

test('a build plan is fetched by id or by sheet', () => {
  assert.equal(routeTool('get_build_plan', { id: 'p1' }).tool, 'get_plan_status')
  assert.equal(routeTool('get_build_plan', { sheet: 'Auth' }).tool, 'get_build_spec')
})

test('update_work covers noting and finishing so lifecycle cannot be confused', () => {
  const note = routeTool('update_work', { note: 'crossed a boundary on purpose' })
  assert.equal(note.tool, 'note_work')
  assert.equal(note.args.text, 'crossed a boundary on purpose')

  const done = routeTool('update_work', { done: true, summary: 'auth goes through one door now' })
  assert.equal(done.tool, 'finish_work')
  assert.equal(done.args.summary, 'auth goes through one door now')
})

test('finishing without a summary still closes the session', () => {
  const done = routeTool('update_work', { done: true })
  assert.equal(done.tool, 'finish_work')
  assert.equal(done.args.summary, '')
})

test('debug and investigation ops route behind their profile', () => {
  assert.equal(routeTool('debug_runtime', { op: 'watch', file: 'a.py', symbol: 'run' }).tool, 'watch_function')
  assert.equal(routeTool('debug_runtime', { op: 'snapshot' }).tool, 'get_runtime_snapshot')
  assert.equal(routeTool('investigation', { op: 'note', text: 'hm' }).tool, 'annotate_investigation')
})

test('every legacy tool a consolidated tool claims actually exists', async () => {
  const { readFileSync } = await import('node:fs')
  // Normalized: git checks this out with CRLF on Windows, and a line-anchored
  // regex would then match nothing and pass vacuously.
  const source = readFileSync(new URL('./axiom-mcp.ts', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
  const implemented = new Set([...source.matchAll(/^      case '([^']+)':/gm)].map(m => m[1]))
  for (const tool of coveredLegacyTools()) {
    assert.ok(implemented.has(tool), `routing targets "${tool}" but no handler implements it`)
  }
})
