/**
 * System-node tab chrome: the folder tab, the title inside it, and the count
 * chip at its right end.
 *
 * This lives apart from the component so the geometry can be swept across
 * sizes and aspect ratios in a test. Every clipping bug in this chrome came
 * from a rule that held at one size and broke at another — a font sized to a
 * band without accounting for its line box, a chip sized independently of the
 * tab that has to hold it — and none of that is visible by reading the JSX.
 */
export interface SystemChromeInput {
  /** Rendered shell size in presentation pixels. */
  shellWidth: number
  shellHeight: number
  /** Depth title size BEFORE presentation scaling. Tab height keys off this
   *  so a node cannot change its own tab height by being resized. */
  depthTitlePx: number
  /** Depth-driven title size ceiling, presentation-scaled. */
  titlePx: number
  title: string
  count: number
  /** Stroke weight of the frame itself; the chip never exceeds it. */
  frameStroke: number
}

export interface SystemChrome {
  tabHeight: number
  tabWidth: number
  tabSlant: number
  /** Vertical band shared by the title and the chip. */
  bandTop: number
  bandHeight: number
  titleFont: number
  titleLeft: number
  titleWidth: number
  /** True when the tab could not hold the whole name and it will ellipsize. */
  titleTruncated: boolean
  chipFont: number
  chipWidth: number
  chipStroke: number
  /** Chip corners; the right edge is parallel to the tab's slanted cut. */
  chipLeft: number
  chipTopRight: number
  chipBottomRight: number
  hasChip: boolean
}

/**
 * Advance width of one character of the mono UI face, in em. Measured from
 * JetBrains Mono, which is what `--font-mono` resolves to.
 */
export const MONO_ADVANCE_EM = 0.62

/**
 * Text is laid out in a line box of `fontSize * lineHeight`, not `fontSize`.
 * Sizing a font to its container height ignores the difference and clips the
 * ascender — which is exactly how the title lost its top edge.
 */
export const TITLE_LINE_HEIGHT = 1.25

/** Tab height as a multiple of the depth title size. */
export const TAB_HEIGHT_PER_TITLE_PX = 0.95
/** A tab may never swallow more than this share of the frame height. */
export const MAX_TAB_HEIGHT_FRACTION = 0.15
export const MIN_TAB_HEIGHT = 8

/**
 * How tall the tab actually draws, in the shell's rendered pixels.
 *
 * THE authority on that number. Layout code reserves room above a frame's
 * first child by calling this, rather than reimplementing it — the two used to
 * disagree badly: the layout reserved a "header budget" of `padY*2 +
 * titlePx*1.25` (~52 on a default frame) while the tab drew at
 * `depthTitlePx * 0.95` (~23), leaving ~29px of empty band that made the gap
 * above the first child roughly four times the gap on every other side.
 *
 * Deliberately independent of frame WIDTH and of presentation scale, so a node
 * cannot change its own tab height by being resized.
 */
export function systemTabHeight(depthTitlePx: number, shellHeight: number): number {
  return Math.max(
    MIN_TAB_HEIGHT,
    Math.min(depthTitlePx * TAB_HEIGHT_PER_TITLE_PX, shellHeight * MAX_TAB_HEIGHT_FRACTION),
  )
}

/**
 * Chip stroke scales with the tab. A constant hairline is proportionally huge
 * on a short tab, and since the stroke is drawn inside the chip it steals the
 * room the number needs.
 */
export function chipStrokeWidth(tabHeight: number, frameStroke: number): number {
  return Math.max(0.5, Math.min(frameStroke, tabHeight * 0.075))
}

export function monoTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * MONO_ADVANCE_EM
}

/**
 * Largest mono font that shows an entire single-line label inside `available`.
 * The small reserve absorbs browser glyph rasterization and fractional layout
 * rounding, so a mathematically exact fit never loses its final character.
 */
export function monoFontFittingWidth(text: string, available: number, ceiling: number): number {
  const safeCeiling = Number.isFinite(ceiling) ? Math.max(0, ceiling) : 0
  if (text.length === 0) return safeCeiling
  const safeAvailable = Number.isFinite(available) ? Math.max(0, available) : 0
  const widthAtOnePixel = monoTextWidth(text, 1)
  return Math.min(safeCeiling, safeAvailable * 0.96 / widthAtOnePixel)
}

