/**
 * A focused Markdown reader for documents Axiom indexed.
 *
 * Parses to a structure, never to HTML. Documents come out of whatever
 * repository the user opened, so a README is untrusted input running inside
 * Electron - handing it to `dangerouslySetInnerHTML` would let a cloned repo
 * put a script tag on the page. Producing nodes that the view turns into React
 * elements makes that impossible by construction rather than by sanitising.
 *
 * It covers what technical documentation actually uses. Anything unrecognised
 * degrades to its literal text rather than disappearing, because a reader that
 * silently drops content is worse than one that renders it plainly.
 */

export interface MdText { kind: 'text'; value: string }
export interface MdCodeSpan { kind: 'code'; value: string }
export interface MdStrong { kind: 'strong'; children: MdInline[] }
export interface MdEmphasis { kind: 'em'; children: MdInline[] }
export interface MdStrike { kind: 'strike'; children: MdInline[] }
export interface MdLink { kind: 'link'; href: string; children: MdInline[] }
export type MdInline = MdText | MdCodeSpan | MdStrong | MdEmphasis | MdStrike | MdLink

export interface MdHeading { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
export interface MdParagraph { kind: 'paragraph'; children: MdInline[] }
export interface MdCodeBlock { kind: 'codeblock'; language: string; value: string }
export interface MdList { kind: 'list'; ordered: boolean; items: MdInline[][] }
export interface MdQuote { kind: 'quote'; children: MdBlock[] }
export interface MdRule { kind: 'rule' }
export interface MdTable { kind: 'table'; header: MdInline[][]; rows: MdInline[][][] }
export type MdBlock = MdHeading | MdParagraph | MdCodeBlock | MdList | MdQuote | MdRule | MdTable

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}\d+[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) { index += 1; continue }

    // Fenced code first: everything inside it is literal, including markers
    // that would otherwise start a list or a heading.
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index]
        if (new RegExp(`^\\s{0,3}${marker}{${fence[1].length},}\\s*$`).test(candidate)) {
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
      blocks.push({ kind: 'codeblock', language: fence[2] ?? '', value: body.join('\n') })
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as MdHeading['level'],
        children: parseInline(heading[2].replace(/\s+#+\s*$/, '')),
      })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(QUOTE.exec(lines[index])![1])
        index += 1
      }
      blocks.push({ kind: 'quote', children: parseMarkdown(quoted.join('\n')) })
      continue
    }

    // A table needs its divider row to be a table at all; without it the
    // pipes are just text.
    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const header = splitRow(line).map(parseInline)
      index += 2
      const rows: MdInline[][][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]).map(parseInline))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    const bulletMatch = BULLET.exec(line)
    const orderedMatch = ORDERED.exec(line)
    if (bulletMatch || orderedMatch) {
      const ordered = !bulletMatch
      const pattern = ordered ? ORDERED : BULLET
      const items: MdInline[][] = []
      while (index < lines.length) {
        const match = pattern.exec(lines[index])
        if (!match) break
        // Continuation lines belong to the item they are indented under.
        let text = match[1]
        index += 1
        while (
          index < lines.length &&
          lines[index].trim() &&
          !pattern.test(lines[index]) &&
          !HEADING.test(lines[index]) &&
          !FENCE.test(lines[index]) &&
          /^\s{2,}/.test(lines[index])
        ) {
          text += ' ' + lines[index].trim()
          index += 1
        }
        items.push(parseInline(text))
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !HEADING.test(lines[index]) &&
      !FENCE.test(lines[index]) &&
      !RULE.test(lines[index]) &&
      !QUOTE.test(lines[index]) &&
      !BULLET.test(lines[index]) &&
      !ORDERED.test(lines[index])
    ) {
      paragraph.push(lines[index])
      index += 1
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
    } else {
      // Nothing matched and nothing consumed: emit the line literally rather
      // than looping forever on it.
      blocks.push({ kind: 'paragraph', children: [{ kind: 'text', value: line }] })
      index += 1
    }
  }

  return blocks
}

/**
 * Inline spans. Code is matched before everything else, so backticked text is
 * never reinterpreted - `**not bold**` inside a code span stays literal.
 */
export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = []
  let buffer = ''
  let index = 0

  const flush = () => {
    if (buffer) {
      out.push({ kind: 'text', value: buffer })
      buffer = ''
    }
  }

  while (index < source.length) {
    const rest = source.slice(index)

    const code = /^(`+)([\s\S]*?)\1/.exec(rest)
    if (code) {
      flush()
      out.push({ kind: 'code', value: code[2].trim() })
      index += code[0].length
      continue
    }

    // Images degrade to their alt text: a document reader shows prose, and a
    // broken image icon for a path that only resolves inside the repo is noise.
    const image = /^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest)
    if (image) {
      flush()
      out.push({ kind: 'text', value: image[1] || image[2] })
      index += image[0].length
      continue
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest)
    if (link) {
      flush()
      out.push({ kind: 'link', href: link[2], children: parseInline(link[1]) })
      index += link[0].length
      continue
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong) {
      flush()
      out.push({ kind: 'strong', children: parseInline(strong[2]) })
      index += strong[0].length
      continue
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest)
    if (strike) {
      flush()
      out.push({ kind: 'strike', children: parseInline(strike[1]) })
      index += strike[0].length
      continue
    }

    const emphasis = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (emphasis) {
      flush()
      out.push({ kind: 'em', children: parseInline(emphasis[2]) })
      index += emphasis[0].length
      continue
    }

    buffer += source[index]
    index += 1
  }

  flush()
  return out
}

/** Only schemes a document reader should ever follow. */
export function isSafeHref(href: string): boolean {
  const value = href.trim().toLowerCase()
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('#')
}
