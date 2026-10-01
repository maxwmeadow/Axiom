import assert from 'node:assert/strict'
import test from 'node:test'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'

test('draw-first guidance reaches every MCP client and a real sheet keeps proposals pending', { timeout: 90000 }, async () => {
  const harness = await startHarness()
  try {
    const { client, workspaceId, apiBase } = harness
    assert.match(harness.initialization.instructions, /draw structural changes before code/)
    assert.match(harness.initialization.instructions, /Bug fixes, tests, documentation/)
    const prompt = await client.request('prompts/get', { name: 'review-canvas' })
    assert.match(prompt.result.messages[0].content.text, /draw structural changes before code/)
    const files = harness.snapshot.files
    const contextFile = files.find(file => file.relPath === 'api/handlers.py')
    const created = await client.callTool('edit_sheet', { op: 'create', name: 'CSV export boundary', purpose: 'API calls a new export service', members: [contextFile.id] })
    assert.equal(created.isError, false, created.text)
    const sheetId = created.payload.created.id
    const proposal = await client.callTool('plan_element', { sheet: sheetId, name: 'CSV Export', kind: 'system', notes: 'Owns export formatting, called by the API' })
    assert.equal(proposal.isError, false, proposal.text)
    assert.equal(proposal.payload.approvalStatus, 'pending')
    assert.match(proposal.payload.instruction, /get_build_plan\(id\)/)
    assert.doesNotMatch(proposal.payload.instruction, /get_plan_status/)
    const plannedId = proposal.payload.id
    const connection = { op: 'connect', sheet: sheetId, from: contextFile.id, to: plannedId, kind: 'DEPENDS_ON', body: 'API delegates export formatting' }
    const drawn = await client.callTool('edit_sheet', connection)
    assert.equal(drawn.isError, false, drawn.text)
    assert.equal(drawn.payload.srcLive, contextFile.id)
    assert.equal(drawn.payload.dstPlanned, plannedId)
    const retry = await client.callTool('edit_sheet', connection)
    assert.equal(retry.isError, false, retry.text)
    assert.equal(retry.payload.id, drawn.payload.id, 'a retry must not duplicate the relationship')
    const status = await client.callTool('get_build_plan', { id: plannedId })
    assert.equal(status.payload.approvalStatus, 'pending')
    const spec = await client.callTool('get_build_plan', { sheet: sheetId })
    assert.equal(spec.isError, false, spec.text)
    assert.doesNotMatch(JSON.stringify(spec.payload), new RegExp(plannedId), 'pending elements cannot enter the executable spec')
    const before = await client.callTool('edit_sheet', { op: 'compare', sheet: sheetId })
    assert.equal(before.payload.equivalent, false)
    assert.ok(before.payload.differences.some(difference => difference.kind === 'approval'))
    const annotation = await client.callTool('edit_sheet', { op: 'annotate', sheet: sheetId, body: 'Keep HTTP in API; move export formatting into CSV Export. Await review.' })
    assert.equal(annotation.isError, false, annotation.text)
    for (const args of [
      { ...connection, to: contextFile.id },
      { ...connection, from: 'foreign-or-missing-node' },
      { ...connection, kind: 'invalid kind' },
    ]) {
      const refused = await client.callTool('edit_sheet', args)
      assert.equal(refused.isError, true, `invalid relationship accepted: ${JSON.stringify(args)}`)
    }
    const other = await client.callTool('edit_sheet', { op: 'create', name: 'Unrelated plan', members: [contextFile.id] })
    const offSheet = await client.callTool('edit_sheet', { ...connection, sheet: other.payload.created.id })
    assert.equal(offSheet.isError, true)
    assert.match(offSheet.text, /not on this sheet/)
    // Approval comes through the human's API path, never through an agent tool.
    const decision = await fetch(`${apiBase}/api/planned/${plannedId}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, decision: 'approved' }) })
    assert.ok(decision.ok, await decision.text())
    const approved = await client.callTool('get_build_plan', { id: plannedId })
    assert.equal(approved.payload.approvalStatus, 'approved')
    const after = await client.callTool('edit_sheet', { op: 'compare', sheet: sheetId })
    assert.ok(after.payload.differences.some(difference => difference.kind === 'relationship'))
    assert.equal(after.payload.equivalent, false, 'approval is not proof of implementation')
    const started = await client.callTool('start_work', { goal: 'Build reviewed export boundary', agent: 'harness' })
    assert.match(started.payload.instruction, /Before structural source edits/)
    const result = await client.callTool('update_work', { sessionId: started.payload.sessionId, done: true, summary: 'Recorded remaining structural differences without changing the Floor' })
    assert.equal(result.isError, false, result.text)
  } finally { harness.stop() }
})
