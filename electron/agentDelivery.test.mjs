import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DeliveryRunner, deliveryArguments, deliveryTargets, findDeliveryCli, checkDeliveryMessage } from './agentDelivery.ts'
import { buildHosts } from './agentInstallers.ts'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-delivery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function testSpawn(command, args, options) {
  const env = { ...options.env }
  delete env.NODE_TEST_CONTEXT
  return spawn(command, args, { ...options, env })
}
async function state(runner, workspace, expected, key) {
  for (let i = 0; i < 200; i++) {
    const run = runner.list(workspace).find(run => (key ? run.key === key : run.state === expected))
    if (run?.state === expected) return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Expected ${expected}: ${JSON.stringify(runner.list(workspace))}`)
}
function input(root, overrides = {}) {
  return { workspaceId: 'ws', messageId: 'order', hostId: 'codex', rootPath: root, revision: 'initial', launcher: { command: process.execPath, args: [] }, args: ['-e', 'process.stdin.resume(); process.stdin.on("end",()=>{ console.log(process.cwd()); console.log(process.env.AXIOM_WORKSPACE_ID) })'], prompt: 'claim exactly order', ...overrides }
}

test('every installer host has a delivery route; editor hosts never masquerade as headless agents', t => {
  const root = fixture(t)
  const hosts = buildHosts(root, path.join(root, 'appdata'), 'linux')
  const targets = deliveryTargets(hosts, { PATH: root }, 'linux', root)
  assert.doesNotThrow(() => structuredClone(targets))
  assert.deepEqual(targets.map(host => host.id), hosts.map(host => host.id))
  for (const id of ['claude-desktop', 'copilot', 'cursor', 'windsurf', 'antigravity', 'jetbrains', 'zed']) {
    const target = targets.find(host => host.id === id)
    assert.notEqual(target.route, 'run')
    assert.equal(target.available, true)
    assert.match(target.detail, /Paste|paste/)
  }
  assert.deepEqual(targets.filter(host => host.route === 'run').map(host => host.id), ['claude-code', 'copilot-cli', 'codex'])
})

test('native CLI detection does not accept shell shims; npm Windows installs use bundled Node', t => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, 'claude.cmd'), 'not a native executable')
  assert.equal(findDeliveryCli('claude-code', { PATH: root, APPDATA: root }, 'win32', root), undefined)
  const script = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '')
  assert.deepEqual(findDeliveryCli('claude-code', { PATH: root, APPDATA: root }, 'win32', root, 'bundled-runtime'), { command: 'bundled-runtime', args: [script], bundledNode: true })
})

test('CLI configurations bind each MCP process to the requested workspace and host, without permission bypass', () => {
  const mcp = { command: 'C:\\Axiom Install\\archd.exe', args: ['mcp-run', 'runtime', 'entry'] }
  const prompt = 'Claim work order order, not a queue'
  for (const host of ['claude-code', 'codex', 'copilot-cli']) {
    const args = deliveryArguments(host, mcp, 'ws-123', prompt)
    assert.ok(args.join(' ').includes('ws-123'))
    assert.ok(args.join(' ').includes(`--axiom-host=${host}`))
    assert.ok(!args.some(arg => /bypass|skip-permissions|allow-all|yolo/.test(arg)))
    if (host === 'codex') { assert.ok(args.includes('workspace-write')); assert.equal(args.at(-1), '-') }
    else {
      const flag = host === 'claude-code' ? '--mcp-config' : '--additional-mcp-config'
      const config = JSON.parse(args[args.indexOf(flag) + 1])
      assert.equal(config.mcpServers.axiom.command, mcp.command)
      assert.equal(config.mcpServers.axiom.env.AXIOM_WORKSPACE_ID, 'ws-123')
    }
  }
  assert.throws(() => deliveryArguments('cursor', mcp, 'ws', prompt), /no direct/)
})

test('delivery rejects wrong projects, closed orders, legacy queues and live claims', () => {
  const message = { id: 'order', workspaceId: 'ws', status: 'queued', deliveryMode: 'addressed' }
  checkDeliveryMessage(message, 'ws', 'order', 100)
  assert.throws(() => checkDeliveryMessage(message, 'other', 'order'), /another project/)
  assert.throws(() => checkDeliveryMessage({ ...message, status: 'answered' }, 'ws', 'order'), /closed/)
  assert.throws(() => checkDeliveryMessage({ ...message, deliveryMode: 'open' }, 'ws', 'order'), /addressed/)
  assert.throws(() => checkDeliveryMessage({ ...message, status: 'delivered', leaseExpiresAt: 101 }, 'ws', 'order', 100), /already holds/)
  checkDeliveryMessage({ ...message, status: 'delivered', leaseExpiresAt: 99 }, 'ws', 'order', 100)
})

test('real child gets literal prompt, correct cwd and workspace; duplicate clicks and reloads do not launch again', async t => {
  const root = fixture(t)
  const directory = path.join(root, 'receipts')
  const runner = new DeliveryRunner(directory, testSpawn)
  const script = 'const fs=require("fs"); const text=fs.readFileSync(0,"utf8");fs.writeSync(1,JSON.stringify({cwd:process.cwd(),workspace:process.env.AXIOM_WORKSPACE_ID,host:process.env.AXIOM_AGENT_HOST,text}))'
  const request = input(root, { args: ['-e', script], prompt: '`touch injected` $(touch injected)\nclaim order' })
  const first = await runner.start(request)
  const duplicate = await runner.start({ ...request, hostId: 'claude-code' })
  assert.equal(duplicate.key, first.key)
  const done = await state(runner, 'ws', 'completed')
  const output = JSON.parse(fs.readFileSync(done.logPath, 'utf8'))
  assert.equal(output.cwd, fs.realpathSync(root)); assert.equal(output.workspace, 'ws'); assert.equal(output.host, 'codex'); assert.equal(output.text, request.prompt)
  assert.equal(fs.existsSync(path.join(root, 'injected')), false)
  assert.equal((await new DeliveryRunner(directory).start(request)).startedAt, first.startedAt)
  assert.deepEqual(runner.list('other-workspace'), [])
  const revised = await runner.start({ ...request, revision: 'review-2' })
  assert.notEqual(revised.key, first.key)
  await state(runner, 'ws', 'completed', revised.key)
})

test('a spawn failure is visible and retryable, while a host failure cannot silently execute twice', async t => {
  const root = fixture(t)
  const runner = new DeliveryRunner(path.join(root, 'receipts'), testSpawn)
  const missing = await runner.start(input(root, { launcher: { command: path.join(root, 'missing-cli'), args: [] } }))
  assert.equal(missing.state, 'launch-failed')
  const retried = await runner.start(input(root, { args: ['-e', 'require("fs").writeSync(2,"sign in required");process.exit(7)'] }))
  assert.equal(retried.key, missing.key)
  const failed = await state(runner, 'ws', 'failed')
  assert.match(failed.detail, /7/); assert.match(fs.readFileSync(failed.logPath, 'utf8'), /sign in/)
  const replay = await runner.start(input(root))
  assert.equal(replay.state, 'failed'); assert.equal(replay.startedAt, retried.startedAt)
})

test('overlapping runs are blocked, Stop kills the managed process, and a restart is reported honestly', async t => {
  const root = fixture(t)
  const directory = path.join(root, 'receipts')
  const runner = new DeliveryRunner(directory, testSpawn)
  const request = input(root, { args: ['-e', 'setInterval(()=>{},1000)'] })
  const run = await runner.start(request)
  t.after(() => runner.stopAll())
  assert.throws(() => runner.start({ ...request, messageId: 'second' }), /already running/)
  assert.equal(new DeliveryRunner(directory).list('ws')[0].state, 'interrupted')
  assert.throws(() => new DeliveryRunner(directory).start({ ...request, messageId: 'second' }), /may still be running/)
  assert.throws(() => runner.stop('other', run.key), /no longer controlled/)
  runner.stop('ws', run.key)
  await state(runner, 'ws', 'stopped')
})
