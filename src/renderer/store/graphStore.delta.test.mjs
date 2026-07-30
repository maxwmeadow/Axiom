import assert from 'node:assert/strict'
import test from 'node:test'
import { useGraphStore } from './graphStore.ts'

function project(id) {
  return {
    id,
    name: id,
    rootPath: `/${id}`,
    ignoredPaths: [],
    languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
    openedAt: 0,
  }
}

function summary(workspaceId, until) {
  return {
    workspaceId,
    since: 0,
    until,
    empty: false,
    counts: {},
    claims: [],
    sessions: [],
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('overlapping delta refreshes share one request', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let release
  globalThis.fetch = () => {
    calls += 1
    return new Promise(resolve => {
      release = () => resolve(jsonResponse(summary('alpha', 10)))
    })
  }

  try {
    useGraphStore.getState().setCurrentProject(project('alpha'))
    const first = useGraphStore.getState().loadDelta()
    const second = useGraphStore.getState().loadDelta()
    assert.equal(calls, 1)

    release()
    await Promise.all([first, second])
    assert.equal(useGraphStore.getState().delta.workspaceId, 'alpha')
  } finally {
    useGraphStore.getState().setCurrentProject(null)
    globalThis.fetch = originalFetch
  }
})

test('a late response from the previous workspace cannot replace the current delta', async () => {
  const originalFetch = globalThis.fetch
  const releases = new Map()
  globalThis.fetch = url => new Promise(resolve => {
    const workspaceId = new URL(url).searchParams.get('workspace')
    releases.set(workspaceId, until => resolve(jsonResponse(summary(workspaceId, until))))
  })

  try {
    useGraphStore.getState().setCurrentProject(project('alpha'))
    const alphaLoad = useGraphStore.getState().loadDelta()
    useGraphStore.getState().setCurrentProject(project('beta'))
    const betaLoad = useGraphStore.getState().loadDelta()

    releases.get('beta')(20)
    await betaLoad
    releases.get('alpha')(10)
    await alphaLoad

    assert.equal(useGraphStore.getState().delta.workspaceId, 'beta')
    assert.equal(useGraphStore.getState().delta.until, 20)
  } finally {
    useGraphStore.getState().setCurrentProject(null)
    globalThis.fetch = originalFetch
  }
})

test('focus refresh waits until an active review closes', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls += 1
    return Promise.resolve(jsonResponse(summary('alpha', 30)))
  }

  try {
    useGraphStore.getState().setCurrentProject(project('alpha'))
    useGraphStore.setState({
      delta: summary('alpha', 10),
      deltaReviewing: true,
      deltaCursor: 0,
    })

    await useGraphStore.getState().loadDelta()
    assert.equal(calls, 0)
    assert.equal(useGraphStore.getState().delta.until, 10)

    useGraphStore.getState().endDeltaReview(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(useGraphStore.getState().delta.until, 30)
  } finally {
    useGraphStore.getState().setCurrentProject(null)
    globalThis.fetch = originalFetch
  }
})
