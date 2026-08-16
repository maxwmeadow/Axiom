/**
 * Everything the renderer remembers about a project, in one place, so that
 * deleting a project deletes it.
 *
 * Removing a project used to drop it from the recent list and delete its
 * database, and leave every local-storage hint keyed to its id behind. Those
 * hints outlive the data they describe: reopening the same folder later -
 * which produces the same id, because the id is a hash of the path - resurrected
 * "you already reviewed this" and "you already saw the guide" for a workspace
 * that no longer existed. The setup a user needed was hidden because a journey
 * had once been completed on that machine.
 *
 * Every project-scoped key belongs in KEYS. A new one added elsewhere and not
 * registered here is a new way for a deleted project to haunt the next one.
 */

import type { ProjectConfig } from '../shared/types'

const AGENT_SETUP_KEY = (id: string) => `agent_setup_completed_${id}`
const LEGACY_REVIEW_KEY = (id: string) => `review_completed_${id}`

const KEYS = [
  AGENT_SETUP_KEY,
  LEGACY_REVIEW_KEY,
  // Removed in favor of ProjectConfig.creationSource. Keep deleting the old
  // key so projects made by previous builds do not leave stale local state.
  (id: string) => `project_created_blank_${id}`,
  (id: string) => `onboarding_progress_${id}`,
  (id: string) => `onboarding_completed_${id}`,
] as const

/**
 * A completed baseline review was the old end of project setup. Treat it as
 * proof that an existing project already crossed the agent-connection gate so
 * an upgrade never walks a user backwards through setup.
 */
export function agentSetupIsComplete(projectId: string): boolean {
  if (!projectId) return false
  try {
    return localStorage.getItem(AGENT_SETUP_KEY(projectId)) === 'true' ||
      localStorage.getItem(LEGACY_REVIEW_KEY(projectId)) === 'true'
  } catch {
    return false
  }
}

export function markAgentSetupComplete(projectId: string): void {
  if (!projectId) return
  try { localStorage.setItem(AGENT_SETUP_KEY(projectId), 'true') } catch { /* storage may be unavailable */ }
}

/**
 * One release recorded New Project only in local storage. Promote that hint
 * into the persisted project config the next time the project opens. Projects
 * without the old hint safely retain the historical Open Codebase behavior.
 */
export function migrateLegacyProjectCreationSource(config: ProjectConfig): ProjectConfig {
  if (config.creationSource) return config
  let creationSource: ProjectConfig['creationSource'] = 'open-codebase'
  try {
    if (localStorage.getItem(`project_created_blank_${config.id}`) === 'true') {
      creationSource = 'new-project'
    }
  } catch { /* storage may be unavailable */ }
  return { ...config, creationSource }
}

/** Forget everything this machine remembers about one project. */
export function clearProjectLocalState(projectId: string): void {
  if (!projectId) return
  for (const key of KEYS) {
    try { localStorage.removeItem(key(projectId)) } catch { /* storage may be unavailable */ }
  }
  // Anything else that happens to be namespaced to this project id - including
  // keys written by code that forgot to register above - goes too. Deleting is
  // deleting.
  try {
    const orphans: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && key.includes(projectId)) orphans.push(key)
    }
    for (const key of orphans) localStorage.removeItem(key)
  } catch { /* storage may be unavailable */ }
}
