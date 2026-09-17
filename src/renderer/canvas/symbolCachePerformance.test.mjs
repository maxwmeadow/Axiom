import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearSymbolCache,
  fetchFileSymbols,
  getCachedSymbols,
  setCachedSymbols,
} from './symbolCache.ts'
import { getPerfMetrics, resetPerfMetrics } from './perfMetrics.ts'

test('symbol cache performance: eliminates thundering herd and provides 100% cache hits on repeat zoom', async () => {
  resetPerfMetrics()
  clearSymbolCache()

  const WORKSPACE = 'test-workspace'
  const FILE_COUNT = 50

  // Mock global fetch
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async (url) => {
    networkCalls++
    return {
      ok: true,
      status: 200,
      json: async () => [
        { name: 'processData', kind: 'function', lineStart: 10, lineEnd: 25 },
        { name: 'ConfigModel', kind: 'class', lineStart: 30, lineEnd: 60 },
      ],
    }
  }

  try {
    // ─── First Zoom: Detail reveal across 50 files ────────────────────────────
    const firstZoomPromises = []
    for (let i = 0; i < FILE_COUNT; i++) {
      firstZoomPromises.push(fetchFileSymbols(WORKSPACE, `file-${i}`))
    }
    const firstResults = await Promise.all(firstZoomPromises)
    assert.equal(firstResults.length, FILE_COUNT)
    assert.equal(networkCalls, 50, 'Initial zoom should dispatch 50 fetches')
    assert.equal(getPerfMetrics().symbolFetches, 50)
    assert.equal(getPerfMetrics().symbolCacheHits, 0)

    // ─── Second Zoom: User zoomed out, then zoomed back in ───────────────────
    // Before optimization: 50 new fetches dispatched.
    // After optimization: 0 fetches, 50 synchronous cache hits.
    const networkCallsBeforeSecondZoom = networkCalls
    const secondZoomResults = []
    for (let i = 0; i < FILE_COUNT; i++) {
      const cached = getCachedSymbols(WORKSPACE, `file-${i}`)
      assert.notEqual(cached, null, `file-${i} should be cached synchronously`)
      secondZoomResults.push(cached)
    }

    assert.equal(networkCalls, networkCallsBeforeSecondZoom, 'Repeat zoom must make 0 network calls')
    assert.equal(getPerfMetrics().symbolCacheHits, 50, 'Repeat zoom must register 50 cache hits')

    // ─── Concurrent Deduplication ───────────────────────────────────────────
    // If 10 components concurrently request an uncached file in the same tick:
    const networkCallsBeforeDedup = networkCalls
    const dedupPromises = []
    for (let i = 0; i < 10; i++) {
      dedupPromises.push(fetchFileSymbols(WORKSPACE, 'concurrent-file-99'))
    }
    const dedupResults = await Promise.all(dedupPromises)
    assert.equal(dedupResults.length, 10)
    assert.equal(networkCalls, networkCallsBeforeDedup + 1, 'Only 1 network request dispatched for 10 concurrent callers')
    assert.equal(getPerfMetrics().symbolDeduplicatedRequests, 9, '9 callers reused the in-flight promise')

  } finally {
    globalThis.fetch = originalFetch
  }
})

