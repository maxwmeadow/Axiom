// In-memory performance metrics harness for diagnostic tracing and automated benchmarks.

export interface AxiomPerfMetrics {
  resizerMounts: number
  resizerRenderCount: number
  symbolFetches: number
  symbolCacheHits: number
  symbolDeduplicatedRequests: number
}

const metrics: AxiomPerfMetrics = {
  resizerMounts: 0,
  resizerRenderCount: 0,
  symbolFetches: 0,
  symbolCacheHits: 0,
  symbolDeduplicatedRequests: 0,
}

if (typeof globalThis !== 'undefined') {
  ;(globalThis as any).__axiomPerfMetrics = metrics
}

export function getPerfMetrics(): AxiomPerfMetrics {
  return metrics
}

export function resetPerfMetrics(): void {
  metrics.resizerMounts = 0
  metrics.resizerRenderCount = 0
  metrics.symbolFetches = 0
  metrics.symbolCacheHits = 0
  metrics.symbolDeduplicatedRequests = 0
}

export function recordResizerRender(): void {
  metrics.resizerRenderCount++
}

export function recordResizerMount(delta: 1 | -1): void {
  metrics.resizerMounts += delta
}

export function recordSymbolFetch(): void {
  metrics.symbolFetches++
}

export function recordSymbolCacheHit(): void {
  metrics.symbolCacheHits++
}

export function recordSymbolDeduplication(): void {
  metrics.symbolDeduplicatedRequests++
}

