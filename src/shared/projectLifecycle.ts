import type { ProjectConfig } from './types'

export function sourceBoundariesAreComplete(
  project: Pick<ProjectConfig, 'sourceBoundariesReviewedAt'>,
): boolean {
  return typeof project.sourceBoundariesReviewedAt === 'number' &&
    Number.isFinite(project.sourceBoundariesReviewedAt) &&
    project.sourceBoundariesReviewedAt > 0
}

/** Only a still-empty folder created through New Project uses the blank flow. */
export function projectUsesBlankSetup(
  project: Pick<ProjectConfig, 'creationSource' | 'rootIsEmpty'>,
): boolean {
  return project.creationSource === 'new-project' && project.rootIsEmpty === true
}

export function completeSourceBoundaries(
  project: ProjectConfig,
  ignoredPaths: string[],
  reviewedAt = Date.now(),
): ProjectConfig {
  return {
    ...project,
    ignoredPaths: [...ignoredPaths],
    sourceBoundariesReviewedAt: reviewedAt,
  }
}

// A fresh open-dialog result must never erase a completed decision from the
// recent-project record. In particular, [] means "include everything" after
// review, not "review is missing".
export function mergePersistedProjectConfig(
  persisted: ProjectConfig | undefined,
  incoming: ProjectConfig,
): ProjectConfig {
  if (!persisted || sourceBoundariesAreComplete(incoming)) {
    return { ...persisted, ...incoming }
  }
  if (!sourceBoundariesAreComplete(persisted)) {
    return { ...persisted, ...incoming }
  }
  return {
    ...persisted,
    ...incoming,
    ignoredPaths: [...persisted.ignoredPaths],
    sourceBoundariesReviewedAt: persisted.sourceBoundariesReviewedAt,
  }
}

export interface WorkspaceSourceBoundaryStatus {
  indexed: boolean
  ignoredPaths?: string[]
  sourceBoundariesReviewedAt?: number | null
}

// Returns null only when the one-time setup screen is genuinely required.
export function resolveProjectSourceBoundaries(
  project: ProjectConfig,
  status: WorkspaceSourceBoundaryStatus | null,
  now = Date.now(),
): ProjectConfig | null {
  if (sourceBoundariesAreComplete(project)) {
    return project
  }
  if (!status || (!status.indexed && (status.sourceBoundariesReviewedAt ?? 0) <= 0)) {
    return null
  }
  const backendHasExplicitDecision = (status.sourceBoundariesReviewedAt ?? 0) > 0
  return completeSourceBoundaries(
    project,
    backendHasExplicitDecision
      ? (status.ignoredPaths ?? project.ignoredPaths)
      : project.ignoredPaths,
    status.sourceBoundariesReviewedAt ?? now,
  )
}
