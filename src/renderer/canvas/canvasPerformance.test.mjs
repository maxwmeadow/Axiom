import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LARGE_SCENE_NODE_COUNT,
  shouldAnimateIndividualClassification,
  shouldDeferCanvasMaterialization,
} from './canvasPerformance.ts'

test('defers a large unstable file-only projection while classification is running', () => {
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: true,
    fileCount: 805,
    classifiedFileCount: 0,
    systemCount: 0,
    floorLayoutCount: 0,
  }), true)
})

test('large classification snapshots use container choreography instead of every file', () => {
  assert.equal(shouldAnimateIndividualClassification(12), true)
  assert.equal(shouldAnimateIndividualClassification(LARGE_SCENE_NODE_COUNT), true)
  assert.equal(shouldAnimateIndividualClassification(805), false)
})

test('materializes as soon as large-project classification becomes stable', () => {
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: true,
    fileCount: 805,
    classifiedFileCount: 805,
    systemCount: 24,
    floorLayoutCount: 0,
  }), false)
})

test('does not trust classified ids until their system snapshot is present', () => {
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: true,
    fileCount: 805,
    classifiedFileCount: 805,
    systemCount: 0,
    floorLayoutCount: 0,
  }), true)
})

test('does not hide deliberate unclassified files after indexing finishes', () => {
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: false,
    fileCount: 805,
    classifiedFileCount: 0,
    systemCount: 0,
    floorLayoutCount: 0,
  }), false)
})

test('does not delay small or already-authored Floors', () => {
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: true,
    fileCount: LARGE_SCENE_NODE_COUNT,
    classifiedFileCount: 0,
    systemCount: 0,
    floorLayoutCount: 0,
  }), false)
  assert.equal(shouldDeferCanvasMaterialization({
    isIndexing: true,
    fileCount: 805,
    classifiedFileCount: 0,
    systemCount: 0,
    floorLayoutCount: 1,
  }), false)
})
