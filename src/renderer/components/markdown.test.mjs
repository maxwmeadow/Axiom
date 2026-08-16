import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeHref, parseInline, parseMarkdown } from './markdown.ts'

const text = nodes => nodes.map(function flatten(node) {
  if (node.kind === 'text' || node.kind === 'code') return node.value
  return node.children ? node.children.map(flatten).join('') : ''
}).join('')

test('headings carry their level and their text', () => {
  const [block] = parseMarkdown('### Capture Guide')
  assert.equal(block.kind, 'heading')
  assert.equal(block.level, 3)
  assert.equal(text(block.children), 'Capture Guide')
})

test('a fenced block keeps its language and its exact body', () => {
  const [block] = parseMarkdown('```python\nx = 1\n\ny = 2\n```')
  assert.equal(block.kind, 'codeblock')
  assert.equal(block.language, 'python')
  assert.equal(block.value, 'x = 1\n\ny = 2')
})

// Everything inside a fence is literal, or documentation about markdown
// silently reformats itself.
test('markdown syntax inside a fence is not interpreted', () => {
  const [block] = parseMarkdown('```\n# not a heading\n- not a list\n```')
  assert.equal(block.kind, 'codeblock')
  assert.equal(block.value, '# not a heading\n- not a list')
})

test('bullet and ordered lists are distinguished', () => {
  const [bullets] = parseMarkdown('- one\n- two')
  assert.equal(bullets.kind, 'list')
  assert.equal(bullets.ordered, false)
  assert.deepEqual(bullets.items.map(text), ['one', 'two'])

  const [ordered] = parseMarkdown('1. first\n2. second')
  assert.equal(ordered.ordered, true)
  assert.deepEqual(ordered.items.map(text), ['first', 'second'])
})

test('paragraph lines join instead of becoming separate blocks', () => {
  const blocks = parseMarkdown('one line\nsecond line\n\nnew paragraph')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].kind, 'paragraph')
  assert.equal(text(blocks[1].children), 'new paragraph')
})

test('a blockquote parses its contents as markdown', () => {
  const [quote] = parseMarkdown('> ## inside\n> text')
  assert.equal(quote.kind, 'quote')
  assert.equal(quote.children[0].kind, 'heading')
})

test('a table needs its divider row to be a table', () => {
  const [table] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.equal(table.kind, 'table')
  assert.deepEqual(table.header.map(text), ['a', 'b'])
  assert.deepEqual(table.rows[0].map(text), ['1', '2'])

  const [notTable] = parseMarkdown('| a | b |\njust text')
  assert.equal(notTable.kind, 'paragraph')
})

test('rules are recognised in every common spelling', () => {
  for (const source of ['---', '***', '___', '- - -']) {
    assert.equal(parseMarkdown(source)[0].kind, 'rule', source)
  }
})

// ── Inline ──────────────────────────────────────────────────────────────────

test('code spans win over every other marker', () => {
  const nodes = parseInline('use `**not bold**` here')
  assert.equal(nodes[1].kind, 'code')
  assert.equal(nodes[1].value, '**not bold**')
})

test('bold, italic and strikethrough nest', () => {
  const [strong] = parseInline('**bold _and italic_**')
  assert.equal(strong.kind, 'strong')
  assert.ok(strong.children.some(child => child.kind === 'em'))
  assert.equal(parseInline('~~gone~~')[0].kind, 'strike')
})

test('links keep their href and their label', () => {
  const [link] = parseInline('[Axiom](https://example.com)')
  assert.equal(link.kind, 'link')
  assert.equal(link.href, 'https://example.com')
  assert.equal(text(link.children), 'Axiom')
})

test('images degrade to alt text rather than a broken repo-relative path', () => {
  const nodes = parseInline('![a diagram](./docs/x.png)')
  assert.equal(nodes[0].kind, 'text')
  assert.equal(nodes[0].value, 'a diagram')
})

// A README is untrusted repository content rendered inside Electron.
test('only http, https and anchors are followable', () => {
  assert.equal(isSafeHref('https://example.com'), true)
  assert.equal(isSafeHref('http://example.com'), true)
  assert.equal(isSafeHref('#section'), true)
  assert.equal(isSafeHref('javascript:alert(1)'), false)
  assert.equal(isSafeHref('file:///etc/passwd'), false)
  assert.equal(isSafeHref('  JavaScript:alert(1)'), false)
})

test('unmatched markers survive as literal text', () => {
  assert.equal(text(parseInline('2 * 3 * 4')), '2 * 3 * 4')
  assert.equal(text(parseInline('a_b_c_d')).length > 0, true)
})

test('an empty document produces no blocks and does not hang', () => {
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n   \n'), [])
})
