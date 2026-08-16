import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MONO_ADVANCE_EM,
  chipStrokeWidth,
  TITLE_LINE_HEIGHT,
  monoFontFittingWidth,
  monoTextWidth,
  systemTabChrome,
} from './systemChrome.ts'

// The space a real Floor actually produces: narrow/wide, short/tall, shallow
// and deeply nested, one digit through three, short names and long ones.
const WIDTHS = [180, 260, 360, 520, 760, 1100, 1600]
const HEIGHTS = [140, 220, 320, 480, 700, 1000]
const TITLE_PX = [11, 14, 18, 24]
const NAMES = ['Api', 'Service', 'Main', 'NotificationsPlatform']
const COUNTS = [0, 1, 3, 12, 148]

function* sweep() {
  for (const shellWidth of WIDTHS) {
    for (const shellHeight of HEIGHTS) {
      for (const titlePx of TITLE_PX) {
        for (const title of NAMES) {
          for (const count of COUNTS) {
            yield {
              shellWidth,
              shellHeight,
              titlePx,
              depthTitlePx: titlePx,
              frameStroke: 1,
              title,
              count,
            }
          }
        }
      }
    }
  }
}

const describe = input =>
  `${input.shellWidth}x${input.shellHeight} ` +
  `titlePx=${input.titlePx} name=${input.title} count=${input.count}`

test('no title or count is ever clipped by its own band', () => {
  for (const input of sweep()) {
    const chrome = systemTabChrome(input)
    const where = describe(input)

    // The band must fit each line box. Sizing a font to the raw band height
    // ignores line-height and shears the top off the glyphs.
    assert.ok(
      chrome.titleFont * TITLE_LINE_HEIGHT <= chrome.bandHeight + 1e-9,
      `title line box overflows its band at ${where}`,
    )
    if (chrome.hasChip) {
      assert.ok(
        chrome.chipFont * TITLE_LINE_HEIGHT <= chrome.bandHeight + 1e-9,
        `chip line box overflows its band at ${where}`,
      )
      // The number must fit between the chip's own borders.
      const textWidth = monoTextWidth(String(input.count), chrome.chipFont)
      assert.ok(
        textWidth < chrome.chipWidth,
        `count ${input.count} overflows its chip at ${where}`,
      )
    }
  }
})

test('the chip always sits inside the tab, clear of the slanted cut', () => {
  for (const input of sweep()) {
    const chrome = systemTabChrome(input)
    if (!chrome.hasChip) continue
    const where = describe(input)

    const slope = chrome.tabSlant / Math.max(chrome.tabHeight - 1, 1)
    const tabEdgeAt = y => chrome.tabWidth + slope * (y - 1)

    assert.ok(
      chrome.chipTopRight <= tabEdgeAt(chrome.bandTop) + 1e-9,
      `chip crosses the tab cut at its top at ${where}`,
    )
    assert.ok(
      chrome.chipBottomRight <= tabEdgeAt(chrome.tabHeight) + 1e-9,
      `chip crosses the tab cut at its bottom at ${where}`,
    )
    assert.ok(chrome.chipLeft > 0, `chip runs off the tab's left edge at ${where}`)
    assert.ok(
      chrome.bandTop >= 1 && chrome.tabHeight > chrome.bandTop,
      `degenerate band at ${where}`,
    )
  }
})

test('the title never runs under the chip', () => {
  for (const input of sweep()) {
    const chrome = systemTabChrome(input)
    if (!chrome.hasChip) continue
    assert.ok(
      chrome.titleLeft + chrome.titleWidth <= chrome.chipLeft + 1e-9,
      `title overlaps the chip at ${describe(input)}`,
    )
  }
})

test('the tab never exceeds the shell it is drawn on', () => {
  for (const input of sweep()) {
    const chrome = systemTabChrome(input)
    assert.ok(
      chrome.tabWidth + chrome.tabSlant <= input.shellWidth + 1e-9,
      `tab plus slant exceeds the shell at ${describe(input)}`,
    )
  }
})

test('a name is only ever truncated when the shell genuinely cannot hold it', () => {
  // Truncation is legitimate on a narrow frame, but a roomy frame must show
  // the whole name - that is the difference between a policy and a bug.
  const roomy = {
    shellWidth: 1100,
    shellHeight: 480,
    depthTitlePx: 14,
    titlePx: 14,
    title: 'NotificationsPlatform',
    count: 12,
    frameStroke: 1,
  }
  const chrome = systemTabChrome(roomy)
  assert.equal(chrome.titleTruncated, false)
  assert.ok(chrome.titleWidth >= monoTextWidth(roomy.title, chrome.titleFont))

  // A 21-character name cannot fit a frame this narrow at any legible size.
  const cramped = systemTabChrome({ ...roomy, shellWidth: 80 })
  assert.equal(cramped.titleTruncated, true)
  // Even cramped, the title keeps a usable strip rather than collapsing.
  assert.ok(cramped.titleWidth > 0)
})

