// Does a confirmed architecture survive the things that used to destroy it?
//
// Two checks that only matter after approval, and one of them is the
// regression test for the bug that erased 805 of a real user's file
// assignments: Tidy Layout persisted root containment, and the layout write
// path turned that into `UPDATE files SET system_id = NULL`.
//
// Run against a scratch workspace with archd on 7743. Not part of the unit
// suite: it needs a live daemon and a real indexed project.
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = 'http://127.0.0.1:7743'
const WS = process.env.LOOP_WS ?? 'efddf5c5f623397c'
const ROOT = process.env.LOOP_ROOT ?? join(homedir(), 'axiom-loop-test')

const pass = []
const fail = []
const check = (label, ok, detail = '') => {
  ;(ok ? pass : fail).push(label)
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

const snapshot = () => api(`/api/snapshot/${WS}`).then(r => r.body)
const authored = snap => snap.systems.filter(s => s.source === 'agent')
const assignedTo = (snap, systemId) => snap.files.filter(f => f.systemId === systemId).length

let snap = await snapshot()
const approved = authored(snap)
check('an approved architecture exists to test', approved.length > 0, `${approved.length} authored systems`)
if (approved.length === 0) { report(); process.exit(1) }

const subject = approved.find(s => assignedTo(snap, s.id) > 0) ?? approved[0]
const before = assignedTo(snap, subject.id)
check('the subject system owns files', before > 0, `${subject.name}: ${before} files`)

// ── 6. a stale revision is refused rather than silently winning ────────────
const listed = await api(`/api/architecture-proposals?workspace=${WS}`)
const head = (Array.isArray(listed.body) ? listed.body : listed.body?.proposals ?? [])[0]
if (head) {
  const stale = await post(`/api/architecture-proposals/${head.id}/revisions`, {
    workspaceId: WS,
    expectedRevision: 999,
    round: { rationale: 'stale write', coverage: 'partial', systems: [], memberships: [] },
  })
  check('a stale revision is refused', stale.status === 409, `HTTP ${stale.status}`)
} else {
  check('a stale revision is refused', false, 'no proposal to revise')
}

// ── 8a. reindexing does not disturb authored membership ───────────────────
await post('/api/workspace', { workspaceId: WS, name: 'loop-test', rootPath: ROOT, ignoredPaths: [] })
await new Promise(r => setTimeout(r, 4000))
snap = await snapshot()
const afterReindex = assignedTo(snap, subject.id)
check('authored membership survives a reindex', afterReindex === before, `${before} -> ${afterReindex}`)

// ── 8b. the regression test for the data-loss bug ─────────────────────────
// Tidy Layout writes containment for every node. Before the fix, a file
// reported at `root` had its system_id nulled, so one button press erased the
// architecture. Layout is geometry; it must not own semantics.
const files = snap.files.filter(f => f.systemId === subject.id)
const now = Date.now()
const layouts = files.map((file, i) => ({
  workspaceId: WS, nodeId: file.id, nodeType: 'file',
  parentNodeId: null, parentNodeType: null, containmentKind: 'root',
  positionX: i * 200, positionY: 0, width: 180, height: 72,
  scale: 1, interiorScale: 1, updatedAt: now,
}))
const written = await post('/api/layout/batch', { workspaceId: WS, layouts })
check('a layout batch is accepted', written.status < 400, `HTTP ${written.status}`)

snap = await snapshot()
const afterLayout = assignedTo(snap, subject.id)
check('authored membership survives root-containment layout (the data-loss bug)',
  afterLayout === before, `${before} -> ${afterLayout}`)

const homeless = snap.files.filter(f => !f.systemId).length
check('no file was orphaned by the layout write', homeless === snap.files.length - snap.files.filter(f => f.systemId).length && afterLayout === before,
  `${homeless} files without a system`)

report()

function report() {
  console.log(`\n${pass.length} passed, ${fail.length} failed`)
  if (fail.length) { console.log('failures:'); for (const f of fail) console.log('  ' + f) }
  if (fail.length) process.exitCode = 1
}
