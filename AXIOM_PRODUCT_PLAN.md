# Axiom — Product Plan

Status: living document. Update the status markers as slices land.
Established: 2026-07-25 (product reframe). Last updated: 2026-07-29.

Related: [CANVAS_BEHAVIOR_CONTRACT.md](CANVAS_BEHAVIOR_CONTRACT.md) (observable
behavior that must not regress), [UML_UX_PLAN.md](UML_UX_PLAN.md),
[INFRA_LAYER_PLAN.md](INFRA_LAYER_PLAN.md),
[RUNTIME_LAYER_PLAN.md](RUNTIME_LAYER_PLAN.md).

---

## 1. The thesis

**Axiom is the shared command surface where a developer and their agents build
software together.** Bidirectional UML is the *substrate* that makes that
possible — it is not the product.

The framing this replaced was "a bidirectional UML workbench", which sounds
like documentation you maintain. Nobody opens documentation daily. The reframe
survives the research:

- **Reverse sync (code → map)** is not "keeping docs fresh". It is how you
  *review what your agents did* as an architectural diff instead of reading 40
  files.
- **Forward sync (map → code)** is not "generating code from diagrams". It is
  how you *hand agents the next increment* as spatial intent.
- The diagram is valuable **only because it is the one surface where human
  intent and agent reality are superimposed and both are live.**

### Why this is defensible

By 2026 the spec-driven-development space is crowded — spec-kit, Kiro, BMAD,
Cursor, Antigravity all ship "living specifications". **Every one of them is
text.** None is spatial, and none shows you the system *as it is being built*.

The wedge is **spatial + live + bidirectional**. A text spec cannot show you
your codebase materializing, cannot show three agents working four boundaries
right now, and cannot show which module drifted from what you intended.

### Non-negotiable feeling: alive

When an agent makes a file, you see it animate in. When a file is edited, you
see it. When a function is written that calls something, you see the line trace
to the other file. Semantic *systems* (clustered from real topology, not
folders) are already a core differentiator — this is **not** literal UML.

---

## 2. The daily loop

Mission Control is one surface for planning, reviewing, and prompting — all
visual, all live, all bidirectional.

1. **Morning delta** — open Axiom, see what agents changed while you weren't
   watching, rendered as architectural claims. Confirm or reject.
2. **Watch and steer** — as agents work, the map is live: planned (grey) →
   active (pulsing) → realized (green). See five parallel agents without
   reading a diff.
3. **Draw the next increment** — sketch the system/class/edge that should
   exist next.
4. **Dispatch** — the drawing becomes a build spec queued through the MCP;
   agents pick it up, and can post their *own* planned nodes for you to confirm.
5. **Zoom to truth** — the escape hatch that keeps it honest: any box → its
   files → its symbols → source, instantly.

Steps 1 and 2 are why you open it every day. That is where the agents are, and
this is the only place you can *see* them.

---

## 3. Design laws

Round-trip engineering died twice before, on *drift* (diagrams became shelfware
the moment code changed) and the *reconciliation paradox* (strict diagrams →
rigid boilerplate; flexible code → an unreadable spaghetti canvas). Auto-
reindexing at agent speed makes this **worse** if done naively. These are hard
constraints, not preferences:

| Failure mode | Law |
|---|---|
| Death Star spaghetti | Semantic zoom + deterministic per-cluster layout. **Never** render a flat graph. Agent reindex never resets human layout. |
| Diagram too coarse to debug | Map → symbol → source is always one zoom away. |
| Rigid generation | The drawing is *intent*, not a codegen straitjacket. Reconciliation **confirms**; it does not dictate. |
| Look-once destination | The daily surface is live agent activity and deltas, not static architecture. |
| Meaningless diffs | Review units are architectural **claims**, never raw events. |

---

## 4. Build sequence

Vertical slices. Each is a real, shippable increment, and each is a view over
the same event stream — so nothing is throwaway.

