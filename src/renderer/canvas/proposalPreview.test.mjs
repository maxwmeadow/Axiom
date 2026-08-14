import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProposalPreviewModel } from './proposalPreview.ts'

const proposal = {
  id: 'proposal-1',
  workspaceId: 'workspace-1',
  currentRevision: 1,
  createdAt: 10,
  systems: [
    {
      systemKey: 'core', name: 'Core', parentRefType: 'scope', parentRefId: null,
      depth: 0, decision: 'pending', fileCount: 1, affectedFileCount: 1,
    },
    {
      systemKey: 'docs', name: 'Documentation', parentRefType: 'proposed_system', parentRefId: 'core',
      depth: 1, decision: 'pending', fileCount: 1, affectedFileCount: 1,
    },
  ],
  memberships: [
    {
      id: 'membership-1', fileId: null, rootId: 'root-1', filePath: 'README.md',
      targetSystemKey: 'docs', disposition: 'assign',
    },
  ],
}

test('proposal preview preserves proposed nesting and Markdown memberships', () => {
  const preview = buildProposalPreviewModel(proposal, [], [])
  const core = preview.systems.find(system => system.name === 'Core')
  const docs = preview.systems.find(system => system.name === 'Documentation')

  assert.ok(core)
  assert.ok(docs)
  assert.equal(docs.parentId, core.id)
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0].systemId, docs.id)
  assert.equal(preview.files[0].language, 'markdown')
  assert.equal(preview.files[0].relPath, 'README.md')
  assert.match(core.id, /^proposal:proposal-1:/)
})

test('proposal preview clones indexed metadata without reusing canonical identity', () => {
  const indexed = {
    id: 'canonical-file', rootId: 'root-1', path: 'C:/repo/README.md', relPath: 'README.md',
    language: 'markdown', systemId: null, lineCount: 42, churnScore: 0.3,
    positionX: 100, positionY: 200, indexedAt: 12,
  }
  const withFileId = {
    ...proposal,
    memberships: [{ ...proposal.memberships[0], fileId: indexed.id }],
  }
  const preview = buildProposalPreviewModel(withFileId, [], [indexed])

  assert.notEqual(preview.files[0].id, indexed.id)
  assert.equal(preview.files[0].lineCount, 42)
  assert.equal(preview.files[0].path, indexed.path)
})

test('a system-scoped proposal keeps scope roots inside the live coordinate frame', () => {
  const live = {
    id: 'live-parent', workspaceId: 'workspace-1', name: 'Existing Boundary', parentId: null,
    source: 'user', color: null, description: null, agentNotes: null, depth: 0,
    positionX: 0, positionY: 0, width: 800, height: 600, createdAt: 1, updatedAt: 1,
  }
  const scoped = {
    ...proposal,
    parentScopeType: 'system',
    parentScopeId: live.id,
    layouts: [{
      nodeType: 'system', nodeKey: 'core', parentRefType: 'scope', parentRefId: '',
      positionX: 20, positionY: 40, width: 500, height: 300, scale: 1, interiorScale: 1,
    }],
  }
  const preview = buildProposalPreviewModel(scoped, [live], [])
  const core = preview.systems.find(system => system.name === 'Core')
  const coreLayout = preview.layouts.find(layout => layout.nodeId === core.id)

  assert.equal(core.parentId, live.id)
  assert.equal(coreLayout.parentNodeId, live.id)
})
