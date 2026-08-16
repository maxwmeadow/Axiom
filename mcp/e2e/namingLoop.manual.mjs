// End-to-end validation of the naming loop, driven the way it will really run:
// an agent proposes over MCP stdio, a human decides over the API, and the live
// map is checked for what should and should not be in it.
import { spawn } from 'node:child_process'

const API = 'http://127.0.0.1:7743'
const WS = 'efddf5c5f623397c'
const ROOT = 'C:\\Users\\maxst\\VSCodeProjects\\axiom-loop-test'

const pass = []
const fail = []
const check = (label, ok, detail = '') => {
  ;(ok ? pass : fail).push(label + (detail ? ` - ${detail}` : ''))
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`)
}

const api = async (path, init) => {
  const res = await fetch(API + path, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// ── 1. index the scratch project ──────────────────────────────────────────
await post('/api/workspace', { workspaceId: WS, name: 'loop-test', rootPath: ROOT, ignoredPaths: [] })
await new Promise(r => setTimeout(r, 4000))
let snap = (await api(`/api/snapshot/${WS}`)).body
check('scratch project indexed', snap.files.length >= 10, `${snap.files.length} files`)
const liveSystemsBefore = snap.systems.length

// ── 2. the agent proposes, over real MCP stdio ────────────────────────────
const child = spawn('node', ['mcp/axiom-mcp.ts'], {
  cwd: 'C:/Users/maxst/VSCodeProjects/Axiom-workbench-spine',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AXIOM_ACTIVE_PROJECT: 'C:/Users/maxst/AppData/Local/Temp/claude/c--Users-maxst-VSCodeProjects-Axiom/31b95f1a-4820-43da-b8cc-41a865c1fa5e/scratchpad/active-loop-test.json' },
})
let buf = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {}
  }
})
child.stderr.on('data', c => { const s = String(c); if (/error|refus/i.test(s)) process.stderr.write(s.slice(0, 200)) })
let rpcId = 0
const rpc = (method, params = {}) => new Promise(resolve => {
  const id = ++rpcId
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'loop-test', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const proposal = {
  op: 'propose',
  rationale: 'Three responsibilities: serving requests, persisting data, and taking money. Logging is shared.',
  systems: [
    { systemKey: 'http', name: 'Request Handling', description: 'Accepts HTTP requests and routes them.',
      files: ['src/api/server.js', 'src/api/router.js', 'src/api/middleware.js'] },
    { systemKey: 'store', name: 'Data Storage', description: 'Reads and writes persistent records.',
      files: ['src/storage/users.js', 'src/storage/pool.js'] },
    { systemKey: 'migrations', name: 'Schema Migrations', description: 'Evolves the database schema.',
      parentKey: 'store', files: ['src/storage/migrations.js'] },
    { systemKey: 'billing', name: 'Billing', description: 'Invoices customers and takes payment.',
      files: ['src/billing/invoice.js', 'src/billing/payments.js', 'src/billing/tax.js'] },
    { systemKey: 'shared', name: 'Shared Utilities', description: 'Cross-cutting helpers.',
      files: ['src/util/logger.js'] },
  ],
}
const proposed = await rpc('tools/call', { name: 'edit_systems', arguments: proposal })
const proposeText = JSON.stringify(proposed.result ?? proposed.error ?? {})
check('agent proposed over MCP', !proposed.error, proposed.error ? proposeText.slice(0, 160) : 'accepted')

// ── 3. nothing reached the live map ───────────────────────────────────────
snap = (await api(`/api/snapshot/${WS}`)).body
check('proposal did NOT touch the live map',
  snap.systems.length === liveSystemsBefore,
  `live systems ${liveSystemsBefore} -> ${snap.systems.length}`)

const listed = await api(`/api/architecture-proposals?workspace=${WS}`)
const raw = listed.body; const arr = Array.isArray(raw) ? raw : (raw?.proposals ?? []); const head = arr[0]
check('proposal is readable by the review surface', Boolean(head), head ? `id ${String(head.id).slice(0, 8)}` : 'none returned')
if (!head) { child.kill(); report(); process.exit(1) }

const detail = (await api(`/api/architecture-proposals/${head.id}?workspace=${WS}`)).body
const systems = detail.systems ?? detail.round?.systems ?? []
check('all five candidates stored', systems.length === 5, `${systems.length} candidates`)
check('every candidate starts pending', systems.every(s => s.decision === 'pending'))
const migrations = systems.find(s => s.name === 'Schema Migrations')
check('nesting survived the round trip',
  migrations?.parentRefType === 'proposed_system' && migrations?.depth === 1,
  `parent=${migrations?.parentRefType} depth=${migrations?.depth}`)

// ── 4. an agent cannot bypass review ──────────────────────────────────────
const bypass = await rpc('tools/call', { name: 'edit_systems', arguments: { op: 'create', name: 'Sneaky System' } })
const refused = Boolean(bypass.error) || /awaiting review/i.test(JSON.stringify(bypass.result ?? {}))
check('direct create is refused while review is pending', refused)

// ── 5. the human decides ──────────────────────────────────────────────────
const keyFor = name => systems.find(s => s.name === name)?.systemKey
const decide = (key, decision, rejectionReason) =>
  post(`/api/architecture-proposals/${head.id}/systems/${encodeURIComponent(key)}/decision`, {
    workspaceId: WS, revision: detail.currentRevision ?? 1, decision,
    rejectionReason: rejectionReason ?? '', decidedBy: 'user',
  })

const early = await decide(keyFor('Schema Migrations'), 'approved')
check('a child cannot be approved before its parent', early.status >= 400, `HTTP ${early.status}`)

const parent = await decide(keyFor('Data Storage'), 'approved')
check('approving a parent succeeds', parent.status < 400, `HTTP ${parent.status}`)
const childNow = await decide(keyFor('Schema Migrations'), 'approved')
check('the child approves once its parent is in', childNow.status < 400, `HTTP ${childNow.status}`)

const noReason = await decide(keyFor('Shared Utilities'), 'rejected')
check('rejecting without a reason is refused', noReason.status >= 400, `HTTP ${noReason.status}`)
const withReason = await decide(keyFor('Shared Utilities'), 'rejected', 'One file is not a system. Fold it into whoever uses it.')
check('rejecting with a reason succeeds', withReason.status < 400, `HTTP ${withReason.status}`)

await decide(keyFor('Request Handling'), 'approved')

// ── 6. only what was approved is on the map ───────────────────────────────
await new Promise(r => setTimeout(r, 1200))
snap = (await api(`/api/snapshot/${WS}`)).body
const live = snap.systems.filter(s => s.source === 'agent').map(s => s.name)
check('approved systems materialised', live.includes('Data Storage') && live.includes('Request Handling'), live.join(', ') || 'none')
check('the rejected system is NOT on the map', !live.includes('Shared Utilities'))
check('the undecided system is NOT on the map', !live.includes('Billing'))

const storage = snap.systems.find(s => s.name === 'Data Storage')
const placed = snap.files.filter(f => f.systemId === storage?.id).length
check('approving a system moved its files', placed === 2, `${placed} files in Data Storage`)

const after = (await api(`/api/architecture-proposals/${head.id}?workspace=${WS}`)).body
const shared = ((after.round?.systems) ?? after.systems ?? []).find(s => s.name === 'Shared Utilities')
check('the rejection reason is kept for the next round',
  Boolean(shared?.rejectionReason), shared?.rejectionReason ?? 'missing')

child.kill()
report()

function report() {
  console.log(`\n${pass.length} passed, ${fail.length} failed`)
  if (fail.length) { console.log('\nfailures:'); for (const f of fail) console.log('  ' + f) }
}