| # | Slice | Status |
|---|---|---|
| ① | **Living Canvas** — reverse-sync choreography | ✅ Shipped |
| ② | **Morning Delta** — architectural diff review | ✅ Built (needs live validation) |
| ③ | **Mission Control** — forward loop, draw → dispatch → green | ✅ Built |
| ④ | **Onboarding** — first-run delivers the "aha" | ✅ Built |

---

## ① Living Canvas — ✅ Shipped

**Goal:** the map reacts visibly and legibly to real code changes, whoever
makes them.

The pipeline already existed (fsnotify watcher → `ReindexFile` →
`hub.BroadcastPatch` → `graphStore.applyDbPatch`). It just wasn't
*choreographed*. That was the "half-built everywhere" feeling.

### Done

- [x] New file **materializes** in (green create pop with overshoot)
- [x] Edited file **pulses** teal on its perimeter
- [x] Deleted file performs a **red exit** before semantic removal
- [x] New/changed/removed calls **trace themselves** between files
  (`livingEdgeGeometry.ts`, `LivingFlowOverlay.tsx`)
- [x] Flows resolve to the nearest visible semantic ancestor at current zoom;
      internal flows surface as one container signal, never a self-loop
- [x] Symbol-level truth: only edges whose participating symbols actually
      changed animate — an unrelated edit cannot spray false activity
- [x] Coincident IMPORTS + CALLS renders one pulse, not two
- [x] Camera: `fitView` capped at `maxZoom 1.0`, debounced reframe-on-growth
      that yields to manual navigation
- [x] Pan jank fixed (visibility restamp only when zoom actually changes)
- [x] Churn heat de-noised so a fresh file reads as NEW, not hot
- [x] Unclassified files render at the Floor root (the map is always complete)
- [x] Locked in the contract under **Living relationships**

### Where it lives

`src/renderer/canvas/livingChoreography.ts`, `livingEdgeGeometry.ts`,
`livingVisibility.ts`, `livingDiagnostics.ts`, `LivingFlowOverlay.tsx`;
`archd-go/internal/indexer/living_events.go`.

---

## ② Morning Delta — ✅ Built, ⚠️ needs live validation

**Goal:** answer "what did my agents change while I wasn't watching?" as an
architectural diff you can act on.

The problem this solves: live choreography is *transient*. A `graph:patch` only
reaches a renderer that happens to be attached. The delta is what you get when
you were not there.

### Done — durable substrate

- [x] `structural_events` journal — denormalized, survives deletion of the file
      it describes, holds no foreign keys into semantic tables
- [x] **Net effect, not event log**: create+delete cancels, wire+unwire
      cancels, repeated saves collapse
- [x] No-op saves (unchanged content hash) never enter the delta
- [x] Watermark (`workspaces.delta_reviewed_at`); reading never acknowledges;
      never moves backwards; ack covers the window actually shown
- [x] 30-day retention with prune on read
- [x] First index is a **baseline**, not a delta. Classifier migrations
      likewise — they change how Axiom reads code, not the code
- [x] `ReconcileRoot` — catch-up scan at reopen through the same
      `ReindexFile`/`RemoveFile` paths, so work done while Axiom was **closed**
      produces a true delta. Never re-clusters, never touches layout

### Done — claims (the review unit)

The first version listed raw changes and was unreadable: one architectural fact
arrived as five rows. Claims fixed that.

- [x] A **claim** is the smallest statement that changes your understanding;
      call sites, imports and files are **evidence** nested underneath
- [x] Compaction: one new dependency = one claim regardless of call sites;
      twenty files importing one module = one claim, twenty evidence
- [x] IMPORTS accompanying a CALLS between the same files is not separate
      evidence
- [x] **Unclassified ≠ a different system** — a file the classifier hasn't
      placed has no boundary to cross
- [x] Claim kinds: coupling, decoupling, system added/removed, membership,
      unclassified, internal
