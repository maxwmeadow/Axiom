/**
 * Agent lane — the surface that shows which worktree each agent occupies and
 * how their branches relate.
 *
 * MOUNT POINT, intentionally empty. This exists so the parallel-agent track can
 * build its whole surface without editing App.tsx, which the workbench-spine
 * track owns. Filling this in is Track A's job; moving or removing it is not.
 *
 * See PARALLEL_AGENTS_BRIEF.md.
 */
export function AgentLane() {
  return null
}
