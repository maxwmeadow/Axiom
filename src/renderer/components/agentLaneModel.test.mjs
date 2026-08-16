import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentLaneModel } from './agentLaneModel.ts'

function branch(overrides = {}) {
  return {
    rootId: 'root-main', branch: 'main', headCommit: '1234567890', isPrimary: true,
    touchedSystems: [], unclassifiedFiles: [], activeWork: [], ...overrides,
  }
}

function snapshot(branches, collisions = []) {
  return { workspaceId: 'ws', generatedAt: 1, branches, collisions }
}

test('a single-root project has no new visible surface', () => {
  const model = buildAgentLaneModel(snapshot([
    branch({ activeWork: [{ sessionId: 'one', agent: 'codex', goal: 'Existing work', startedAt: 1 }] }),
  ]))
  assert.equal(model.visible, false)
  assert.equal(model.agentCount, 1)
})

test('parallel agents stay attributed to their own worktree branches', () => {
  const model = buildAgentLaneModel(snapshot([
    branch({
      activeWork: [{ sessionId: 'a', agent: 'codex', goal: 'Change storage', startedAt: 1 }],
      touchedSystems: [{ systemId: 'db', systemName: 'Storage', files: ['db.go'], claims: [] }],
    }),
    branch({
      rootId: 'root-ui', branch: 'agent/ui', headCommit: 'abcdef1234', isPrimary: false,
      activeWork: [{ sessionId: 'b', agent: 'claude', goal: 'Build lane', startedAt: 2 }],
      touchedSystems: [], unclassifiedFiles: ['AgentLane.tsx'],
    }),
  ]))

  assert.equal(model.visible, true)
  assert.equal(model.agentCount, 2)
  assert.deepEqual(model.branches.map(item => [item.name, item.agents[0].name]), [
    ['main', 'codex'], ['agent/ui', 'claude'],
  ])
  assert.deepEqual(model.branches.map(item => [item.boundaryCount, item.fileCount]), [[1, 1], [0, 1]])
})

test('a semantic collision names the system and both branches before merge', () => {
  const model = buildAgentLaneModel(snapshot([
    branch(),
    branch({ rootId: 'root-payments', branch: 'agent/payments', isPrimary: false }),
  ], [{
    systemId: 'payments', systemName: 'Payments', branches: [
      { rootId: 'root-main', branch: 'main', files: ['charge.go'], claims: [] },
      {
        rootId: 'root-payments', branch: 'agent/payments', files: ['refund.go', 'tax.go'],
        claims: [{ id: 'claim', kind: 'system.internal', title: 'Refund path changed', internal: false }],
      },
    ],
  }]))

  assert.equal(model.collisions[0].systemName, 'Payments')
  assert.deepEqual(model.collisions[0].branches.map(item => item.name), ['main', 'agent/payments'])
  assert.deepEqual(model.collisions[0].branches.map(item => item.fileCount), [1, 2])
  assert.equal(model.collisions[0].branches[1].claim, 'Refund path changed')
})

test('the per-branch briefing stays with the worktree it describes', () => {
  const branches = [
    branch(),
    branch({ rootId: 'root-ui', branch: 'agent/ui', isPrimary: false }),
  ]
  const model = buildAgentLaneModel(snapshot(branches), {
    workspaceId: 'ws',
    branches: [
      { rootId: 'root-main', unreviewedClaims: 0, unexplained: 0, unexpected: 0 },
      { rootId: 'root-ui', unreviewedClaims: 4, unexplained: 2, unexpected: 1 },
    ],
  })

  assert.deepEqual(
    model.branches.map(item => [item.name, item.unreviewed, item.unexplained, item.unexpected]),
    [['main', 0, 0, 0], ['agent/ui', 4, 2, 1]],
  )
})

// A snapshot arrives over HTTP, so its type is a promise the compiler cannot
// keep. Reading .map off a missing array threw inside a useMemo, which React
// escalates into a render failure - the whole workbench went to a blank
// "Render Error" screen because one panel got an unexpected response body.
test('a shapeless response hides the lane instead of blanking the workbench', () => {
  for (const bad of [{}, { branches: null }, { branches: undefined }]) {
    const model = buildAgentLaneModel(bad, null)
    assert.equal(model.visible, false)
    assert.deepEqual(model.branches, [])
    assert.deepEqual(model.collisions, [])
  }
})

test('a branch missing its optional lists still renders', () => {
  const model = buildAgentLaneModel({
    branches: [
      { rootId: 'a', branch: 'main', headCommit: 'abcdef1234', isPrimary: true },
      { rootId: 'b', branch: 'feat', headCommit: 'beef567890', isPrimary: false },
    ],
  }, null)

  assert.equal(model.visible, true)
  assert.equal(model.branchCount, 2)
  assert.equal(model.agentCount, 0)
  assert.equal(model.branches[0].boundaryCount, 0)
  assert.equal(model.branches[0].fileCount, 0)
  assert.equal(model.branches[0].head, 'abcdef1')
})

test('a branch with no name or commit still gets a readable label', () => {
  const model = buildAgentLaneModel({
    branches: [{ rootId: 'a' }, { rootId: 'b' }],
  }, null)

  assert.equal(model.branches[0].name, 'detached@unknown')
  assert.equal(model.branches[0].head, '')
})

test('a malformed collision does not take the lane down with it', () => {
  const model = buildAgentLaneModel({
    branches: [
      { rootId: 'a', branch: 'main', headCommit: 'aaaaaaa', isPrimary: true },
      { rootId: 'b', branch: 'feat', headCommit: 'bbbbbbb', isPrimary: false },
    ],
    collisions: [{ systemId: 's', systemName: 'Payments' }],
  }, null)

  assert.equal(model.collisions.length, 1)
  assert.deepEqual(model.collisions[0].branches, [])
})
