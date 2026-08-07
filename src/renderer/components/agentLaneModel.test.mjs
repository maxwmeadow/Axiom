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
