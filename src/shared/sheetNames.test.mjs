import assert from 'node:assert/strict'
import test from 'node:test'
import { findSheetByName, normalizeSheetName, untakenSheetName } from './sheetNames.ts'

const sheets = [
  { id: 's1', name: 'First Increment' },
  { id: 's2', name: 'Payment flow' },
]

test('names match the way archd matches them: case and edge space ignored', () => {
  assert.equal(normalizeSheetName('  First Increment '), 'first increment')
  assert.equal(findSheetByName(sheets, 'first increment ')?.id, 's1')
  assert.equal(findSheetByName(sheets, 'Second Increment'), undefined)
})

test('a free name is returned untouched', () => {
  assert.equal(untakenSheetName(sheets, 'New Sheet'), 'New Sheet')
  assert.equal(untakenSheetName(sheets, '  New Sheet  '), 'New Sheet')
})

test('a taken name is suffixed rather than duplicated', () => {
  assert.equal(untakenSheetName(sheets, 'First Increment'), 'First Increment 2')
})

test('suffixing keeps climbing past names that are also taken', () => {
  const crowded = [
    ...sheets,
    { id: 's3', name: 'First Increment 2' },
    { id: 's4', name: 'first increment 3' },
  ]
  assert.equal(untakenSheetName(crowded, 'First Increment'), 'First Increment 4')
})

test('an empty workspace never blocks the first name', () => {
  assert.equal(untakenSheetName([], 'First Increment'), 'First Increment')
})