/** Largest font whose line box fits `available`. */
export function fontFittingBand(available: number, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, available / TITLE_LINE_HEIGHT))
}

export function systemTabChrome(input: SystemChromeInput): SystemChrome {
  const { shellWidth, shellHeight, depthTitlePx, titlePx, title, count } = input

  // Tab height must not depend on the node WIDTH. It used to arrive through
  // presentationScale, which is min(width/designWidth, height/designHeight):
  // narrowing a node dragged that scale down and shortened the tab, so the
  // title and count started clipping purely because the frame got skinnier.
  // Height is a legible constant per depth, bounded by the room available
  // vertically.
  //
  // It is no longer clamped by the layout's reservation either: that was
  // circular, because the layout now reserves exactly this value plus one gap.
  const tabHeight = systemTabHeight(depthTitlePx, shellHeight)
  const tabSlant = tabHeight * 0.65
  const gap = Math.max(1.5, tabHeight * 0.14)
  const bandTop = 1 + gap
  const bandHeight = Math.max(1, tabHeight - bandTop)

  // Both the title and the chip are sized to the band's line box, so neither
  // can outgrow the strip that contains them regardless of tab proportions.
  const titleFont = fontFittingBand(bandHeight, titlePx)
  const chipFont = fontFittingBand(bandHeight, tabHeight * 0.5)

  const hasChip = count > 0
  const digits = hasChip ? String(count).length : 0
  const chipStroke = chipStrokeWidth(tabHeight, input.frameStroke)
  const chipPadX = chipFont * 0.55 + chipStroke
  const chipWidth = hasChip ? monoTextWidth(String(count), chipFont) + chipPadX * 2 : 0

  // Horizontal offset that produces an equal *visual* gap against the slanted
  // cut. Using the raw gap would crowd the chip into the slant.
  const slantLength = Math.hypot(tabSlant, tabHeight - 1)
  const chipGapX = gap * slantLength / Math.max(tabHeight - 1, 1)

  // Keyed to the depth size, which is a true constant per nesting level.
  // Deriving it from the node padding walked the title sideways as the frame
  // grew (that padding rides presentationScale). Deriving it from tabHeight
  // was no better: tabHeight is itself clamped by the frame height, so a
  // short frame growing taller grew the tab and dragged the title with it,
  // in rounding-sized jumps. The inset must depend on neither dimension.
  const titleLeft = depthTitlePx * 0.55
  const titleIdealWidth = monoTextWidth(title, titleFont)
  const chipReservation = hasChip ? chipWidth + chipGapX + gap * 2 : 0
  const idealTabWidth = titleLeft + titleIdealWidth + chipReservation

  // The tab may never exceed what the shell can hold once its slant is drawn.
  const maxTabWidth = Math.max(tabHeight, shellWidth - tabSlant - 2)
  const minTabWidth = Math.min(
    Math.max(shellWidth * 0.3, titleFont * 6),
    shellWidth * 0.5,
  )
  const tabWidth = Math.min(maxTabWidth, Math.max(minTabWidth, idealTabWidth))

  const tabEdgeAt = (y: number) =>
    tabWidth + (tabSlant / Math.max(tabHeight - 1, 1)) * (y - 1)
  const chipTopRight = hasChip ? tabEdgeAt(bandTop) - chipGapX : 0
  const chipBottomRight = hasChip ? tabEdgeAt(tabHeight) - chipGapX : 0
  const chipLeft = hasChip ? chipTopRight - chipWidth : 0

  // The title stops where the chip begins. If the tab was capped by the shell,
  // this is what absorbs the shortfall, so the name ellipsizes instead of
  // sliding under the chip.
  const titleLimit = hasChip ? chipLeft - gap : tabWidth
  const titleWidth = Math.max(0, titleLimit - titleLeft)

  return {
    tabHeight,
    tabWidth,
    tabSlant,
    bandTop,
    bandHeight,
    titleFont,
    titleLeft,
    titleWidth,
    titleTruncated: titleWidth < titleIdealWidth,
    chipFont,
    chipWidth,
    chipStroke,
    chipLeft,
    chipTopRight,
    chipBottomRight,
    hasChip,
  }
}
