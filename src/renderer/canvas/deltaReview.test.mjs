import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDeltaMarks,
  claimRationale,
  buildDeltaReview,
  claimFocusTargets,
  clampClaimCursor,
  deltaAttribution,
  deltaHeadline,
  deltaWindow,
} from './deltaReview.ts'

const emptyCounts = {
  filesCreated: 0, filesUpdated: 0, filesDeleted: 0,
  edgesAdded: 0, edgesRemoved: 0,
  systemsAdded: 0, systemsRemoved: 0,
  crossBoundary: 0, agentFiles: 0, humanFiles: 0,
}

function claim(overrides = {}) {
  return {
    id: 'c1', kind: 'system.coupling', title: 'Api now depends on Storage',
    subtitle: '2 call sites', severity: 7, score: 8.5, actor: 'agent', ts: 10,
    createsCycle: false, internal: false, evidence: [], ...overrides,
  }
}

function summary(overrides = {}) {
  return {
    since: 0, until: 1000, files: [], edges: [], systems: [], claims: [],
    sessions: [], counts: { ...emptyCounts }, empty: false, ...overrides,
  }
}

test('a null delta is an empty review', () => {
  const review = buildDeltaReview(null, new Set())
  assert.equal(review.empty, true)
  assert.equal(review.claims.length, 0)
})

test('internal churn is held back from the main list', () => {
  const review = buildDeltaReview(summary({
    claims: [
      claim({ id: 'c1' }),
      claim({ id: 'c2', kind: 'system.internal', internal: true, title: 'Api · 3 files edited' }),
    ],
  }), new Set())

  assert.equal(review.claims.length, 1, 'only the boundary claim is shown by default')
  assert.equal(review.internalClaims.length, 1, 'internal churn is available on request')
  assert.equal(review.empty, false)
})

test('a delta of nothing but internal churn says so', () => {
  const review = buildDeltaReview(summary({
    claims: [claim({ kind: 'system.internal', internal: true })],
  }), new Set())
  assert.equal(deltaHeadline(review), 'Internal changes only')
})

test('the headline counts claims, not raw events', () => {
  const review = buildDeltaReview(summary({
    claims: [claim({ id: 'a' }), claim({ id: 'b' })],
  }), new Set())
  assert.equal(deltaHeadline(review), '2 changes to review')
})

test('a cycle is called out in the headline', () => {
  const review = buildDeltaReview(summary({
    claims: [claim({ createsCycle: true }), claim({ id: 'b' })],
  }), new Set())
  assert.equal(deltaHeadline(review), '2 changes to review · 1 cycle')
})

test('a boundary claim frames both systems, not its files', () => {
  const focus = claimFocusTargets(
    claim({ focusSystemIds: ['sysA', 'sysB'], focusFileIds: ['f1', 'f2'] }),
    new Set(['sysA', 'sysB', 'f1', 'f2']),
  )
  assert.deepEqual(focus, ['sysA', 'sysB'])
})

test('a claim with no system context falls back to its files', () => {
  const focus = claimFocusTargets(
    claim({ kind: 'file.unclassified', focusFileIds: ['f1'] }),
    new Set(['f1']),
  )
  assert.deepEqual(focus, ['f1'])
})

test('focus never points at nodes the canvas does not have', () => {
  const focus = claimFocusTargets(claim({ focusSystemIds: ['ghost'] }), new Set(['real']))
  assert.deepEqual(focus, [])
})

test('ghosting lights the subject, its contents, and its containers', () => {
  const nodes = [
    { id: 'sysA', data: {} },
    { id: 'fileA', parentId: 'sysA', data: {} },
    { id: 'sysB', data: {} },
    { id: 'inner', parentId: 'sysB', data: {} },
    { id: 'deep', parentId: 'inner', data: {} },
    { id: 'unrelated', data: {} },
    { id: 'unrelatedChild', parentId: 'unrelated', data: {} },
  ]
  const review = buildDeltaReview(summary(), new Set())
  const out = applyDeltaMarks(nodes, review, ['sysA', 'inner'])
  const byId = Object.fromEntries(out.map(node => [node.id, node]))

  assert.equal(byId.sysA.data.dimmed, undefined, 'the subject stays lit')
  assert.equal(byId.fileA.data.dimmed, undefined, 'contents of the subject stay lit')
  assert.equal(byId.inner.data.dimmed, undefined)
  assert.equal(byId.deep.data.dimmed, undefined, 'nested contents stay lit')
  assert.equal(byId.sysB.data.dimmed, undefined, 'the container around the subject stays lit')
  assert.equal(byId.unrelated.data.dimmed, true, 'everything else recedes')
  assert.equal(byId.unrelatedChild.data.dimmed, true)
})

