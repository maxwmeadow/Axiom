import assert from 'node:assert/strict'
import test from 'node:test'

import { findWorktreeForCwd } from './worktreeContext.ts'

test('resolves a nested agent cwd to its worktree regardless of slash or case', () => {
  const context = findWorktreeForCwd([
    { id: 'primary', path: 'C:\\Code\\Axiom', branch: 'main' },
    { id: 'agent', path: 'C:\\Code\\Axiom-agent', branch: 'feature/agent' },
  ], 'c:/code/AXIOM-agent/packages/payments')
  assert.deepEqual(context, { rootId: 'agent', branch: 'feature/agent' })
})

test('uses path boundaries and the longest nested root', () => {
  const roots = [
    { id: 'outer', path: '/code/project', branch: 'main' },
    { id: 'nested', path: '/code/project/vendor/tool', branch: 'vendor-work' },
  ]
  assert.deepEqual(
    findWorktreeForCwd(roots, '/code/project/vendor/tool/src'),
    { rootId: 'nested', branch: 'vendor-work' },
  )
  assert.equal(findWorktreeForCwd(roots, '/code/project-copy/src'), undefined)
})
