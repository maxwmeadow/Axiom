import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createProjectId,
  findProjectByRoot,
  refreshProjectDiskState,
  removeProjectData,
} from './projectRegistry.ts'

test('an existing recent path keeps its project lifetime but a removed path gets a new id', () => {
  const rootPath = path.join(os.tmpdir(), 'axiom-project-lifetime')
  const existing = { id: 'old-id', rootPath }
  assert.equal(findProjectByRoot([existing], rootPath)?.id, 'old-id')
  assert.notEqual(createProjectId(), createProjectId())
  assert.notEqual(createProjectId(), existing.id)
})

test('project disk state follows the current folder contents without losing its launcher origin', () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-state-'))
  const project = {
    id: 'workspace-1',
    name: 'Blank project',
    rootPath,
    creationSource: 'new-project',
  }
  try {
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: true })
    fs.writeFileSync(path.join(rootPath, 'main.ts'), 'export {}')
    assert.deepEqual(refreshProjectDiskState(project), { ...project, rootIsEmpty: false })
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})

test('project removal verifies data deletion and clears the active MCP pointer', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-delete-'))
  const projectId = 'workspace-1'
  const projectDir = path.join(dataDir, projectId)
  fs.mkdirSync(projectDir)
  fs.writeFileSync(path.join(projectDir, 'axiom.db'), 'stale proposal')
  fs.writeFileSync(
    path.join(dataDir, 'active_project.json'),
    JSON.stringify({ workspaceId: projectId, rootPath: 'C:/repo' }),
  )
  try {
    await removeProjectData({
      projectId,
      dataDir,
      apiPort: 7743,
      request: async () => new Response('{}', { status: 200 }),
    })
    assert.equal(fs.existsSync(projectDir), false)
    assert.equal(fs.existsSync(path.join(dataDir, 'active_project.json')), false)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a daemon refusal is surfaced and never pretends the project was removed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-project-refusal-'))
  const projectDir = path.join(dataDir, 'workspace-1')
  fs.mkdirSync(projectDir)
  try {
    await assert.rejects(
      removeProjectData({
        projectId: 'workspace-1',
        dataDir,
        apiPort: 7743,
        request: async () => new Response('locked', { status: 500 }),
      }),
      /could not delete the project data/,
    )
    assert.equal(fs.existsSync(projectDir), true)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
