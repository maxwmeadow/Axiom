# Track A — Parallel Agent Awareness

Worktree: `C:\Users\maxst\VSCodeProjects\Axiom-parallel-agents`
Branch: `codex/parallel-agents` (branched from `main` @ `ab69e5b`)
Companion track: `claude/workbench-spine` — do not edit its files (see §6).

---

## 1. The problem

Axiom's thesis is "the shared command surface where a developer and their
agents build software together." Its data model says **one folder, one
timeline**.

Verified in the current code:

- `branch` and `commit` are recorded **only** for investigation captures
  (`internal/api/investigation.go`). The graph, `structural_events`,
  `work_sessions`, `agent_actions`, and delta claims have no branch dimension.
- `roots` is already a `workspace 1:N roots` table and `watcher.New` already
  accepts `[]db.Root` — but exactly one root is created per workspace on open
  (`internal/api/server.go` ~line 330).

Meanwhile the real 2026 workflow — and this repo owner's own daily workflow —
is **N agents in N git worktrees on N branches**. Axiom is structurally
incapable of showing that. It is the single largest reason the app has no
reason to be opened.

## 2. Why this is the wedge, not just a feature

Conductor, Crystal/Nimbalyst, Vibe Kanban and GitHub Agent HQ are all
worktree-native already. Every one of them presents parallel agent work as
**lists, kanban cards, and diffs**, and all of them leave conflict resolution
and merge decisions on the user's plate.

None of them can answer: **"did these three branches touch the same
architectural boundary?"** That question needs a semantic map of the codebase.
Axiom has one. Nobody else does.

That question — asked *before* merge, not during — is the deliverable. Branch
awareness is the substrate for it, not the goal.

## 3. Scope

### 3.1 Multi-root, one per worktree
- Discover git worktrees for a workspace (`git worktree list --porcelain`).
- Register each as a `db.Root`. The primary checkout stays root #1 so existing
  single-root projects keep working untouched.
- One watcher per root. Roots can be added/removed while the app is open.
- Roots carry `branch` and `head_commit`, refreshed on change.

### 3.2 Branch-stamped history
Stamp root/branch on `structural_events`, `work_sessions`, and `agent_actions`.
Existing rows have no branch; treat NULL as "the primary root" so old data still
reads correctly. Migrations must be additive — never rewrite history.

### 3.3 Per-branch delta
`/api/delta` gains a root/branch filter. The delta watermark
(`workspaces.delta_reviewed_at`) becomes per-root: reviewing branch A must not
acknowledge branch B's changes.

### 3.4 Cross-branch collision — the payoff
A read model answering: for the current set of active branches, which
**systems** (semantic boundaries, not files) does each one touch, and where do
they overlap?

Output per overlapping boundary: the system, the branches touching it, and the
claims from each. This is what turns "3 agents are running" into "these two are
going to fight over Payments."

Do not reimplement git conflict detection. Line-level conflicts are git's job.
This is **semantic** overlap, and it is useful precisely because it is visible
before either branch is finished.

### 3.5 MCP
Agents report which worktree they occupy. `start_work` should capture the
agent's working directory and resolve it to a root. Keep the tool surface
budget in `MCP_SURFACE.md` green — guard tests enforce it.

### 3.6 UI
Fill in `src/renderer/components/AgentLane.tsx` (currently renders `null`,
already mounted in `App.tsx`). It should show active branches, which agent is
in which, and surface collisions from §3.4. Styles go in
`src/renderer/styles/agents.css`. **Do not edit `global.css`.**

You also own the branch-aware briefing: `/api/command-deck` currently returns
`unreviewedClaims`, `unexplained`, `unexpected`, `activeWork`, `openPlans`,
`pendingProposals` for a whole workspace and is only used to decorate rows in
the project launcher. Make it per-branch. The surface that consumes it is
yours to design.

## 4. Landmine — read before touching the DB

`internal/db/db.go` line ~29:

```go
db.SetMaxOpenConns(1) // SQLite is not safe for concurrent writes
```

Four worktree watchers reindexing into one connection will serialize and stall
the UI. **Solve this before building on top of it.**

The recommended shape — and this is a recommendation, not a mandate; if you
find something better after investigating, take it and write down why:

> **One SQLite database per root**, extending the pattern archd already uses
> per workspace (`dataDir/<workspaceID>/axiom.db`). Cross-branch queries become
> an explicit `ATTACH`, which is a bounded, testable operation. This avoids a
> `branch_id` migration across every table and sidesteps the lock problem
> entirely rather than tuning around it.

The alternative — stamping `branch_id` everywhere and raising the connection
limit — means auditing every write path for concurrency safety. That is a much
larger surface to get wrong.

Whichever you pick, the per-workspace DB layout on disk must stay
backward-compatible: an existing project must open without re-indexing.

## 5. Definition of done

- [ ] A workspace with 3 git worktrees indexes all three, each with a live watcher
- [ ] Opening the app with agents running in 2 worktrees shows both, correctly attributed
- [ ] Reviewing the delta on branch A leaves branch B's delta unreviewed
- [ ] Two branches editing the same system surface as a collision **before** merge
- [ ] An existing single-root project opens with no re-index and no visible change
- [ ] `go test ./...` green from `archd-go`
- [ ] `npm run test:renderer` green
- [ ] `npm run test:mcp` green
- [ ] `npm run build` green
- [ ] New behavior has tests; concurrency changes have tests that would fail without them

## 6. Boundaries — files you must NOT edit

The companion worktree (`claude/workbench-spine`) owns these. Editing them
guarantees a merge conflict:

```
src/renderer/App.tsx                      (use the AgentLane mount point)
src/renderer/main.tsx
src/renderer/styles/global.css            (use styles/agents.css)
src/renderer/screens/**
src/renderer/components/StatusBar.tsx
src/renderer/components/DeltaPanel.tsx
src/renderer/components/OnboardingGuide.tsx
src/renderer/components/AgentConnectBanner.tsx
src/renderer/components/InjectConfirmBanner.tsx
src/renderer/store/onboardingStore.ts
```

`src/shared/types.ts` — append only, inside the marked
`── Parallel agents (Track A) ──` block at the end of the file.

Everything under `archd-go/`, `mcp/`, `src/renderer/canvas/`, and new files you
create are yours.

## 7. Working rules

- **Build after every Go change:** `npm run build:archd` (uses MSYS2 Go —
  TDM-GCC produces broken binaries on this machine). Never report done without it.
- Commit in coherent increments with real messages. Do not squash the whole
  track into one commit.
- Additive migrations only. An existing `~/.axiom/data` must survive.
- If you conclude part of this brief is wrong, say so in the commit message and
  in `PARALLEL_AGENTS_BRIEF.md` rather than silently doing something else.
- Prefer finishing §3.1–§3.4 well over starting §3.5–§3.6. The collision view is
  the point; the lane is how it is seen.

## 8. Suggested order

1. §4 — decide and implement the storage/concurrency shape. Test it under
   simulated parallel writes before anything depends on it.
2. §3.1 — worktree discovery and multi-watcher.
3. §3.2 — branch stamping, additive.
4. §3.3 — per-branch delta and watermark.
5. §3.4 — cross-branch collision read model + API.
6. §3.5 / §3.6 — MCP attribution and the lane UI.

Steps 1–2 are the risky ones. Get them right and the rest is mechanical.
