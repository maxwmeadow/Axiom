import assert from 'node:assert/strict'
import test from 'node:test'
import { describeAuthorship, readAuthorship } from './architectureAuthorship.ts'

const files = (count, systemId = 's1') =>
  Array.from({ length: count }, (_, i) => ({ id: `f${i}`, systemId }))

test('a fully clustered map is unnamed even though every file has a system', () => {
  const authorship = readAuthorship({
    systems: [
      { id: 's1', source: 'cluster' },
      { id: 's2', source: 'cluster' },
    ],
    files: files(40),
  })
  assert.equal(authorship.homeless, 0)
  assert.equal(authorship.unnamed, true)
  assert.equal(authorship.inferred, 2)
})

test('a map an agent named is not offered for naming again', () => {
  const authorship = readAuthorship({
    systems: [
      { id: 's1', source: 'agent' },
      { id: 's2', source: 'agent' },
      { id: 's3', source: 'user' },
    ],
    files: files(40),
  })
  assert.equal(authorship.unnamed, false)
  assert.equal(describeAuthorship(authorship), null)
})

test('one authored system among many guesses is still an unnamed map', () => {
  const systems = [{ id: 'authored', source: 'agent' }]
  for (let i = 0; i < 20; i += 1) systems.push({ id: `c${i}`, source: 'cluster' })
  assert.equal(readAuthorship({ systems, files: files(80) }).unnamed, true)
})

test('an empty workspace is not an unnamed map', () => {
  const authorship = readAuthorship({ systems: [], files: [] })
  assert.equal(authorship.unnamed, false)
  assert.equal(describeAuthorship(authorship), null)
})

test('homeless files are still reported once the map is named', () => {
  const authorship = readAuthorship({
    systems: [{ id: 's1', source: 'agent' }],
    files: [...files(3), { id: 'loose', systemId: null }],
  })
  assert.equal(authorship.unnamed, false)
  assert.equal(authorship.homeless, 1)
  assert.match(describeAuthorship(authorship).title, /1 file has no architectural home/)
})

test('the unnamed map is described by what is on screen, not by coverage', () => {
  const described = describeAuthorship(readAuthorship({
    systems: [{ id: 'a', source: 'cluster' }, { id: 'b', source: 'cluster' }],
    files: files(10),
  }))
  assert.match(described.title, /guesswork/)
  assert.match(described.detail, /2 systems were named automatically/)
})

test('top-level systems are counted separately from the tree', () => {
  const authorship = readAuthorship({
    systems: [
      { id: 'root1', source: 'agent', parentId: null },
      { id: 'child', source: 'agent', parentId: 'root1' },
      { id: 'root2', source: 'agent', parentId: null },
    ],
    files: files(5),
  })
  assert.equal(authorship.topLevel, 2)
  assert.equal(authorship.authored, 3)
})
