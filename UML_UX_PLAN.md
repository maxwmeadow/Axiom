# Axiom — UML Experience Layer: Sheets, Intent, and the Living Model

> Status: REVISED — see Revision 2 below, which supersedes the tab-based sheet
> model and adds the missing fundamental: UML authoring.
> Authors: Claude Fable 5 (research) + Gemini (challenge)
> Last updated: 2026-07-12

---

# REVISION 2 — Layers over the Floor, and Authoring-First UML

User review of the U1 build surfaced two fundamental corrections. These
supersede the "Floor vs Sheets as separate canvases" framing below (the data
layer — sheets/elements/annotations/outbox schema, ASM, MCP tools, the canvas→
agent channel — carries forward; the *presentation and authoring model* changes).

## Correction 1: Users must be able to MAKE UML, not just curate it

The v1 sheet system could only reference elements that already exist. That
misses the entire point of UML: **you draw the design first** — your own
system boxes, your own class/file nodes with function compartments, your own
edges — for code that does not exist yet. Then the drawing becomes the spec.

This is visual **spec-driven development**, the dominant 2026 agent workflow
("the spec declares intent; the code realizes it"), with tldraw's Make Real as
prior art for drawn-design→agent-build. Axiom's unfair advantage over both: the
same canvas already knows reality, so the drawn spec can *reconcile* against
what the agent actually builds.

### Planned elements

A sheet can contain, alongside live references:

- **Planned system** — a named bounding box that groups planned + live nodes
- **Planned class/file node** — the classic UML box: name, `declared_path`
  hint, ordered member compartment (function/method signatures the user types)
- **Planned edges** — `CALLS` / `DEPENDS_ON` / `CONTAINS` between any mix of
  planned and live nodes ("NewAuthService calls file://src/db/session.ts")

### Lifecycle: planned → partially realized → realized → live

The mirror image of tombstones (a live element that died); a planned element
is one not yet born. Reconciliation runs on the watcher/index pass:

1. exact `declared_path` match, then
2. fuzzy match (name similarity ≥ .85 + member-signature overlap), never silent
   on low confidence — a "link to…" affordance instead

Partial realization renders in the compartment itself: realized members green
(click-through to code), pending members amber, node badge "3 of 5 realized".
At 100% the user can **flatten** — the planned node becomes a plain live
reference and the spec record archives. Deleted/moved anchors get a
"disconnected anchor" badge, never silent drift.

### The sheet as prompt (the loop that matters)

