import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeSourceBoundaries,
  mergePersistedProjectConfig,
  projectUsesBlankSetup,
  resolveProjectSourceBoundaries,
  sourceBoundariesAreComplete,
} from './projectLifecycle.ts'

test('blank setup requires both the New Project button and an empty folder', () => {
  assert.equal(projectUsesBlankSetup({ creationSource: 'new-project', rootIsEmpty: true }), true)
  assert.equal(projectUsesBlankSetup({ creationSource: 'new-project', rootIsEmpty: false }), false)
  assert.equal(projectUsesBlankSetup({ creationSource: 'open-codebase', rootIsEmpty: true }), false)
  assert.equal(projectUsesBlankSetup({ rootIsEmpty: true }), false)
})

function project(overrides = {}) {
  return {
    id: 'project',
    name: 'Project',
    rootPath: 'C:/project',
    ignoredPaths: [],
    languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
    openedAt: 1,
    ...overrides,
  }
}

test('an empty exclusion list is a completed source-boundary choice', () => {
  const completed = completeSourceBoundaries(project(), [], 100)
  assert.equal(sourceBoundariesAreComplete(completed), true)
  assert.deepEqual(completed.ignoredPaths, [])
})

test('opening the same folder cannot erase persisted boundaries', () => {
  const persisted = completeSourceBoundaries(project({
    ignoredPaths: ['C:/project/generated/**'],
  }), ['C:/project/generated/**'], 100)
  const freshDialogResult = project({ openedAt: 200, ignoredPaths: [] })
  const merged = mergePersistedProjectConfig(persisted, freshDialogResult)

  assert.equal(merged.sourceBoundariesReviewedAt, 100)
  assert.deepEqual(merged.ignoredPaths, ['C:/project/generated/**'])
  assert.equal(merged.openedAt, 200)
})

test('a previously indexed legacy project is migrated without another prompt', () => {
  const resolved = resolveProjectSourceBoundaries(project({
    ignoredPaths: ['C:/project/generated/**'],
  }), {
    indexed: true,
    ignoredPaths: [],
    sourceBoundariesReviewedAt: null,
  }, 300)

  assert.ok(resolved)
  assert.equal(resolved.sourceBoundariesReviewedAt, 300)
  assert.deepEqual(resolved.ignoredPaths, ['C:/project/generated/**'])
})

test('a non-empty unindexed codebase still receives exactly one setup', () => {
  const unresolved = resolveProjectSourceBoundaries(project(), {
    indexed: false,
    ignoredPaths: [],
    sourceBoundariesReviewedAt: null,
  }, 300)

  assert.equal(unresolved, null)
})