test('mono advance and line height are the two constants everything depends on', () => {
  assert.ok(MONO_ADVANCE_EM > 0.5 && MONO_ADVANCE_EM < 0.7)
  assert.equal(monoTextWidth('abc', 10), 3 * 10 * MONO_ADVANCE_EM)
})

test('covered titles shrink to show the complete name instead of ellipsizing', () => {
  const names = [
    'Signal Preparation',
    'Longitudinal Tracking and Trend Persistence',
    'Frontal Asymmetry Measurement and Scoring',
  ]
  for (const available of [72, 120, 180, 320]) {
    for (const name of names) {
      const font = monoFontFittingWidth(name, available, 48)
      assert.ok(font > 0, `${name} lost its covered-title font at ${available}px`)
      assert.ok(
        monoTextWidth(name, font) <= available * 0.96 + 1e-9,
        `${name} does not fit its covered title at ${available}px`,
      )
    }
  }
})

test('covered title autofit preserves the intended size when the name already fits', () => {
  assert.equal(monoFontFittingWidth('Validation', 400, 36), 36)
  assert.equal(monoFontFittingWidth('', 0, 36), 36)
})

test('tab height is independent of the frame width', () => {
  // The bug: presentationScale is min(w/designW, h/designH), so narrowing a
  // node dragged the whole tab down with it and started clipping the title and
  // the count for no reason other than the frame being skinny.
  const base = {
    shellHeight: 480,
    depthTitlePx: 14,
    titlePx: 14,
    title: 'Email',
    count: 2,
    frameStroke: 1,
  }
  const heights = new Set()
  const bands = new Set()
  const fonts = new Set()
  for (const shellWidth of [150, 200, 320, 640, 980, 1600]) {
    const chrome = systemTabChrome({ ...base, shellWidth })
    heights.add(chrome.tabHeight)
    bands.add(chrome.bandHeight)
    fonts.add(chrome.titleFont)
  }
  assert.equal(heights.size, 1, 'tab height changed with width')
  assert.equal(bands.size, 1, 'band height changed with width')
  assert.equal(fonts.size, 1, 'title font changed with width')
})

test('the chip stroke shrinks with the tab and never crowds the number', () => {
  for (const input of sweep()) {
    const chrome = systemTabChrome(input)
    if (!chrome.hasChip) continue
    const where = describe(input)
    assert.ok(chrome.chipStroke <= input.frameStroke + 1e-9, `chip stroke exceeds the frame at ${where}`)
    assert.ok(chrome.chipStroke > 0, `chip stroke vanished at ${where}`)
    // Room left for glyphs once both borders are drawn inside the chip.
    const inner = chrome.chipWidth - chrome.chipStroke * 2
    assert.ok(
      monoTextWidth(String(input.count), chrome.chipFont) < inner,
      `chip borders crowd the number at ${where}`,
    )
  }
})

test('a shorter tab gets a proportionally lighter chip stroke', () => {
  assert.ok(chipStrokeWidth(12, 1) < chipStrokeWidth(40, 1))
  assert.equal(chipStrokeWidth(40, 1), 1)
})

test('nothing in the tab moves when only the frame height changes', () => {
  // Growing a frame vertically used to widen `padX` through presentationScale
  // and walk the title sideways. Nothing inside the tab may be measured
  // against the node's own dimensions.
  const base = {
    shellWidth: 900,
    depthTitlePx: 14,
    titlePx: 14,
    title: 'Email',
    count: 2,
    frameStroke: 1,
  }
  const lefts = new Set()
  for (const shellHeight of [260, 340, 480, 700, 1000]) {
    const chrome = systemTabChrome({ ...base, shellHeight })
    lefts.add(chrome.titleLeft)
  }
  assert.equal(lefts.size, 1, 'title left moved with frame height')
})

test('the title inset survives a frame short enough to clamp the tab', () => {
  // The real trap: the tab is clamped to a fraction of the frame height, so it
  // varies as a frame is dragged taller. The title inset must not follow it.
  const lefts = new Set()
  for (const shellHeight of [40, 60, 90, 130, 200, 400, 900]) {
    const presentationScale = Math.min(900 / 620, shellHeight / 420)
    const titlePx = 14 * presentationScale
    const chrome = systemTabChrome({
      shellWidth: 900,
      shellHeight,
      depthTitlePx: 14,
      titlePx,
      title: 'Email',
      count: 2,
      frameStroke: 1,
    })
    lefts.add(chrome.titleLeft)
  }
  assert.equal(
    lefts.size, 1,
    `title inset jumped across frame heights: ${[...lefts].join(', ')}`,
  )
})
