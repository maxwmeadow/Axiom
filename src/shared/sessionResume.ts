// Where the app should land on launch.
//
// Axiom opened on a project launcher every time, so reaching your own codebase
// cost a click through a list you had already chosen from yesterday. A tool you
// are meant to open every morning should not ask which project you meant when
// it watched you work in one for six hours.
//
// The rule is "resume where you were", not "open the newest". Those differ in
// the case that matters: if you deliberately backed out to the launcher, that
// was a choice, and the next launch has to respect it rather than dragging you
// back into the project you just left.

export type ResumeDecision =
  | { kind: 'home' }
  | { kind: 'resume'; projectId: string }

export interface ResumeInput {
  /** The project open when the app last closed, or null if the user left to the launcher. */
  resumeProjectId: string | null
  /** Ids still present in the recent list, so a removed project cannot be resumed. */
  recentIds: readonly string[]
  /**
   * Ids whose first-run setup is finished - source boundaries chosen and the
   * baseline review closed. Resuming into an unfinished project would skip the
   * very steps that make its map meaningful.
   */
  readyIds: ReadonlySet<string>
}

export function resumeDecision(input: ResumeInput): ResumeDecision {
  const { resumeProjectId, recentIds, readyIds } = input

  // No marker: a first launch, or the user chose the launcher on the way out.
  if (!resumeProjectId) return { kind: 'home' }

  // The project was removed or its config was cleared while we were closed.
  if (!recentIds.includes(resumeProjectId)) return { kind: 'home' }

  // Half-configured projects still owe the user the setup path.
  if (!readyIds.has(resumeProjectId)) return { kind: 'home' }

  return { kind: 'resume', projectId: resumeProjectId }
}
