import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * Node material is declared in exactly two blocks - Floor stock and sheet
 * stock - using the same token names.
 *
 * These tests exist because of a bug that produced no error and no warning:
 * sheet-mode tokens were set on the `.axiom-sheet-mode` container, but
 * `.react-flow` declares the same tokens on ITSELF, and a custom property
 * declared on a closer ancestor always beats one inherited from further up.
 * The override silently did nothing, so sheet headers stayed Floor-grey while
 * every other part of sheet mode worked correctly.
 *
 * A cascade failure like that is invisible to typechecking and to every test
 * that does not read the stylesheet, so it is checked here directly.
 */

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

/**
 * The declarations inside the rule that targets this selector.
 *
 * Matches a selector list, not just a lone selector: `.react-flow` carries the
 * canvas palette and other surfaces legitimately share that rule, so requiring
 * it to sit alone made an ordinary refactor look like a missing stylesheet.
 */
function ruleBody(selector) {
  let cursor = 0
  while (true) {
    const open = css.indexOf('{', cursor)
    if (open < 0) break
    const close = css.indexOf('}', open)
    if (close < 0) break
    // Everything since the previous rule ended is this rule's selector list,
    // minus any comment sitting between them.
    const head = css.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = head.split(',').map(part => part.trim()).filter(Boolean)
    // Callers pass either one selector out of a list, or a whole list when the
    // rule is only meaningful as a group.
    const wanted = selector.split(',').map(part => part.trim()).filter(Boolean)
    const matches = wanted.length > 1
      ? wanted.join(',') === selectors.join(',')
      : selectors.includes(selector)
    if (matches) return css.slice(open + 1, close)
    cursor = close + 1
  }
  assert.fail(`no rule found for "${selector}"`)
}

function tokenValue(selector, token) {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(ruleBody(selector))
  return match ? match[1].trim() : null
}

const PLANNED = ".axiom-sheet-mode .react-flow__node[data-id^='planned:']"

test('sheet stock is declared inside .react-flow, not on the container', () => {
  // The original bug in one assertion. Setting these on `.axiom-sheet-mode`
  // alone is a no-op, because .react-flow redeclares them for its own subtree.
  assert.ok(tokenValue(PLANNED, '--card-head'), 'sheet stock must be declared inside .react-flow')

  assert.equal(
    /--card-head:/.test(ruleBody('.axiom-sheet-mode')),
    false,
    'node tokens on the bare container are shadowed by .react-flow and do nothing',
  )
})

test('sheet stock reaches PLANNED elements only, never live code', () => {
  // Material marks what is PROPOSED, not which surface you are looking at. A
  // live file that changed appearance between views would turn one trusted map
  // into two drawings of it.
  assert.equal(
    css.includes('.axiom-sheet-mode .react-flow {'),
    false,
    'a blanket sheet override would restyle live code too',
  )
  assert.match(
    css,
    /\.axiom-sheet-mode \.react-flow__node\[data-id\^='planned:'\] \.axiom-shape-texture/,
    'paper is applied to planned elements only',
  )
})

test('the Floor and a planned element actually differ', () => {
  const floor = tokenValue('.react-flow', '--card-head')
  const planned = tokenValue(PLANNED, '--card-head')
  assert.ok(floor && planned)
  assert.notEqual(floor, planned, 'the two stocks must be distinguishable')
})

test('leaving a sheet lands exactly on Floor stock', () => {
  // Otherwise the header fades to a colour the Floor does not use, which reads
  // as a subtle mis-landing rather than an obvious snap.
  const floor = tokenValue('.react-flow', '--card-head')
  const exiting = tokenValue(
    ".axiom-sheet-mode[data-sheet-phase='entering'] .react-flow__node[data-id^='planned:'],\n" +
      ".axiom-sheet-mode[data-sheet-phase='leaving'] .react-flow__node[data-id^='planned:']",
    '--card-head',
  )
  assert.equal(exiting, floor, 'the exit target must equal the Floor value')
})

test('sheet presence stays on the container, where the chrome reads it', () => {
  // --sheet-presence is NOT redeclared by .react-flow, so it inherits cleanly
  // and belongs with the pseudo-elements that use it.
  assert.ok(/--sheet-presence:\s*1/.test(ruleBody('.axiom-sheet-mode')))
})

test('the blueprint board is still the mode signal', () => {
  // Nodes stop carrying the mode, so the BOARD has to keep carrying it.
  assert.match(css, /\.axiom-sheet-mode \.react-flow__pane::before/)
  assert.match(css, /blueprint\.jpg/)
})
