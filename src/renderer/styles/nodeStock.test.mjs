import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * Node material is declared in exactly two blocks — Floor stock and sheet
 * stock — using the same token names.
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

/** The declarations inside a rule with exactly this selector text. */
function ruleBody(selector) {
  const index = css.indexOf(`\n${selector} {`)
  assert.ok(index >= 0, `no rule found for "${selector}"`)
  const start = css.indexOf('{', index)
  const end = css.indexOf('}', start)
  return css.slice(start + 1, end)
}

function tokenValue(selector, token) {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(ruleBody(selector))
  return match ? match[1].trim() : null
}

test('sheet stock is scoped to .react-flow, not to the container that wraps it', () => {
  // The whole bug in one assertion. Setting these on `.axiom-sheet-mode` alone
  // is a no-op, because .react-flow redeclares them for its own subtree.
  const scoped = tokenValue('.axiom-sheet-mode .react-flow', '--card-head')
  assert.ok(scoped, 'sheet stock must be declared on .axiom-sheet-mode .react-flow')

  const containerBody = ruleBody('.axiom-sheet-mode')
  assert.equal(
    /--card-head:/.test(containerBody),
    false,
    'node tokens on the bare container are shadowed by .react-flow and do nothing',
  )
})

test('the Floor and a sheet actually differ', () => {
  const floor = tokenValue('.react-flow', '--card-head')
  const sheet = tokenValue('.axiom-sheet-mode .react-flow', '--card-head')
  assert.ok(floor && sheet)
  assert.notEqual(floor, sheet, 'the two stocks must be distinguishable')
})

test('leaving a sheet lands exactly on Floor stock', () => {
  // Otherwise the header fades to a colour the Floor does not use, which reads
  // as a subtle mis-landing rather than an obvious snap.
  const floor = tokenValue('.react-flow', '--card-head')
  const exiting = tokenValue(
    ".axiom-sheet-mode[data-sheet-phase='entering'] .react-flow,\n.axiom-sheet-mode[data-sheet-phase='leaving'] .react-flow",
    '--card-head',
  )
  assert.equal(exiting, floor, 'the exit target must equal the Floor value')
})

test('sheet presence stays on the container, where the chrome reads it', () => {
  // --sheet-presence is NOT redeclared by .react-flow, so it inherits cleanly
  // and belongs with the pseudo-elements that use it.
  assert.ok(/--sheet-presence:\s*1/.test(ruleBody('.axiom-sheet-mode')))
})
