import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEPTH_TITLE_PX,
  FRAME_ITEM_GAP,
  contentRectFor,
  frameChromeBand,
  frameContentInsets,
} from './frameGeometry.ts'
import { systemTabChrome, systemTabHeight } from './systemChrome.ts'

/**
 * Six different numbers used to express "the gap": 12, 28, 36, 42, 54, 96.
 * The same arrangement packed differently depending on which code path
 * produced it. These tests exist so that can't come back.
 */

test('three sides are exactly one gap, with no path-specific padding', () => {
  const insets = frameContentInsets(420, 0)
  assert.equal(insets.left, FRAME_ITEM_GAP)
  assert.equal(insets.right, FRAME_ITEM_GAP)
  assert.equal(insets.bottom, FRAME_ITEM_GAP)
})

test('the top is the tab band plus that same gap - the only asymmetry', () => {
  for (const depth of [0, 1, 2, 3]) {
    const insets = frameContentInsets(420, depth)
    const band = frameChromeBand(420, depth)
    assert.equal(insets.top, band + FRAME_ITEM_GAP,
      `depth ${depth}: the top inset must clear the tab and then match every other side`)
    assert.ok(insets.top > insets.bottom,
      `depth ${depth}: a system frame's top border is not where its usable space begins`)
  }
})

test('the reserved band IS the tab the chrome actually draws', () => {
  // The bug this replaces: layout reserved `padY*2 + titlePx*1.25` (~52 on a
  // default frame) while the tab drew at `depthTitlePx * 0.95` (~23), so the
  // gap above the first child was ~4x the gap on every other side.
  for (const depth of [0, 1, 2, 3]) {
    for (const height of [220, 420, 900]) {
      const drawn = systemTabChrome({
        shellWidth: 620,
        shellHeight: height,
        depthTitlePx: DEPTH_TITLE_PX[depth],
        titlePx: DEPTH_TITLE_PX[depth],
        title: 'Priority',
        count: 2,
        frameStroke: 1,
      }).tabHeight
      assert.equal(frameChromeBand(height, depth), drawn,
        `depth ${depth} at ${height}: layout must reserve exactly the drawn tab`)
    }
  }
})

test('the gap above the first child equals the gap on every other side', () => {
  for (const depth of [0, 1, 2, 3]) {
    const insets = frameContentInsets(420, depth)
    const tab = systemTabHeight(DEPTH_TITLE_PX[depth], 420)
    assert.ok(Math.abs(insets.top - tab - insets.right) < 1e-9,
      `depth ${depth}: clearance below the tab must match the side gap`)
    assert.ok(Math.abs(insets.top - tab - insets.bottom) < 1e-9)
  }
})

test('a frame nested at half scale spends twice the canonical height on its tab', () => {
  // The tab draws at a fixed RENDERED size per depth, so its canonical cost
  // doubles when the frame renders at half size.
  assert.equal(frameChromeBand(420, 0, 0.5), frameChromeBand(420, 0, 1) * 2)
})

test('the content box is the frame minus exactly those insets', () => {
  const insets = frameContentInsets(700, 0)
  const box = contentRectFor({ width: 900, height: 700 }, 0)
  assert.equal(box.x, insets.left)
  assert.equal(box.y, insets.top)
  assert.equal(box.width, 900 - insets.left - insets.right)
  assert.equal(box.height, 700 - insets.top - insets.bottom)
})

test('a frame too small for its own chrome still yields a usable box', () => {
  const box = contentRectFor({ width: 40, height: 20 }, 0)
  assert.ok(box.width >= 1 && box.height >= 1)
})
