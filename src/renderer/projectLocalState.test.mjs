import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSetupIsComplete,
  clearProjectLocalState,
  markAgentSetupComplete,
  migrateLegacyProjectCreationSource,
} from './projectLocalState.ts'

class MemoryStorage {
  #values = new Map()

  get length() { return this.#values.size }
  key(index) { return [...this.#values.keys()][index] ?? null }
  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
}

test('agent setup completion persists, migrates legacy reviews, and clears with the project', () => {
  const previousStorage = globalThis.localStorage
  const storage = new MemoryStorage()
  globalThis.localStorage = storage

  try {
    assert.equal(agentSetupIsComplete('new-project'), false)
    storage.setItem('project_created_blank_new-project', 'true')
    assert.equal(
      migrateLegacyProjectCreationSource({ id: 'new-project' }).creationSource,
      'new-project',
    )
    assert.equal(
      migrateLegacyProjectCreationSource({ id: 'existing-project' }).creationSource,
      'open-codebase',
    )
    assert.equal(
      migrateLegacyProjectCreationSource({
        id: 'existing-project',
        creationSource: 'new-project',
      }).creationSource,
      'new-project',
    )
    markAgentSetupComplete('new-project')
    assert.equal(agentSetupIsComplete('new-project'), true)

    storage.setItem('review_completed_legacy-project', 'true')
    assert.equal(agentSetupIsComplete('legacy-project'), true)

    clearProjectLocalState('new-project')
    clearProjectLocalState('legacy-project')
    assert.equal(agentSetupIsComplete('new-project'), false)
    assert.equal(agentSetupIsComplete('legacy-project'), false)
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
