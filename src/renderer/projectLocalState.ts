/**
 * Everything the renderer remembers about a project, in one place, so that
 * deleting a project deletes it.
 *
 * Removing a project used to drop it from the recent list and delete its
 * database, and leave every local-storage hint keyed to its id behind. Those
 * hints outlive the data they describe: reopening the same folder later —
 * which produces the same id, because the id is a hash of the path — resurrected
 * "you already reviewed this" and "you already saw the guide" for a workspace
 * that no longer existed. The setup a user needed was hidden because a journey
 * had once been completed on that machine.
 *
 * Every project-scoped key belongs in KEYS. A new one added elsewhere and not
 * registered here is a new way for a deleted project to haunt the next one.
 */

const KEYS = [
  (id: string) => `review_completed_${id}`,
  (id: string) => `onboarding_progress_${id}`,
  (id: string) => `onboarding_completed_${id}`,
] as const

/** Forget everything this machine remembers about one project. */
export function clearProjectLocalState(projectId: string): void {
  if (!projectId) return
  for (const key of KEYS) {
    try { localStorage.removeItem(key(projectId)) } catch { /* storage may be unavailable */ }
  }
  // Anything else that happens to be namespaced to this project id — including
  // keys written by code that forgot to register above — goes too. Deleting is
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
