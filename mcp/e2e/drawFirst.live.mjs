// Opt-in real host trial. No developer project or global host config is changed.
// AXIOM_LIVE_DRAW_FIRST_HOST=codex|claude-code|copilot-cli node --test mcp/e2e/drawFirst.live.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHarness, harnessFetch as fetch } from './mcpHarness.mjs'
import { agentRuleFiles, installAgentRule } from '../../electron/agentRules.ts'

const host = process.env.AXIOM_LIVE_DRAW_FIRST_HOST
const supported = ['codex', 'claude-code', 'copilot-cli']

function sourceSnapshot(root) {
  const files = {}
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__pycache__') visit(target)
      else if (entry.isFile() && entry.name.endsWith('.py')) files[path.relative(root, target)] = fs.readFileSync(target, 'utf8')
    }
  }
  visit(root)
  return files
}

async function runHost(harness, prompt) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '', AXIOM_API_URL: harness.apiBase, AXIOM_API_TOKEN: 'axiom-isolated-test-token-for-mcp-harness', AXIOM_ACTIVE_PROJECT: harness.activeProjectPath }
  const mcp = { command: process.execPath, args: [fileURLToPath(new URL('../axiom-mcp.ts', import.meta.url)), `--axiom-host=${host}`], env: { AXIOM_API_URL: env.AXIOM_API_URL, AXIOM_API_TOKEN: env.AXIOM_API_TOKEN, AXIOM_ACTIVE_PROJECT: env.AXIOM_ACTIVE_PROJECT } }
  let binary, args
  if (host === 'codex') {
    binary = process.env.AXIOM_CODEX_BIN || 'codex'
    const settings = [
      `mcp_servers.axiom.command=${JSON.stringify(mcp.command)}`,
      `mcp_servers.axiom.args=${JSON.stringify(mcp.args)}`,
      ...Object.entries(mcp.env).map(([key, value]) => `mcp_servers.axiom.env.${key}=${JSON.stringify(value)}`),
    ]
    args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--json', '--approve-for-me', '-C', harness.projectDir, ...settings.flatMap(value => ['-c', value]), prompt]
  } else if (host === 'claude-code') {
    binary = process.env.AXIOM_CLAUDE_BIN || 'claude'
    args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { axiom: mcp } }), '--allowedTools', 'mcp__axiom__*,Read,Glob,Grep,Edit,Write,Bash(python3 *)']
  } else {
    binary = process.env.AXIOM_COPILOT_BIN || 'copilot'
    args = ['-p', prompt, '--additional-mcp-config', JSON.stringify({ mcpServers: { axiom: mcp } }), '--allow-tool', 'axiom', '--allow-tool', 'write', '--allow-tool', 'shell(python3)', '--no-ask-user']
  }
  const child = spawn(binary, args, { cwd: harness.projectDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 180000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }).finally(() => clearTimeout(timer))
  return { code, timedOut, stdout, stderr }
}

test('fresh host draws before code, waits for human approval, then reuses and compares its plan', { skip: !host, timeout: 420000 }, async () => {
  assert.ok(supported.includes(host), `Unsupported live host: ${host}`)
  const harness = await startHarness()
  const report = { host, startedAt: new Date().toISOString(), phases: [] }
  const recordDir = process.env.AXIOM_LIVE_RECORD_DIR || path.join(os.tmpdir(), 'axiom-draw-first-recordings')
  try {
    for (const rule of agentRuleFiles(host, harness.projectDir)) installAgentRule(rule)
    const original = sourceSnapshot(harness.projectDir)
    const planning = await runHost(harness, 'Add a CSV export feature to this small Python application. Introduce a dedicated export formatting service and wire an API handler to it; keep HTTP handling and export formatting as separate responsibilities. Include a runnable check for the new behavior.')
    report.phases.push({ name: 'plan', ...planning })
    assert.equal(planning.timedOut, false)
    assert.equal(planning.code, 0, planning.stderr.slice(-2000))
    assert.deepEqual(sourceSnapshot(harness.projectDir), original, 'source changed before human review')
    const sheets = await harness.client.callTool('edit_sheet', { op: 'list' })
    assert.equal(sheets.isError, false, sheets.text)
    assert.equal(sheets.payload.length, 1, 'agent must draw one scoped plan')
    const sheet = sheets.payload[0]
    const detailsResponse = await fetch(`${harness.apiBase}/api/sheets/${sheet.id}?workspace=${harness.workspaceId}`)
    const details = await detailsResponse.json()
    report.plan = details
    assert.ok(details.planned?.length > 0, 'agent did not draw planned elements')
    assert.ok(details.plannedEdges?.length > 0, 'agent did not draw dependencies')
    assert.ok(details.planned.every(node => node.approvalStatus === 'pending'), 'agent bypassed human review')
    assert.ok(planning.stdout.includes(sheet.id), 'agent did not identify the plan to the human')
    for (const node of details.planned) {
      const response = await fetch(`${harness.apiBase}/api/planned/${node.id}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: harness.workspaceId, decision: 'approved' }) })
      assert.ok(response.ok, await response.text())
    }
    const implementation = await runHost(harness, `I reviewed and approved the proposals on sheet "${sheet.name}" (${sheet.id}) in Axiom. Build that plan now, run the requested check, and report the result and remaining structural differences.`)
    report.phases.push({ name: 'build', ...implementation })
    assert.equal(implementation.timedOut, false)
    assert.equal(implementation.code, 0, implementation.stderr.slice(-2000))
    assert.notDeepEqual(sourceSnapshot(harness.projectDir), original, 'approved build did not change source')
    const after = await harness.client.callTool('edit_sheet', { op: 'list', includeResolved: true })
    assert.equal(after.payload.length, 1, 'resume duplicated the sheet')
    const actionsResponse = await fetch(`${harness.apiBase}/api/agent/actions?workspace=${harness.workspaceId}&limit=200`)
    if (actionsResponse.ok) report.actions = await actionsResponse.json()
    if (host === 'codex') {
      const events = implementation.stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      assert.ok(events.some(event => event.item?.type === 'mcp_tool_call' && event.item.tool === 'edit_sheet' && event.item.arguments?.op === 'compare'), 'agent did not compare after building')
    }
    report.passed = true
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.mkdirSync(recordDir, { recursive: true })
    fs.writeFileSync(path.join(recordDir, `${host}.json`), JSON.stringify(report, null, 2))
    console.log(`Recorded ${host} trial at ${path.join(recordDir, `${host}.json`)}`)
    harness.stop()
  }
})
