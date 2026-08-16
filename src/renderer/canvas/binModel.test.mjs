import assert from 'node:assert/strict'
import test from 'node:test'
import { partitionCanvasFiles, sortForBin } from './binModel.ts'

const file = (relPath, overrides = {}) => ({
  id: relPath,
  rootId: 'root',
  path: `/repo/${relPath}`,
  relPath,
  language: 'python',
  systemId: null,
  lineCount: 1,
  churnScore: 0,
  indexedAt: 0,
  ...overrides,
})

const liveHome = { hasHome: f => !!f.systemId }

test('a source file with a system is drawn, not binned', () => {
  const { placed, unclassified, documents } = partitionCanvasFiles(
    [file('app/main.py', { systemId: 'sys-1' })], liveHome,
  )
  assert.deepEqual(placed.map(f => f.relPath), ['app/main.py'])
  assert.equal(unclassified.length, 0)
  assert.equal(documents.length, 0)
})

test('a source file with no system goes to the unclassified bin', () => {
  const { placed, unclassified } = partitionCanvasFiles([file('app/loose.py')], liveHome)
  assert.equal(placed.length, 0)
  assert.deepEqual(unclassified.map(f => f.relPath), ['app/loose.py'])
})

test('every documentation extension lands in the documents bin', () => {
  const docs = ['README.md', 'notes.mdx', 'log.txt', 'guide.rst', 'book.adoc']
  const { documents, placed, unclassified } = partitionCanvasFiles(
    docs.map(name => file(name, { language: 'markdown' })), liveHome,
  )
  assert.deepEqual(documents.map(f => f.relPath), docs)
  assert.equal(placed.length, 0)
  assert.equal(unclassified.length, 0)
})

// The bug this whole feature came out of: a doc that a classifier had attached
// to a system used to read as ordinary architecture.
test('documentation is binned as documentation even when it has a system', () => {
  const { documents, placed } = partitionCanvasFiles(
    [file('docs/PLAN.md', { language: 'markdown', systemId: 'sys-1' })], liveHome,
  )
  assert.deepEqual(documents.map(f => f.relPath), ['docs/PLAN.md'])
  assert.equal(placed.length, 0)
})

test('documentation never reaches the unclassified bin', () => {
  const { documents, unclassified } = partitionCanvasFiles(
    [file('README.md', { language: 'markdown' })], liveHome,
  )
  assert.equal(unclassified.length, 0)
  assert.equal(documents.length, 1)
})

test('an unsupported file is dropped rather than binned', () => {
  const { placed, unclassified, documents } = partitionCanvasFiles(
    [file('assets/logo.png', { language: 'unknown' })], liveHome,
  )
  assert.equal(placed.length + unclassified.length + documents.length, 0)
})

// The review surface answers "has a home?" from proposal membership, not
// `system_id`, and must partition identically otherwise.
test('the review surface can define home as proposal membership', () => {
  const assigned = new Set(['app/a.py'])
  const files = [file('app/a.py'), file('app/b.py'), file('docs/x.md', { language: 'markdown' })]
  const { placed, unclassified, documents } = partitionCanvasFiles(files, {
    hasHome: f => assigned.has(f.relPath),
  })
  assert.deepEqual(placed.map(f => f.relPath), ['app/a.py'])
  assert.deepEqual(unclassified.map(f => f.relPath), ['app/b.py'])
  assert.deepEqual(documents.map(f => f.relPath), ['docs/x.md'])
})

test('the three populations always account for every source and document file', () => {
  const files = [
    file('a.py', { systemId: 's' }), file('b.py'), file('c.md', { language: 'markdown' }),
    file('d.go', { systemId: 's' }), file('e.rs'),
  ]
  const { placed, unclassified, documents } = partitionCanvasFiles(files, liveHome)
  assert.equal(placed.length + unclassified.length + documents.length, files.length)
})

test('bin order is stable and path-sorted', () => {
  const sorted = sortForBin([file('z/a.py'), file('a/z.py'), file('a/a.py')])
  assert.deepEqual(sorted.map(f => f.relPath), ['a/a.py', 'a/z.py', 'z/a.py'])
})
