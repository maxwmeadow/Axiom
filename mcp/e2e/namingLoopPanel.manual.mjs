// Does the review surface agree with the daemon?
//
// Feeds a real proposal response through the exact modules the panel renders
// from, so the tree, the counts and the depths on screen are asserted against
// what the API actually returned rather than against a fixture someone wrote
// by hand. This is where the wire-shape bugs hid: the panel rendered an empty
// review because candidates live under `round`, which no unit test could see.
import assert from 'node:assert/strict'
import { buildProposalTree, readProgress, blockedReason } from '../../src/renderer/canvas/architectureProposal.ts'

const API = 'http://127.0.0.1:7743'
const WS = process.env.LOOP_WS ?? 'efddf5c5f623397c'

const listed = await (await fetch(`${API}/api/architecture-proposals?workspace=${WS}`)).json()
const proposals = Array.isArray(listed) ? listed : listed?.proposals ?? []
const open = proposals.find(p => (p.round?.systems ?? p.systems ?? []).some(s => s.decision === 'pending'))
assert.ok(open, 'expected an open proposal — run namingLoop.manual.mjs first')

const detail = await (await fetch(`${API}/api/architecture-proposals/${open.id}?workspace=${WS}`)).json()

// The same normalisation the store performs at the boundary.
const systems = detail.round?.systems ?? detail.systems ?? []
const rationale = detail.round?.rationale ?? null

assert.ok(systems.length > 0, 'the panel would render an empty review')
assert.ok(rationale, 'the panel header would show no rationale')
console.log(`PASS  panel reads ${systems.length} candidates and a rationale from the live response`)

const tree = buildProposalTree(systems)
const flat = []
const walk = (nodes, depth) => nodes.forEach(n => { flat.push({ n, depth }); walk(n.children, depth + 1) })
walk(tree, 0)

assert.equal(flat.length, systems.length, 'the tree lost or duplicated a candidate')
console.log(`PASS  every candidate appears exactly once in the rendered tree`)

// Rendered nesting must agree with the depth the daemon computed, or the
// indentation on screen is telling a different story from the data.
for (const { n, depth } of flat) {
  assert.equal(depth, n.depth, `${n.name}: rendered depth ${depth} but daemon says ${n.depth}`)
}
console.log('PASS  rendered depth matches the daemon for every candidate')

const roots = tree.filter(node => node.parentRefType !== 'proposed_system')
assert.ok(roots.length > 0 && roots.length < systems.length, 'expected a nested tree, not a flat list')
console.log(`PASS  the tree is nested — ${roots.length} at the top of ${systems.length}`)

// A child must be refused until its parent is approved, and the refusal must
// name the parent rather than being a silent disabled control.
const byKey = new Map(systems.map(s => [s.systemKey, s]))
const child = systems.find(s => s.parentRefType === 'proposed_system' && byKey.get(s.parentRefId)?.decision === 'pending')
assert.ok(child, 'expected a child whose parent is still pending')
const reason = blockedReason(child, byKey)
assert.match(reason, /Approve .+ first/)
console.log(`PASS  blocked child explains itself — "${reason}"`)

const progress = readProgress(systems)
const apiFiles = systems.reduce((n, s) => n + (s.fileCount ?? 0), 0)
assert.equal(progress.total, systems.length)
assert.ok(apiFiles > 0, 'candidates carry no file counts, so the panel shows "0 files" everywhere')
console.log(`PASS  counts agree — ${progress.total} candidates, ${apiFiles} files across them`)

console.log('\npanel data path verified against the live daemon')