"Send to agent" on a sheet with planned elements renders a **build spec** from
ASM: target additions (paths, member signature tables, intent notes),
structural intent ("planned `AuthService.login()` calls live
`file://src/db/session.ts`"), and precise live-context links so the agent
doesn't search-hallucinate. The agent builds; the watcher sees the files
arrive; the boxes turn green on the user's screen as reality catches up to the
drawing. **Draw → send → watch it come true.** Planned elements render in ASM
with `[PLANNED]` / `[3/5 REALIZED]` tags; the diff grammar gains `PLAN` and
`REALIZE` verbs.

### Authoring ergonomics (from Visual Paradigm, minus the bloat)

Palette of five, not fourteen diagram types: system box, class/file node with
compartments, directed edge (CALLS / DEPENDS_ON / CONTAINS), note, boundary.
VP-style quick-create: compass handles on node hover — drag a handle to empty
space → radial menu (new class / new note / link existing) → auto-wired, name
editor focused. Double-click empty overlay space → new planned node.

## Correction 2: Sheets are LAYERS over the Floor, not tabs

The v1 build put each sheet on a separate canvas. Wrong model. **The Floor is
the base layer; sheets are Photoshop-style overlays stacked on it:**

- Activating a sheet dims the base (~0.3 opacity), highlights the sheet's live
  members *in place* (they keep their Floor positions — a sheet membership is
  a stencil over the real node, not a copy with its own coordinates)
- Planned elements + notes + intent edges draw on the overlay; planned nodes
  anchor to a live node via relative offset (they follow layout shifts) or
  float free
- The rail becomes a **layer panel**: eye toggles (multiple sheets visible,
  stacked), opacity, active-layer-only editing, z-order
- Everything stays spatially connected to reality — you see your design *in
  the context of* the system it extends, which is the entire reason Axiom
  exists

Consequences: `sheet_elements` per-sheet x/y applies only to planned/floating
elements (live members no longer carry sheet positions); the keyed-remount
ReactFlow swap is replaced by a single canvas with overlay node/edge layers and
a dim mask; per-sheet viewports become per-layer focus targets (`fitView` to
the layer's bounding box on activation).

### Schema delta (isolated, per hostile-review instinct: don't pollute live tables)

```sql
planned_nodes (
  id TEXT PRIMARY KEY, sheet_id TEXT REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'system'|'class'|'file'
  name TEXT NOT NULL,
  declared_path TEXT,              -- reconciliation hint
  members TEXT NOT NULL DEFAULT '[]', -- ordered json [{signature, intent, realized_symbol}]
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned'|'partial'|'realized'|'flattened'
  realized_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  anchor_element_id TEXT,          -- optional live anchor (sheet_elements id)
  anchor_dx REAL, anchor_dy REAL,  -- relative offset when anchored
  position_x REAL, position_y REAL, -- free-floating fallback
  notes TEXT, created_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL
);
planned_edges (
  id TEXT PRIMARY KEY, sheet_id TEXT REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- 'CALLS'|'DEPENDS_ON'|'CONTAINS'
  src_planned TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
  src_element TEXT,                -- or a live sheet_elements ref
  dst_planned TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
  dst_element TEXT,
  note TEXT
);
```

### Revised build order

- **U1.5 (next)**: overlay rendering (dim mask + stencil highlights + layer
  panel from the existing rail) — replaces the separate SheetCanvas
- **U2 (now the headline)**: planned nodes/edges + authoring palette +
  compass-handle quick-create + build-spec ASM + `plan_element`/`get_build_spec`
  MCP tools + reconciliation in the watcher pass
- Then the original U2 reality affordances, U3 intent, etc.

Biggest risk (Gemini, agreed): anchor drift when the base layer moves or an
anchor dies — mitigated by the disconnected-anchor badge and snap-to-free.

---

## Revision 2b — Unified Node Architecture (canvas/node system convergence)

Verdict after code-grounded review (Gemini, deep pass over AxiomCanvas +
all node components): **no full rebuild.** The layout engine (grid nesting,
depth scaling, snap previews, barrier drag) only manipulates ReactFlow
position/size metadata — it has zero dependency on node visuals, which live
entirely inside the node components. So the two visual languages converge
incrementally through one shared component:

**Every node = Shell × Body × Status**
- `NodeShell` — geometry (`box | folder | cylinder | hexagon | note`), border,
  dash (planned) vs solid (real), accent color. Drawn as an **inline SVG path
  inside the node's bounding box** with `overflow: visible` — never CSS
  clip-path (it clips badges/tooltips and hijacks clicks in transparent
  corners) and never chrome outside the bbox (breaks grid-drop offsets).
  Folder tab is notched *within* the box.
- Body — content by node role: child grid (systems), symbol compartments
  (files/planned classes), brand icon + legend (infra), member checklist
  (planned).
- Status — live | planned/partial/realized | tombstone, plus activity heat and
  runtime pulse overlays, all shape-independent.

**Container/leaf shape rule (refined):** containers with visible children use
structural shells (folder/box) so grid nesting works unchanged; leaves use any
shape. A shaped leaf that gains/expands children **morphs to the structural
box** while expanded and returns to its shape when collapsed.

**Migration order** (app stays working at every step):
1. `NodeShell` component (SVG shapes, validated on the sheet layer)
2. Port `PlannedUmlNode` (also fixes the shipped clip-path/folder-tab defects)
3. Port `InfraNode` (simplest body)
4. Port `FileNode` (validates heat borders, runtime badges, tooltips on shells)
5. Port `SystemNode` last (folder chrome around the existing grid + dropzones)
6. Then: live systems get folder tabs, `systems.color` drives shell accents,
   and shape becomes a property any node can carry (e.g. a live system the
   user marks as a data store renders as cylinder while collapsed)

---

# Original plan (v1) follows — presentation model superseded by Revision 2

---

## Vision

Axiom exists because UML fell away exactly when it became most needed: codebases now change faster than any hand-maintained diagram can follow. Every classic UML tool eventually produced the same artifact — a diagram that was true the day it was drawn and a lie six weeks later.

The classic tools' deepest idea was right: **one model, many diagrams.** Enterprise Architect, Visual Paradigm, MagicDraw, and Structurizr all separate the *model* (the single source of truth about elements and relationships) from *diagrams/views* (curated, arranged projections of it). What killed them was the model half: humans had to author it, and round-trip engineering — the promised code↔model sync — reliably broke down after two or three iterations, leaving model and code drifting apart forever.

**Axiom inverts the authorship.** The model is *derived*: archd parses, clusters, watches, and traces, so the model is always true by construction. What the human (and the agent) authors is everything the code cannot say about itself:

1. **Views** — which subset of the model matters for this story, arranged this way ("Sheets")
2. **Intent** — what the architecture is *supposed* to be, so reality can be checked against it
3. **Meaning** — names, notes, boundaries, decisions

This is the UML experience with the fatal flaw removed. You never redraw a class box because someone renamed the class — the box renames itself. You never wonder if the diagram is stale — staleness is structurally impossible for derived facts and *visibly flagged* for authored ones.

---

## Prior Art — What Each Generation Got Right and Wrong

| Tool / era | Got right | Got wrong (for us to avoid) |
|---|---|---|
| **Rational Rose** (90s) | Invented the category; model repository | Heavyweight ceremony; waterfall assumption that design precedes code |
| **Enterprise Architect / MagicDraw** | Industrial model repository, model-vs-diagram separation, traceability | Overwhelming UI (hundreds of element types); modeling became a specialist job |
| **Visual Paradigm** | Best-in-class *authoring ergonomics*: Model Explorer (tree → drag onto diagram), **Resource Catalog** (hover a shape → context-filtered palette of legal next actions), sweeper/magnet layout tools, format copier | Round-trip code sync that drifts; the model is still hand-fed |
| **StarUML / ArgoUML / Papyrus** | Lightweight, extensible | Same dead model problem, fewer ergonomics |
| **draw.io / Lucidchart / Miro / Excalidraw** | Zero learning curve, free-form joy, collaboration | No model at all — boxes are dumb pixels; instant rot |
| **PlantUML / Mermaid / D2** | Diagrams-as-code: versionable, diffable, PR-embeddable | Text authoring is its own ceremony; still hand-maintained truth |
| **Structurizr** (C4 reference) | **One model → many views** as executable DSL; view keys stable across regenerations | Model is still hand-written DSL; steep entry |
| **IcePanel** | C4 with drag-drop approachability; reality links to repos | Model still curated by hand |
| **AppMap** | **Sequence diagrams generated from runtime traces** — behavior diagrams nobody has to draw | Point-in-time recordings, not a living map |
| **ArchUnit / dependency-cruiser / go-arch-lint** | **Architecture as executable constraints** ("UI must not import DB") — fitness functions that fail CI on drift | Text rules divorced from any visual model |
| **CodeSee / Sourcetrail** (dead) | Auto-derived code maps | Read-only: nothing to author, so nothing to care about; no agent era yet |

**The C4 model** (Context → Containers → Components → Code) matters most: it won modern architecture documentation *by restricting vocabulary* — four zoom levels, boxes and arrows, no 150-element UML palette. Axiom's existing hierarchy maps onto it almost perfectly:

| C4 level | Axiom equivalent | Derived from |
|---|---|---|
| **L1 System Context** | Workspace + Infra nodes | Roots + infra layer |
| **L2 Containers** | Top-level Systems (+ platform/db infra) | Clustering + user/agent curation |
| **L3 Components** | Sub-systems and Files | Clustering + assignments |
| **L4 Code** | Symbols (classes/functions) + call graph | Tree-sitter symbol table |

Axiom is, in effect, **a C4 tool whose model populates itself.**

---

## Core Concept: The Floor and the Sheets

Today Axiom has exactly one view: the live master canvas. That view is sacred — it must always show everything as it is. The UML experience adds authored views *beside* it, never instead of it. Drafting-room vocabulary, matching the existing aesthetic:

### The Floor (exists today)
The live master canvas. Every system, file, infra node, live heat, runtime traces. Always complete, always current, never editable in content — you arrange it, but you can't lie on it.

### Sheets (new)
A **Sheet** is a named, curated diagram: a subset of model elements, arranged by hand, annotated, with a declared purpose. The drafting-table metaphor is literal — sheets pinned over the board, each telling one story:

- *"Payment flow"* — 6 files, 2 infra nodes, arranged left-to-right
- *"Auth system context"* — one system expanded, its neighbors collapsed to single boxes
- *"Onboarding sequence"* — generated from a runtime investigation
- *"Intended layering"* — the architecture as it SHOULD be, constraints attached

The defining rule, inherited from Structurizr and EA but with live teeth:

> **A sheet element is a *reference* to a model element, never a copy.**

- Renames propagate instantly (the box renames itself mid-glance)
- New symbols appear in a class box the moment the agent writes them
- A deleted file doesn't vanish from your sheet — it renders as a **tombstone** (dashed, struck-through, "deleted 3h ago") until you acknowledge it, because the *gap between your story and reality* is precisely the information
- Elements carry their live overlays into sheets — activity heat, runtime pulses, watch badges — toggleable per sheet

What IS per-sheet: position, size, collapsed/expanded state, visual emphasis (dim/highlight), annotations, and which overlays are on. What is NEVER per-sheet: the element's name, contents, or real relationships.

### Sheet scope resolution (what "shows" on a sheet)

A sheet stores its member set explicitly (user dragged these things on) **plus** optional *scope rules* ("everything in the Payments system", "all infra touched by these files"). Rules keep sheets alive: a new file added to Payments appears on the Payments sheet automatically, ghosted-in with a "new" marker, exactly like the infra proposal tray — appears, you keep or dismiss. Detection proposes; the human confirms. Same philosophy everywhere.

---

## The Four Diagram Experiences

Instead of UML's 14 diagram types, four experiences that cover what people actually drew — each one powered by data Axiom already has:

### 1. Structure sheets (≈ component / package / C4 L2-L3)
The bread and butter. Systems, files, infra as boxes; import/call/infra edges. This is the existing canvas vocabulary, curated. Edge display per sheet: observed edges (derived, solid, weighted) can be shown, filtered, or hidden per sheet.

### 2. Class sheets (≈ class diagram / C4 L4)
Drop a *file* onto a sheet and expand it to **symbol level**: the classic three-compartment box (name / fields / methods) rendered from the live symbol table. Call-graph edges between symbols become method-level arrows. Tree-sitter already stores symbols with kinds and line spans; the detail panel already lists them — this promotes them to first-class diagram citizens on sheets (still never on the Floor, keeping the ARCHITECTURE.md rule that symbols aren't canvas nodes *there*).

Honest scoping: field/attribute extraction and type relationships (inheritance, implements) vary by language and parser depth — ship methods/functions first, enrich per language.

### 3. Sequence sheets (≈ sequence diagram — the AppMap move)
**Never hand-drawn. Always generated.** Axiom already captures runtime traces with args, returns, exceptions, and investigation recordings linked to commits. A sequence sheet is a projection: participants (files or symbols) as lifelines, observed calls as ordered arrows, real argument values on hover. Sources:
- a recorded investigation (replay → sequence view)
- a live watch session ("record the next 30 seconds")
- static fallback: a `get_call_path` result rendered as a *potential* sequence (visually distinct from observed)

This is the feature no classic tool could ship truthfully, and it falls out of the runtime layer nearly free.

### 4. Intent sheets (≈ the architecture nobody could enforce)
The bidirectional crown jewel. On any structure sheet the user can draw **intent edges** and **boundaries**:

- `ALLOWED` — "Payments → Stripe is expected" (documents; renders calm; never fires)
- `NO_DEPENDENCY` — "UI must never import DB directly" (an observed edge matching this = red violation, on the sheet AND on the Floor)
- `TRANSIT_INTERCEPT` — "every Handlers→DB call path must pass through Validation" (checked by call-graph reachability with the interceptor excluded — a binary edge can't express this; see data model)
- **Layer boundaries** (`LAYER_ORDER`) — named horizontal bands ("UI / Domain / Persistence"); systems assigned to bands; the classic rule "only downward dependencies" checked automatically

Intent is stored in the model (not per-sheet) and checked continuously against the live dependency + call graph — ArchUnit's fitness functions, but visual, live, and drawn instead of coded. Violations produce:
- red badges on the Floor and affected sheets
- a drift report (`get_drift_report` for agents, a panel for humans)
- optionally, a failing check an agent is told about *before* it writes code (`check_architecture` as a pre-flight)

Intent edges are visually unmistakable from observed edges: hand-drawn dashed strokes with an annotation flag vs. the solid weighted derived edges. You always know what's real and what's declared.

---

## Human UX Specification

### Navigation: the sheet rail
A left-edge vertical rail (drafting-cabinet drawer labels): The Floor pinned at top, sheets beneath, grouped by folder. Click to switch; the canvas swaps view state (same ReactFlow instance, different node/edge projection). Sheets are cheap — creating one is one click or one lasso.

### Creating and populating sheets
- **Lasso → "New sheet from selection"** — the existing lasso flow gains a second action beside "New System"
- **Blank sheet + Model Explorer** — a new left panel (VP's best idea): the model as a searchable tree (Systems → files → symbols; Infra; Investigations). Drag anything onto the sheet. This finally gives Axiom a text-first navigation surface alongside the spatial one
- **From an investigation** — "Open as sequence sheet" on any recorded investigation
- **By an agent** — "draw me the payment flow" (below)

### Arranging (the drafting feel)
- Free positioning, existing grid snapping; per-sheet positions never touch Floor positions
- **Alignment guides** (VP/Figma convention): live snap lines to neighbors' edges/centers
- **Sweeper** (VP): drag a rule-line across the sheet to open/close space — cheap, loved, on-brand for a drafting table
- Auto-layout offers per sheet: left-to-right flow (dependency direction), layered (respects intent bands), radial (focus node); always a suggestion the user can then adjust, never forced
- Format tools: per-sheet emphasis (accent color, dim), a format copier

### Annotating
- **Notes**: sticky drafting-margin notes, attachable to an element or floating; markdown; author-stamped (human vs agent — agent notes render with the agent amber accent)
- **Flags/labels** on edges and boxes ("legacy — kill in Q3")
- **Boundaries**: named rectangles/bands that hold members (used by intent checking)
- Sheet metadata: title block (bottom-right, like a real drawing: title, author, date, revision) — automatically maintained, deeply on-aesthetic

### Reality affordances on sheets
- **Tombstones** for deleted elements (dashed, struck, timestamped) — acknowledge to remove. **Anti-fatigue rules (hostile-review fix):** a tombstoned element the user never customized (no note, no intent reference, default position) is pruned silently; only invested-in elements earn a tombstone. Bulk operations (rebase deleting 15 files) collapse into one banner — "15 elements removed by refactor — review / dismiss all"
- **Ghost-ins** for rule-matched new elements — never drawn as individual boxes; they aggregate into a sheet-edge tray banner ("+5 new files in Payments — add / dismiss"), same pattern as the infra proposal tray
- **Drift badges** on intent violations
- A sheet header chip: "synced · 2 new · 1 deleted · 1 violation" — the sheet's health at a glance

### Prerequisite fix: the watcher is blind to deletes and renames
Verified in code: `watcher.go` only subscribes to `Write|Create` events, so today a deleted file's row lingers until full reindex, and a rename produces a new file row (new UUID) while the old one goes stale. Sheets make this visible, so U2 must fix it at the source: handle `Remove`/`Rename` fsnotify events (delete the row → SET NULL tombstones sheets; detect rename as remove+create with identical content hash — the activity engine's `content_hash` makes this cheap — and **remap the file row in place**, preserving its UUID, sheet memberships, positions, and activity history).

### Export (meet the ecosystem)
- Sheet → **Mermaid / PlantUML** text (structure and sequence), for PRs and docs
- Sheet → PNG/SVG with the title block
- Later: import Mermaid/Structurizr DSL as a *proposal* mapped onto real elements

---

## Agent Tools (the bidirectional half)

Every human action has an MCP twin, same as systems today:

```
list_sheets() / get_sheet(id)                 → sheets with members, annotations, health
create_sheet(name, purpose?, member_refs?, rules?)
add_to_sheet(sheet, refs) / remove_from_sheet(sheet, refs)
arrange_sheet(sheet, layout_hint)             → server-side auto-layout; agent never pushes x/y
annotate(sheet?, target_ref, note, kind)      → notes/flags, stamped as agent-authored
declare_intent(kind, src_ref, dst_ref, interceptor?, note?)
                                              → ALLOWED | NO_DEPENDENCY | TRANSIT_INTERCEPT
declare_boundary(name, member_systems, order) → layer bands
check_architecture(scope?)                    → intent violations NOW (agent pre-flight before edits)
get_drift_report()                            → violations + tombstones + unacknowledged ghosts
generate_sequence_sheet(investigation_id | from,to)
export_sheet(id, format)                      → mermaid | plantuml | svg
```

Two flows this unlocks:

**Agent as illustrator.** "Explain how checkout works" → the agent traces the path, creates a sheet, adds the six relevant files and Stripe, generates the sequence from a live trace, annotates the tricky hop, and hands the user a *link to a sheet* instead of a wall of prose. The investigation IS the documentation.

**Agent as constrained worker.** Before writing code, an agent calls `check_architecture` and reads intent: "FORBIDDEN: renderer → archd/internal/db". The human's drawn intent becomes the agent's guardrail — UML as an *input* to code generation, which is what UML always wanted to be and never was. Violations it would introduce are known before the diff exists.

Agent-authored sheets/notes always render with the agent accent so provenance is glanceable — same convention as `agentTouched` today.

---

## The Canvas-to-Agent Channel ("the canvas is the prompt box")

The missing half of bidirectionality: the user redesigns the UML on a sheet,
attaches a note, and **prompts the agent from the canvas, mid-session**, on any
MCP host (Claude Code, Codex, Copilot, Antigravity, …).

### Protocol reality check (verified against the 2026 spec landscape)

MCP is pull-based: hosts own the orchestration loop and ignore unsolicited
payloads. The tempting escape hatches don't survive contact:
- **Sampling** (`sampling/createMessage`, server→client LLM calls) is
  **deprecated as of spec 2026-07-28** (SEP-2577) and GitHub Copilot never
  supported it. Do not build on it.
- **Elicitation** is for forms/confirmations inside a tool call the *agent*
  initiated, and is being folded into Multi Round-Trip Requests (SEP-2322) —
  useful later, wrong shape for "user starts the conversation."
- Custom push transports ("reverse MCP") break universality immediately.

So the design uses only primitives every host already supports — tools, tool
results, and prompts — in three tiers:

### Tier 1 — the outbox + two delivery paths (universal, ships first)

archd keeps a per-workspace **canvas outbox**. The canvas "Send to agent"
action enqueues a message; the MCP server drains it. Two complementary
delivery paths:

1. **Piggyback delivery (the trick that makes it feel live).** Axiom owns one
   channel into every agent's context on every host: *its own tool results*.
   Every axiom MCP tool response gets a one-line trailer appended when the
   outbox is non-empty:
   `⚑ 1 unread canvas message from the user — call get_canvas_updates`.
   An agent that is using Axiom at all (tracing, watching, editing systems —
   which is constantly, in this product) receives the user's prompt within one
   tool call, with zero host-specific machinery. No polling loop, no config.
2. **Long-poll collaboration mode.** An `await_canvas(timeoutSeconds≤45)` tool
   blocks until a canvas message arrives or the window expires, returning
   `{message}` or `{timedOut: true, keep_waiting: true}` with instructions to
   call again. Short windows keep every call inside conservative host/transport
   timeouts (some HTTP transports drop calls at ~10s — the timeout is
   configurable per host profile, stdio hosts tolerate 45s+). An agent told
   "enter canvas collaboration mode" sits in this loop and the user drives the
   session entirely from the canvas — a chat whose input box is the diagram.

### Tier 2 — MCP Prompt (native, for interactive hosts)

The server exposes a `review-canvas` **MCP Prompt**. In hosts with prompt
support the user types `/axiom:review-canvas` (Claude Code renders it as a
slash command automatically) and the server injects the pending note + change
summary, perfectly formatted. This is the built-in way to *start* a session
from canvas state.

### Tier 3 — host adapters (optional enrichment, never required)

Where a host offers more, a thin adapter uses it: a shipped **Claude Code hook
snippet** (Stop-hook checks the outbox and blocks the agent from ending its
turn while unread canvas messages exist); MCP **Tasks** (SEP-1686) and Multi
Round-Trip Requests adopted as hosts land them. Feature-detected at
`initialize`; absence degrades to Tier 1 gracefully.

### What actually gets sent (semantic, not pixels)

The payload is never raw coordinates. The canvas composes:
- the user's **note** (markdown)
- the **selection** as durable refs (files/systems/infra/sheet)
- a **semantic change summary** of staged canvas actions since last send:
  "moved `validators.py` into Payments · drew NO_DEPENDENCY Renderer→DB ·
  renamed system 'Utils'→'Shared Kernel' · note attached to Payments"
- sheet id + intent context (any policies touching the selection)

### UX on the canvas

- **Note composer** on any selection (N or right-click → "Note to agent"):
  markdown box, "Send to agent" button, drafting-margin styling
- **Delivery states** on the note chip: queued → delivered (an agent picked it
  up, shows which host) → **answered** — the agent's reply arrives via the
  existing `annotate` tool and renders as an agent-amber note pinned to the
  same elements. Conversations become *threads attached to diagram elements*;
  the exchange is spatially anchored where the question lives
- Unanswered queued messages surface in the sheet-rail health chips

### How agents see sheets: ASM (Axiom Sheet Markup)

Agents can't see the canvas, so every sheet feature must round-trip through
text. `get_sheet` renders **ASM** — a compact markdown-like format (~300–800
tokens for a 10–40 element sheet), chosen over JSON (token-heavy) and Mermaid
(can't carry health/notes):

```text
sheet: "Payment flow" — rev 7 · 1 ghost · 1 violation

sys://Payments as "Payments"
  file://src/services/payment.py
    note(user): "amount validation lives here — fragile"
  file://src/services/validators.py
infra://stripe/api as "Stripe" 
file://src/legacy_pay.py [TOMBSTONE: deleted 2h ago]

# Intent
sys://Payments -!-> infra://postgresql/primary : "must go through repo layer"
```

- **Durable URI refs** (`file://relpath`, `sys://name-path`, `infra://service/name`,
  `sym://file::kind::name`) — agents quote them back; resolution cascade:
  exact URI → unique suffix → ambiguity returns a choice list
- **Containment by indentation**; layout is *topological only* — x/y never
  appears, but definition order preserves left-to-right flow meaning
- **Health as bracket tags** (`[GHOST]`, `[TOMBSTONE]`, `[VIOLATION: id]`),
  intent as arrow operators (`->` expected, `-!->` forbidden)
- **Elision**: systems with no notes/policies/violations collapse to
  `sys://auth (18 files elided)`

Change summaries (outbox + sheet revision diffs) use a **12-verb grammar** —
`ADD, REMOVE, CREATE_GROUP, UNGROUP, MOVE, CONNECT, DISCONNECT, SET_POLICY,
CLEAR_POLICY, NOTE, RENAME, HEAL` — with aggregation ("MOVE 12 files matching
file://src/validators/* into sys://core/validation").

### New MCP surface

```
get_canvas_updates()        → drain outbox: notes + semantic change summaries
await_canvas(timeout_s)     → long-poll; keep_waiting contract for re-arm
reply_to_canvas(msg_id, body) → sugar over annotate: threads the answer to the note
```

Plus the `review-canvas` MCP Prompt, and the outbox trailer appended to every
tool response.

---

## Data Model

```sql
sheets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  purpose       TEXT,                         -- shown in title block
  kind          TEXT NOT NULL DEFAULT 'structure',  -- 'structure'|'class'|'sequence'|'intent'
  folder        TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT 'user', -- 'user'|'agent'
  revision      INTEGER NOT NULL DEFAULT 1,   -- bumps on member/annotation change (title block)
  viewport      TEXT,                         -- json {x,y,zoom} — restored on open
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Membership: reference + per-sheet presentation.
-- Hostile-review fix: NOT the polymorphic (type,id) pattern — concrete
-- nullable FKs (exactly one set, CHECK-enforced) give native referential
-- integrity with no trigger web. ON DELETE SET NULL + the cached label IS the
-- tombstone mechanism: when the ref goes NULL but label remains, the element
-- renders as a tombstone ("payments/handler.go — deleted") with zero triggers.
sheet_elements (
  id            TEXT PRIMARY KEY,
  sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  system_id     TEXT REFERENCES systems(id)     ON DELETE SET NULL,
  file_id       TEXT REFERENCES files(id)       ON DELETE SET NULL,
  infra_id      TEXT REFERENCES infra_nodes(id) ON DELETE SET NULL,
  symbol_ref    TEXT,             -- symbols lack stable ids: 'fileId::kind::name' (see U4)
  label         TEXT NOT NULL,    -- display snapshot, cached at add time — powers tombstones
  position_x    REAL NOT NULL DEFAULT 0,
  position_y    REAL NOT NULL DEFAULT 0,
  width REAL, height REAL,
  emphasis      TEXT,             -- json: {dim, accent, expandedToSymbols}
  tombstone_ack INTEGER NOT NULL DEFAULT 0,   -- user acknowledged; row then pruned
  ghost         INTEGER NOT NULL DEFAULT 0,   -- rule-matched, awaiting keep/dismiss
  added_by      TEXT NOT NULL DEFAULT 'user',
  CHECK ((system_id IS NOT NULL) + (file_id IS NOT NULL) +
         (infra_id IS NOT NULL) + (symbol_ref IS NOT NULL) = 1)
);

sheet_rules (               -- live scope rules ("everything in system X")
  id TEXT PRIMARY KEY, sheet_id TEXT REFERENCES sheets(id) ON DELETE CASCADE,
  rule TEXT NOT NULL        -- json: {kind:'system-members'|'infra-of'|..., args}
);

annotations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sheet_id     TEXT REFERENCES sheets(id) ON DELETE CASCADE,  -- null = model-global note
  target_type  TEXT, target_id TEXT,       -- null = floating
  body         TEXT NOT NULL,              -- markdown
  kind         TEXT NOT NULL DEFAULT 'note',  -- 'note'|'flag'|'decision'
  author       TEXT NOT NULL DEFAULT 'user',
  position_x REAL, position_y REAL,
  created_at INTEGER NOT NULL
);

-- Intent lives in the MODEL, not on sheets. Checked against live graph.
-- Hostile-review fix: intent is a POLICY, not a bare edge, because "every
-- handler must go through validation" is a ternary transit rule that a binary
-- dependency edge cannot express (an unrelated Handlers→Validators edge would
-- mask a bypassing path). Kinds:
--   NO_DEPENDENCY      (was FORBIDDEN)  src must not reach dst
--   ALLOWED            documents an expected edge (renders calm, never fires)
--   TRANSIT_INTERCEPT  every src→dst call path must pass through interceptor;
--                      checked by BFS on the call graph EXCLUDING interceptor
--                      nodes — if dst is still reachable, a bypass exists
--   LAYER_ORDER        boundaries only depend downward
intent_policies (
  id TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  src_type  TEXT NOT NULL, src_id TEXT NOT NULL,   -- system|infra|boundary
  dst_type  TEXT NOT NULL, dst_id TEXT NOT NULL,
  interceptor_id TEXT,          -- required for TRANSIT_INTERCEPT (a system id)
  exclude        TEXT,          -- json globs: tests/mocks don't follow prod rules
  note           TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

boundaries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  name TEXT NOT NULL, layer_order INTEGER NOT NULL,   -- for "downward only"
  member_system_ids TEXT NOT NULL                     -- json array
);

canvas_outbox (               -- user→agent messages composed on the canvas
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  sheet_id      TEXT,
  note          TEXT NOT NULL,              -- user's markdown
  selection     TEXT NOT NULL DEFAULT '[]', -- json durable refs
  change_summary TEXT NOT NULL DEFAULT '',  -- semantic staged-changes text
  status        TEXT NOT NULL DEFAULT 'queued',  -- 'queued'|'delivered'|'answered'
  delivered_to  TEXT,                       -- host/agent identifier if known
  answer_annotation_id TEXT,                -- threads the agent's reply
  created_at INTEGER NOT NULL, delivered_at INTEGER, answered_at INTEGER
);

intent_violations (           -- materialized by the checker; drives badges
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES intent_policies(id) ON DELETE CASCADE,
  observed_dependency_id TEXT,          -- the offending real edge (NO_DEPENDENCY)
  detail TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'   -- 'open'|'acknowledged'|'resolved'
);
```

**Checker execution (hostile-review fix):** never synchronous with the write
path. archd uses a single write connection (`SetMaxOpenConns(1)`); a checker
running recursive reachability queries inline with watcher saves would lock the
DB and stall the canvas. Instead: a dedicated goroutine with its own read-only
SQLite connection, **debounced 3–5s** after the last graph change; full transit
(BFS) checks additionally run on demand (`check_architecture` pre-flight,
"Check now" button). `NO_DEPENDENCY`/`LAYER_ORDER` are cheap set checks;
`TRANSIT_INTERCEPT` is the expensive one and is scoped to the policy's src/dst
closure. `exclude` globs keep tests and mocks from flooding violations.

### Renderer
- `sheetStore` alongside graphStore: active sheet id, member projections, annotations
- The canvas becomes projection-driven: Floor projection (today's builder) vs sheet projection (member refs joined to live graphStore data + per-sheet positions). Node components unchanged, which is why sheets inherit live heat/pulses for free
- **Keyed remount per sheet (hostile-review fix):** `<ReactFlow key={activeSheetId}>` — a shared instance would animate nodes sliding between Floor and sheet coordinates on switch, bleed selection/drag state, and share one viewport. Each sheet persists its own viewport (`sheets.viewport`), restored on open
- New node types: `NoteNode`, `BoundaryBand`, `SymbolNode` (class-box compartments), `LifelineNode`/sequence layout (sequence sheets are a special layout engine, not free-form)

### Storage: Git-colocated, SQLite-cached (hostile-review fix)
Sheets locked in a local SQLite file can't follow branches or reach teammates —
the exact CodeSee failure. Authored artifacts (sheets, rules, annotations,
intent policies) live in **`.axiom/sheets/` as JSON files in the repo**, one
file per sheet, referencing elements by durable keys (rel_path for files,
system name-path for systems, service+name for infra). archd watches the
directory and syncs into SQLite (the runtime cache/join layer); canvas edits
write back debounced. Consequences, all good: sheets branch with the code,
merge in PRs, diff in reviews — and an agent can author or amend a sheet as
part of its code diff, which is the deepest form of bidirectionality this
design gets.

---

## Compared to the Live Structure (what changes, what doesn't)

| | The Floor (today) | Sheets (new) |
|---|---|---|
| Content | Everything, always | Curated subset + rules |
| Truth | Derived, uneditable | References to derived truth + authored intent/meaning |
| Layout | One global arrangement | Per-sheet arrangements |
| Staleness | Impossible | Impossible for facts; *visible* (tombstones/ghosts/badges) for curation |
| Audience | "What is this codebase?" | "Let me tell you a story about this codebase" |
| Agent role | Reads + organizes systems | Reads intent as guardrails; authors sheets as explanations |

---

## Build Roadmap

### Phase U1 — Sheets core (2 wks)
Schema (sheets, sheet_elements, annotations), CRUD API + WS patches, sheet rail UI, lasso→sheet, Floor/sheet projection switch in canvas, per-sheet positions, notes. MCP: list/create/add/annotate.

### Phase U2 — Reality affordances + Model Explorer (1–1.5 wks)
Tombstone/ghost lifecycle (triggers + acknowledge UX), sheet rules ("members of system X"), sheet health chip, Model Explorer panel with drag-to-sheet, alignment guides.

### Phase U3 — Intent + drift (2 wks)
intent_edges/boundaries/violations schema, drawn intent edges + boundary bands on sheets, the checker + Floor/sheet badges, drift panel. MCP: declare_intent, declare_boundary, check_architecture, get_drift_report. *This is the phase that makes Axiom UML rather than a diagram viewer.*

### Phase U4 — Class sheets (1–1.5 wks)
SymbolNode with compartments from the symbol table, expand-file-to-symbols on sheets, symbol-level call edges, per-language enrichment as parser allows.

### Phase U5 — Sequence sheets (1.5–2 wks)
Sequence layout engine, generate from investigation / live watch window / static call path (visually distinct), hover for real values. MCP: generate_sequence_sheet.

### Phase U6 — Interop (1 wk)
Mermaid/PlantUML/SVG export with title block; auto-layout suite (flow/layered/radial); format copier + sweeper.

### Phase U-C — Canvas-to-Agent channel (1–1.5 wks; parallel-safe, can ship right after U1)
canvas_outbox schema + API, note composer + delivery states on canvas,
`get_canvas_updates`/`await_canvas`/`reply_to_canvas` tools, the piggyback
trailer on all axiom tool responses, `review-canvas` MCP Prompt, Claude Code
Stop-hook snippet. Depends only on U1 (notes/annotations for replies) — this
is deliberately early because it multiplies the value of every later phase.

---

## Hostile Review Summary

Gemini challenged the draft at deep thinking depth; seven issues, all resolved inline above:

1. **Polymorphic refs** (high) — `(type,id)` string refs would need a fragile trigger web. → Concrete nullable FKs with a CHECK, `ON DELETE SET NULL` + cached `label` = trigger-free tombstones.
2. **Symbol fragility** (high) — name+kind matching breaks on every refactor. → Scoped symbol keys (`fileId::kind::name`), fuzzy re-resolution on reparse (kind + relative position + span similarity) before tombstoning; noisy cases surface a "re-link" affordance rather than silently guessing.
3. **REQUIRED semantics are unsound as a binary edge** (high) — an unrelated existing edge masks bypass paths. → Ternary `TRANSIT_INTERCEPT` policies checked by reachability-with-interceptor-removed on the call graph.
4. **Checker vs the single write connection** (high) — inline checking stalls the canvas. → Dedicated read-only connection, async + debounced; transit checks on demand; exclude globs for tests/mocks.
5. **ReactFlow projection switching** (medium) — shared instance = sliding nodes, viewport/selection bleed. → Keyed remount + per-sheet persisted viewport.
6. **Tombstone/ghost fatigue** (medium) — refactors flood sheets with chores. → Auto-prune uninvested tombstones, aggregate ghosts into tray banners, bulk review.
7. **Local-only sheets can't collaborate or branch** (medium) — → Git-colocated `.axiom/sheets/` JSON as source of truth, SQLite as cache; agents amend sheets inside code PRs.

Plus one flaw the review missed, found by code inspection: **the watcher never subscribed to Remove/Rename events**, so deletions are invisible to the live model today. Fixed as a U2 prerequisite (with content-hash rename remapping that preserves element identity).

---

## Open Decisions

1. **Sheet position persistence for Floor** — sheets get their own positions; should creating a sheet from lasso *copy* current Floor positions as the starting arrangement? Recommendation: yes (least surprise).
2. **Symbol references and rename tracking** — symbols have no stable IDs across reparses (keyed by name+file today). Sheet refs to symbols must re-resolve by (file, name, kind) and tombstone on miss. Acceptable for U4; revisit stable symbol IDs if churn hurts.
3. **Intent granularity** — file-level intent edges invite noise; recommendation: allow system- and boundary-level only in U3, file-level later behind a flag.
4. **Violation acknowledgment semantics** — acknowledged violations: suppressed forever or until edge weight changes? Recommendation: until the observed edge changes (re-alert on growth).
5. **Sequence sheet participant granularity** — file lifelines (matches trace data today) vs symbol lifelines (needs symbol attribution in events — Python adapter has it, delve partially). Ship file-level first.
