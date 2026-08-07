import assert from 'node:assert/strict'
import test from 'node:test'

import { findWorktreeForCwd } from './worktreeContext.ts'

test('resolves a nested agent cwd to its worktree regardless of slash or case', () => {
  const context = findWorktreeForCwd([
    { id: 'primary', path: 'C:\\Code\\Axiom', branch: 'main' },
    { id: 'agent', path: 'C:\\Code\\Axiom-agent', branch: 'feature/agent' },
  ], 'c:/code/AXIOM-agent/packages/payments', false)
  assert.deepEqual(context, { rootId: 'agent', branch: 'feature/agent' })
})

test('keeps case-distinct worktrees separate on case-sensitive hosts', () => {
  const roots = [
    { id: 'upper', path: '/code/Axiom-agent', branch: 'feature/upper' },
    { id: 'lower', path: '/code/axiom-agent', branch: 'feature/lower' },
  ]
  assert.deepEqual(
    findWorktreeForCwd(roots, '/code/Axiom-agent/src', true),
    { rootId: 'upper', branch: 'feature/upper' },
  )
  assert.deepEqual(
    findWorktreeForCwd(roots, '/code/axiom-agent/src', true),
    { rootId: 'lower', branch: 'feature/lower' },
  )
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
