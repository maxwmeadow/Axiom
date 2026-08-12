import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blockedReason,
  buildProposalTree,
  checkDecision,
  describeProgress,
  readProgress,
} from './architectureProposal.ts'

const system = (systemKey, over = {}) => ({
  systemKey,
  name: over.name ?? systemKey,
  parentRefType: over.parentRefType ?? 'scope',
  parentRefId: over.parentRefId ?? null,
  depth: over.depth ?? 0,
  decision: over.decision ?? 'pending',
  fileCount: over.fileCount ?? 0,
  affectedFileCount: over.affectedFileCount ?? over.fileCount ?? 0,
  ...over,
})

const index = systems => new Map(systems.map(s => [s.systemKey, s]))

test('a flat response becomes a tree', () => {
  const roots = buildProposalTree([
    system('canvas', { name: 'Living Architecture Canvas' }),
    system('zoom', { name: 'Semantic Zoom', parentRefType: 'proposed_system', parentRefId: 'canvas', depth: 1 }),
    system('nodes', { name: 'Node Rendering', parentRefType: 'proposed_system', parentRefId: 'canvas', depth: 1 }),
    system('shell', { name: 'Node Shell', parentRefType: 'proposed_system', parentRefId: 'nodes', depth: 2 }),
  ])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].children.length, 2)
  const nodes = roots[0].children.find(c => c.systemKey === 'nodes')
  assert.equal(nodes.children[0].name, 'Node Shell')
})

test('a candidate whose parent is missing is shown at the top, never dropped', () => {
  const roots = buildProposalTree([
    system('orphan', { name: 'Orphan', parentRefType: 'proposed_system', parentRefId: 'gone', depth: 1 }),
  ])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].name, 'Orphan')
})

test('a parent cycle does not hang or lose systems', () => {
  const roots = buildProposalTree([
    system('a', { parentRefType: 'proposed_system', parentRefId: 'b' }),
    system('b', { parentRefType: 'proposed_system', parentRefId: 'a' }),
  ])
  const seen = []
  const walk = list => list.forEach(n => { seen.push(n.systemKey); walk(n.children) })
  walk(roots)
  assert.deepEqual(seen.sort(), ['a', 'b'])
})

test('a system under a live system is a root of the proposal tree', () => {
  const roots = buildProposalTree([
    system('sub', { parentRefType: 'live_system', parentRefId: 'existing-uuid', depth: 1 }),
  ])
  assert.equal(roots.length, 1)
})

test('a child cannot be approved before its proposed parent', () => {
  const systems = [
    system('canvas', { name: 'Living Architecture Canvas' }),
    system('zoom', { name: 'Semantic Zoom', parentRefType: 'proposed_system', parentRefId: 'canvas' }),
  ]
  const result = checkDecision({ systemKey: 'zoom', decision: 'approved' }, index(systems))
  assert.equal(result.ok, false)
  assert.match(result.reason, /Approve Living Architecture Canvas first/)
})

test('a child of an approved parent can be approved', () => {
  const systems = [
    system('canvas', { decision: 'approved' }),
    system('zoom', { parentRefType: 'proposed_system', parentRefId: 'canvas' }),
  ]
  assert.equal(checkDecision({ systemKey: 'zoom', decision: 'approved' }, index(systems)).ok, true)
})

test('a rejected parent explains itself rather than saying "approve it first"', () => {
  const systems = [
    system('canvas', { name: 'Living Architecture Canvas', decision: 'rejected' }),
    system('zoom', { parentRefType: 'proposed_system', parentRefId: 'canvas' }),
  ]
  assert.match(blockedReason(systems[1], index(systems)), /was rejected/)
})

test('rejecting requires a reason, because the reason is the point', () => {
  const systems = [system('canvas')]
  const bare = checkDecision({ systemKey: 'canvas', decision: 'rejected' }, index(systems))
  assert.equal(bare.ok, false)
  assert.match(bare.reason, /Say what is wrong/)

  const blank = checkDecision({ systemKey: 'canvas', decision: 'rejected', rejectionReason: '   ' }, index(systems))
  assert.equal(blank.ok, false)

  const given = checkDecision(
    { systemKey: 'canvas', decision: 'rejected', rejectionReason: 'This is two systems, not one.' },
    index(systems),
  )
  assert.equal(given.ok, true)
})

test('a rejection never needs its parent approved first', () => {
  const systems = [
    system('canvas'),
    system('zoom', { parentRefType: 'proposed_system', parentRefId: 'canvas' }),
  ]
  const result = checkDecision(
    { systemKey: 'zoom', decision: 'rejected', rejectionReason: 'wrong boundary' },
    index(systems),
  )
  assert.equal(result.ok, true)
})

test('deciding on a system that left the proposal is refused clearly', () => {
  const result = checkDecision({ systemKey: 'ghost', decision: 'approved' }, index([]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /no longer part of this proposal/)
})

test('partial approval is an ordinary outcome, not an error', () => {
  const progress = readProgress([
    system('a', { decision: 'approved', fileCount: 234 }),
    system('b', { decision: 'approved', fileCount: 87 }),
    system('c', { decision: 'rejected' }),
  ])
  assert.equal(progress.approved, 2)
  assert.equal(progress.rejected, 1)
  assert.equal(progress.pending, 0)
  assert.equal(progress.filesPlaced, 321)
  assert.equal(progress.settled, true)
  assert.equal(describeProgress(progress), '2 approved, 1 sent back')
})

test('only approved systems count as files placed', () => {
  const progress = readProgress([
    system('a', { decision: 'approved', fileCount: 10 }),
    system('b', { decision: 'rejected', fileCount: 99 }),
    system('c', { fileCount: 50 }),
  ])
  assert.equal(progress.filesPlaced, 10)
  assert.equal(progress.settled, false)
})

test('the header states a task, not a status', () => {
  assert.equal(describeProgress(readProgress([system('a'), system('b')])), '2 systems to review')
  assert.equal(
    describeProgress(readProgress([system('a', { decision: 'approved' }), system('b'), system('c')])),
    '2 left to review',
  )
  assert.equal(
    describeProgress(readProgress([system('a', { decision: 'approved', fileCount: 40 })])),
    'All 1 approved — 40 files placed',
  )
  assert.equal(describeProgress(readProgress([])), 'Nothing proposed yet.')
})
