# Codex overnight brief — Phase 4: Trustworthy realization

You are working in a **git worktree** at `C:\Users\maxst\VSCodeProjects\axiom-codex`
on branch `codex/realization`, branched from `2cc492e`.

Another agent is working concurrently in `C:\Users\maxst\VSCodeProjects\Axiom`
on branch `claude/mcp`. **Stay in this directory.** Do not touch the other
worktree, and do not switch branches.

First thing: run `npm install` here. The worktree has no `node_modules`
(gitignored), and you will need it for `tsc` and the renderer tests. It is
slow — native modules plus `electron-rebuild` — so start it before anything
else.

---

## Why this task, and why first

Your own plan identified the sharpest problem in Axiom and scheduled it fifth.
It should be first, because everything else in the plan sits on top of it.

The loop now runs end to end: draw → dispatch → agent builds → realization goes
green → Morning Delta reports drift. The single thing that determines whether
any of that is worth anything is whether **green is true**. Right now it isn't.

Making the experience more coherent, rebuilding the MCP, or upgrading authoring
on top of a realization signal that lies just makes the lie more prominent and
more trusted. Fix the truth first.

---

## What is wrong, specifically

### 1. Reconciliation cannot prove an interface was implemented

`archd-go/internal/db/planned.go`, `ReconcilePlanned` (~line 276):

- Matches a planned node to a file by **suffix-tolerant lowercase path**.
- Matches members by **bare lowercase symbol name** via `memberName(...)`.

Meanwhile the renderer captures genuinely structured metadata — visibility,
parameters, return types, endpoints — in `src/renderer/store/sheetStore.ts` and
`src/renderer/canvas/nodes/UmlMetadataPanel.tsx`.

Result: a planned `interface RateLimiter { allow(key: string): boolean }` flips
to `realized` when any file at a fuzzily-matching path contains something
called `allow`, with any signature, any return type, any arity. The diagram
reports success while the contract it described was never honoured.

### 2. Drift classification is binary

`archd-go/internal/delta/intent.go`, `ClassifyIntentDrift` (~line 83) emits
exactly `expected` / `unexpected`.

Real engineering is not binary. An agent that satisfies your intent with a
reasonable implementation variation is the normal case, not a failure, and
calling it drift trains people to ignore the signal.

---

## Deliverables

### A. Interface-aware reconciliation

Verify the structured contract, not the name:

- Match by **qualified symbol**, not bare lowercase name.
- Compare **arity and parameter types** where the planned member declares them.
- Compare **return type** where declared.
- Compare **visibility** where declared.
- Path matching should get stricter, or at minimum report *how* it matched, so
  a coincidental suffix match is distinguishable from an exact one.

Where the planned member declares nothing structured, fall back to today's
name match — a diagram that only named a method should not suddenly stop
realizing. Partial contracts are normal; treat missing detail as "not asserted",
never as "mismatch".

### B. Five-state realization

Replace the binary with:

| State | Meaning |
|---|---|
| `MATCHED` | The code implements what was planned, contract included |
| `FLEXED` | Intent satisfied by a reasonable variation (renamed, different arity, moved) |
| `DRIFTED` | Contradicts or expands the agreed architecture |
| `MISSING` | Planned and never realized |
| `UNKNOWN` | Attribution or evidence insufficient to say |

`FLEXED` is the important one and the one to get right. Be explicit in the code
about what evidence promotes something to `FLEXED` rather than `DRIFTED`.

### C. Indexer corroboration

Agent-reported mappings are **evidence, not truth** — your phrase, and it is
correct. Any mapping an agent claims must be confirmed against what the indexer
actually parsed before it can reach `MATCHED`. An uncorroborated claim is at
best `UNKNOWN`.

---

## Files you own tonight

Work only in these:

- `archd-go/internal/db/planned.go` and its tests
- `archd-go/internal/delta/**` (all of it, including `claims.go`, `intent.go`)
- `archd-go/internal/api/delta.go`
- `src/renderer/canvas/deltaReview.ts`
- `src/renderer/components/DeltaPanel.tsx`

## Files you must NOT touch

The other agent is actively editing these:

- `mcp/**` — all of it
- `archd-go/internal/api/**` — **except** `delta.go`
- `archd-go/internal/db/agentlog.go`, `journal.go`, `worksession.go`
- `src/renderer/canvas/agentAction*`, `agentAttentionProjection*`
- `src/renderer/components/AgentLogPanel.tsx`, `Toolbar.tsx`
- `src/renderer/App.tsx`
- `src/renderer/store/graphStore.ts` — **except** the delta slice, if you truly
  must; prefer not to

## Shared files — append only

- `src/shared/types.ts` — add new types at the **end**, in your own section.
  Do not reformat or reorder anything that exists.
- `src/renderer/styles/global.css` — same rule: append a new section at the end.
- `archd-go/internal/db/db.go` — you should need **no** schema change;
  `planned_nodes` already carries structured members. If you genuinely need
  one, add it at the end of the additive-migration list and change nothing else.

---

## Rules that are not negotiable

1. **Read `CANVAS_BEHAVIOR_CONTRACT.md` before touching the renderer.** It
   records behavior that is intentionally tuned. Do not regress it.
2. **One consequence, one animation.** Two live streams reach the canvas and
   only the semantic stream may animate. If you find yourself adding an
   animation, check `src/renderer/canvas/agentActionVisual.ts` first — the rule
   is encoded there with tests. Double-firing animations is a known hazard the
   contract explicitly forbids.
3. **Run `npm run build:archd` after every Go change.** TDM-GCC produces broken
   binaries on this machine; that script uses the MSYS2 toolchain and is the
   only supported way to build.
4. **Do not weaken a test to make it pass.** If a test is wrong, say so in the
   commit message and explain why.

## Definition of done

All of these green, from this directory:

```
npm run build:archd
cd archd-go; go test ./...; cd ..
npm run test:renderer
npx tsc --noEmit
npm run build
```

Then commit to `codex/realization` with a message that states what changed and
what you deliberately left out. Do not merge to `main`; that happens in the
morning with both branches side by side.

## If you get blocked

Prefer finishing A and B completely over starting C. A half-finished five-state
classifier that reports `UNKNOWN` for everything is worse than the binary it
replaced. Leave anything unfinished clearly marked in the commit message rather
than half-wired.