test('marks survive alongside ghosting and keep existing node data', () => {
  const review = buildDeltaReview(summary({
    files: [{
      id: 'f1', relPath: 'a.py', change: 'created', actor: 'agent', saves: 0, ts: 1,
      systemName: 'Storage',
    }],
  }), new Set(['f1']))

  const nodes = [{ id: 'f1', data: { label: 'a' } }, { id: 'f2', data: {} }]
  const out = applyDeltaMarks(nodes, review, ['f1'])

  assert.equal(out[0].data.deltaMark, 'created')
  assert.equal(out[0].data.deltaFocused, true)
  assert.equal(out[0].data.label, 'a', 'existing node data survives')
  assert.equal(out[1].data.dimmed, true)
})

test('projection is a no-op with nothing to mark and nothing focused', () => {
  const nodes = [{ id: 'f1', data: {} }]
  const review = buildDeltaReview(null, new Set())
  assert.equal(applyDeltaMarks(nodes, review, []), nodes)
})

test('deleted files become tombstones, never marks', () => {
  const review = buildDeltaReview(summary({
    files: [{ id: 'gone', relPath: 'gone.py', change: 'deleted', actor: 'agent', saves: 0, ts: 1 }],
  }), new Set(['gone']))
  assert.equal(review.marks.size, 0)
  assert.equal(review.tombstones.length, 1)
})

test('the review window reads in human time', () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0)
  assert.equal(deltaWindow(0, now), 'since your last review')
  assert.equal(deltaWindow(now - 3 * 24 * 3600_000, now), 'over the last 3 days')
  assert.match(deltaWindow(now - 3600_000, now), /^since /)
})

test('attribution distinguishes agent work from your own', () => {
  assert.equal(deltaAttribution({ ...emptyCounts, agentFiles: 3 }), 'by your agents')
  assert.equal(deltaAttribution({ ...emptyCounts, humanFiles: 3 }), 'by you')
  assert.equal(deltaAttribution({ ...emptyCounts, agentFiles: 1, humanFiles: 1 }), 'by you and your agents')
})

test('a claim inherits the agent account of the work that produced it', () => {
  const review = buildDeltaReview(summary({
    claims: [claim({ sessionId: 'w1' })],
    sessions: [{
      id: 'w1', workspaceId: 'ws', agent: 'antigravity',
      goal: 'Add write-through caching', summary: 'handlers now read through TaskStore',
      notes: [], startedAt: 0, endedAt: 100,
    }],
  }), new Set())

  assert.equal(claimRationale(review.claims[0], review), 'handlers now read through TaskStore')
})

test('an in-flight session explains itself with its goal', () => {
  const review = buildDeltaReview(summary({
    claims: [claim({ sessionId: 'w1' })],
    sessions: [{
      id: 'w1', workspaceId: 'ws', goal: 'Refactor auth', summary: '',
      notes: [], startedAt: 0, endedAt: 0,
    }],
  }), new Set())

  assert.equal(claimRationale(review.claims[0], review), 'Refactor auth')
})

test('an unnarrated change has no rationale to show', () => {
  const review = buildDeltaReview(summary({ claims: [claim()] }), new Set())
  assert.equal(claimRationale(review.claims[0], review), null)
})

test('cursor clamps inside the claim list', () => {
  assert.equal(clampClaimCursor([claim()], -5), 0)
  assert.equal(clampClaimCursor([claim()], 99), 0)
  assert.equal(clampClaimCursor([], 0), -1)
})
