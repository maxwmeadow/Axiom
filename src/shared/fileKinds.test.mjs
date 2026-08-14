import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyProjectFile, isCanvasSourceFile, isDocumentationFile } from './fileKinds.ts'

test('classifies code, readable documents, and unsupported assets separately', () => {
  assert.equal(classifyProjectFile('src/app.tsx'), 'source')
  assert.equal(classifyProjectFile('README.md'), 'document')
  assert.equal(classifyProjectFile('notes.TXT'), 'document')
  assert.equal(classifyProjectFile('demo.mp4'), 'unsupported')
  assert.equal(classifyProjectFile('plan.pdf'), 'unsupported')
  assert.equal(classifyProjectFile('src', true), 'folder')
})

test('documents stay searchable but never become canvas source nodes', () => {
  const markdown = { relPath: 'docs/architecture.md', language: 'markdown' }
  const source = { relPath: 'src/main.go', language: 'go' }
  assert.equal(isDocumentationFile(markdown), true)
  assert.equal(isCanvasSourceFile(markdown), false)
  assert.equal(isDocumentationFile(source), false)
  assert.equal(isCanvasSourceFile(source), true)
})