- [x] **Cycle detection** — a coupling that closes a loop through current
      topology outranks everything
- [x] Ranking by consequence with sub-linear evidence weighting
- [x] Intra-system churn collapsed to one muted claim per system, hidden by
      default
- [x] Titles state content ("Api now depends on Storage"), never taxonomy

### Done — narration (bidirectional)

Topology says what moved; only the agent that moved it can say why.

- [x] `work_sessions` table; journal rows use exact declared scope for
      parallel attribution and remain unexplained when ownership is ambiguous
- [x] MCP tools: **`start_work`**, **`note_work`**, **`finish_work`**
- [x] Claims show the agent's own words — closing summary, falling back to the
      declared goal while work is in flight
- [x] Un-narrated agent changes marked **UNEXPLAINED** rather than hidden
- [x] Starting new work closes that MCP client's forgotten session without
      evicting other agents working in parallel

### Done — review surface

- [x] Docked full-height panel (replaced a horizontal scrubber — review is
      triage, not playback)
- [x] Panel sets its own type scale; legibility outranks chrome consistency
- [x] Narration header, then ranked claims, evidence folded away
- [x] `J`/`K` navigate, `Enter` expands, `Escape` leaves
- [x] Canvas **ghosting**: everything unrelated dims; subject, its contents and
      its containers stay lit
- [x] Claim-aware framing: a boundary claim frames both **systems**; zoom floor
      and ceiling so you never land illegibly
- [x] Marks reuse the living vocabulary — green created, teal edited, red
      deleted — and outrank churn heat during review
- [x] Delta refreshes when the app regains focus; overlapping reads coalesce,
      active reviews stay stable, and stale workspace responses are ignored
- [x] Reopen catch-up runs the guarded live-classification pass after file
      reconciliation, placing new semantic peers without touching authored
      systems or existing Floor layouts
- [x] Exact system-graph snapshots are persisted at delta review boundaries;
      before/after comparison surfaces systems that become connectivity hubs
      or lose their final architectural connection
- [x] Locked in the contract under **Morning Delta**

### Open items

- [ ] End-to-end validation with a real agent session (Antigravity + MCP)
- [x] **Interface bypass** claims — intentionally rejected: assumes systems declare
      public entrypoints, and Axiom's systems are clustered, not declared

### Where it lives

Backend: `archd-go/internal/db/journal.go`, `worksession.go`;
`internal/delta/{delta,claims}.go`; `internal/indexer/{journal,reconcile}.go`;
`internal/api/delta.go`.
Frontend: `src/renderer/canvas/deltaReview.ts`,
`src/renderer/components/DeltaPanel.tsx`, delta slice in
`src/renderer/store/graphStore.ts`.
MCP: `mcp/axiom-mcp.ts` (`start_work` / `note_work` / `finish_work`).
Live presence: `src/renderer/canvas/agentPresence.ts`,
`nodes/AgentPresenceBadge.tsx`; parallel session ownership and scoped
attribution: `archd-go/internal/db/worksession.go`.

---

## ③ Mission Control — ✅ Built

**Goal:** close the forward loop. Planning, prompting and reviewing, all
visual.

This is the half that makes Axiom bidirectional in both directions. The
reverse loop (②) is done; this is map → code.

### Planned scope

- [x] **Draw the increment** — sketch the system, class, or edge that should
      exist next (authoring already exists via UML_UX_PLAN Rev 2)
- [x] **Dispatch** — the active sheet becomes an immutable approved build spec
      attached to the canvas outbox message agents drain through MCP
- [x] **Agent proposes** — the agent reads the queue and posts its *own*
      planned nodes describing what it intends to do, for you to confirm
      before it writes code
- [x] **Confirm / reject** — approval is a first-class gesture on the canvas;
      pending proposals are excluded from reconciliation and executable specs,
      and agents poll `get_plan_status` before implementation
- [x] **Watch it go green** — planned → partial → realized as the agent builds.
      `db.ReconcilePlanned` already drives this on every reindex
