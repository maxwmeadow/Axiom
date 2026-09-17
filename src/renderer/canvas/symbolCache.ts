import {
  recordSymbolCacheHit,
  recordSymbolDeduplication,
  recordSymbolFetch,
} from './perfMetrics.ts'

/** In-memory cache for file symbols keyed by `${workspaceId}:${fileId}` */
const symbolCache = new Map<string, any[]>()

/** In-flight request promises for deduplicating concurrent fetches */
const inFlightRequests = new Map<string, Promise<any[]>>()

function cacheKey(workspaceId: string, fileId: string): string {
  return `${workspaceId}:${fileId}`
}

export function getCachedSymbols(workspaceId: string, fileId: string): any[] | null {
  const key = cacheKey(workspaceId, fileId)
  const cached = symbolCache.get(key)
  if (cached) {
    recordSymbolCacheHit()
    return cached
  }
  return null
}

export function setCachedSymbols(workspaceId: string, fileId: string, symbols: any[]): void {
  const key = cacheKey(workspaceId, fileId)
  symbolCache.set(key, symbols)
}

export function clearSymbolCache(workspaceId?: string): void {
  if (!workspaceId) {
    symbolCache.clear()
    inFlightRequests.clear()
    return
  }
  const prefix = `${workspaceId}:`
  for (const key of symbolCache.keys()) {
    if (key.startsWith(prefix)) symbolCache.delete(key)
  }
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) inFlightRequests.delete(key)
  }
}

export async function fetchFileSymbols(
  workspaceId: string,
  fileId: string,
  signal?: AbortSignal,
  baseUrl = 'http://127.0.0.1:7744',
): Promise<any[]> {
  const key = cacheKey(workspaceId, fileId)

  // 1. Synchronous cache hit
  const cached = symbolCache.get(key)
  if (cached) {
    recordSymbolCacheHit()
    return cached
  }

  // 2. In-flight request deduplication
  const inFlight = inFlightRequests.get(key)
  if (inFlight) {
    recordSymbolDeduplication()
    return inFlight
  }

  // 3. Dispatch new network fetch
  recordSymbolFetch()
  const requestPromise = (async () => {
    try {
      const url = `${baseUrl}/api/files/${fileId}/symbols?workspace=${encodeURIComponent(workspaceId)}`
      const res = await fetch(url, { signal })
      if (!res.ok) throw new Error(`symbols request failed with status ${res.status}`)
      const data = await res.json()
      const symbols = Array.isArray(data) ? data : []
      symbolCache.set(key, symbols)
      return symbols
    } finally {
      inFlightRequests.delete(key)
    }
  })()

  inFlightRequests.set(key, requestPromise)
  return requestPromise
}