- [x] **Message alongside the drawing** — dispatch carries the user's text,
      durable selection refs, exact sheet/Floor context, and approved build spec
- [x] **Live agent presence** — show which boundaries agents are working right
      now, so parallel work is visible without reading diffs
- [x] **Drift from intent** — agent claims are matched against immutable
      dispatched Sheet snapshots and labeled **EXPECTED** or **DRIFT**

### What ② already set up for this

Claims carry a `sessionId` and assert something *about the architecture* —
which is exactly what intent confirms or denies. Once planned elements exist
forward, a claim can be matched against one and marked **expected** or
**unexpected**. That converts the Morning Delta from "what changed" into
"**drift from intent**", which is the real destination.

### Open questions

- Connection model: MCP is universal and most agents can run a goal loop and
  poll the queue. Hooks via a plugin are a possible later addition.
- How approval interacts with an agent that is already mid-flight.

### Where it lives

Forward loop: `archd-go/internal/api/{asm,sheets}.go`,
`archd-go/internal/db/{planned,sheets}.go`, `mcp/axiom-mcp.ts`,
`src/renderer/store/sheetStore.ts`.
Presence: `archd-go/internal/db/worksession.go`,
`src/renderer/canvas/agentPresence.ts`.
Drift matching: `archd-go/internal/delta/intent.go`,
`src/renderer/components/DeltaPanel.tsx`.

---

## ④ Onboarding — ✅ Built

Deliberately last, so it has a real payoff to deliver.

- [x] First run **materializes your real codebase alive** — reverse sync
      proving itself, not "configure an index"
- [x] Then one **draw → dispatch → green** cycle — forward sync proving itself
- [x] Command Deck becomes a daily dashboard: what changed, what your agents
      are doing, what drifted — not a static launcher

State-driven guide: `src/renderer/components/OnboardingGuide.tsx`.
Daily read model: `archd-go/internal/api/command_deck.go`.

---

## 5. Testing

A repeatable protocol for ② lives in the session notes; the shape is:

1. Seed a scratch project with two disconnected module groups **before**
   opening it in Axiom (so the first index is a silent baseline).
2. Open, let it index, confirm no delta and ≥2 systems. Quit.
3. Have an agent create / edit / delete while Axiom is **closed**.
4. Reopen → the delta should appear.

Honesty checks worth repeating: a create+delete pair must not appear; a
byte-identical rewrite must not appear; three saves must read as one edited
file. For narration, instruct the agent to call `start_work` / `note_work` /
`finish_work` and confirm claims carry its words instead of `UNEXPLAINED`.

### Automated verification — 2026-07-29

- [x] `go test ./...` from `archd-go` — all backend, database, delta,
      indexing, parser, registry, and watcher packages pass
- [x] `npm run test:renderer` — 182/182 renderer and shared-logic tests pass
- [x] `npm run test:e2e` — 20/20 packaged Electron interaction tests pass
- [x] `npm run build` — main, preload, and renderer production bundles build
- [x] `git diff --check` — no whitespace errors

The remaining Antigravity + MCP check is intentionally not represented by a
mock: this machine has neither an Antigravity command nor a running
Antigravity process, so the real cross-process validation remains explicit in
the Morning Delta open items.

---

## 6. Status summary

| Area | State |
|---|---|
| Reverse sync (code → map) | Live and choreographed |
| Durable structural memory | Journal + net-effect delta |
| Architectural review | Claims, ranked, with evidence |
| Agent → human narration | MCP work sessions |
| Forward sync (map → code) | Draw, dispatch, approval, live presence and realization built |
| Drift-from-intent | Dispatched specs classify agent claims as expected or unexpected |
| Onboarding | Live baseline, guided first increment, and daily Command Deck built |
| Automated release audit | Go, renderer, build, and Electron E2E suites green |
| External live validation | Pending a real Antigravity + MCP session |
