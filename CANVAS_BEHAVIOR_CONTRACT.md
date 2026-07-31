# Axiom Canvas Behavior Contract

Status: preservation baseline for the renderer refactor  
Baseline commit: `7e55a2a` (`Canvas: stabilize extreme-zoom resize interactions`)  
Last verified: 2026-07-22

Product direction and slice status live in
[AXIOM_PRODUCT_PLAN.md](AXIOM_PRODUCT_PLAN.md). This document records *behavior*;
that one records *intent and progress*.

## Purpose

This document records behavior that exists and is intentionally tuned today.
Refactors may change ownership, module boundaries, and implementation details,
but must not change these observable results unless a later product decision
explicitly revises this contract.

The contract protects the current Floor, sheet overlay, semantic zoom, node
presentation, selection, resize, drag, connection, and persistence behavior
while `AxiomCanvas` is decomposed and the application visual system is rebuilt.

## Refactor rule

Every preservation refactor must satisfy all three gates:

1. Existing unit tests and TypeScript checks pass.
2. Canvas interaction smoke tests pass at ordinary and extreme zoom.
3. Approved screenshots remain visually equivalent within the documented
   dynamic regions (timestamps, runtime counts, and asynchronous data).

Structural extraction and visual redesign must be separate commits. A commit
that claims no visual change must not intentionally alter colors, spacing,
typography, silhouettes, reveal thresholds, geometry, or interaction timing.

## Viewport and camera

- Canvas zoom range is `0.02` through `100`.
- Initial viewport is `{ x: 0, y: 0, zoom: 0.5 }`, followed by `fitView` with
  `0.14` padding.
- Automatic live-growth reframes are debounced through classification and
  animate pan and zoom as one camera move. A pending reframe yields while the
  user is navigating instead of being discarded or fighting manual movement.
- React Flow's wheel zoom is disabled. Axiom owns wheel zoom.
- Each wheel step multiplies or divides the target zoom by `1.15`.
- Zoom eases toward its target by `15%` per animation frame.
- The flow coordinate beneath the pointer remains beneath the pointer while
  zooming.
- Wheel zoom works over revealed file-node content. An explicit `nowheel`
  ancestor opts a surface out of canvas zoom entirely.
- A scrollable region inside a node (file symbol list, class member list)
  consumes the wheel only while it can still scroll in that direction. At its
  boundary, and whenever its content is too short to scroll, the wheel returns
  to canvas zoom. A scroll region is never a permanent zoom dead-zone, and the
  canvas root itself never counts as node content.
- Normal mode pans with the primary, middle, or secondary drag accepted by
  React Flow. Selection mode reserves primary drag for partial-box selection
  and limits panning to middle/secondary drag.
- The canvas does not snap nodes to a grid.
- Off-screen culling activates only when the Floor contains more than 150
  React Flow nodes.

## Semantic zoom

- Container reveal is based on rendered size, not hierarchy depth.
- A measurable container reveals its children when
  `sqrt(worldWidth * worldHeight) * zoom >= 480` screen pixels.
- A child cannot reveal before all of its ancestors reveal.
- Hidden descendants fade to opacity `0`, become non-interactive at opacity
  `<= 0.1`, scale toward `0.92`, and blur toward `3px`.
- Opacity transitions over `0.25s ease-out`.
- A node being dragged or directly interacted with is forced fully visible.
- File detail reveals when effective zoom reaches `1.075`, where effective
  zoom is viewport zoom multiplied by the node world scale.
- File details crossfade over `0.25s`; hidden details do not receive pointer
  events.

## World geometry and presentation

- A depth-zero file frame is authored at `220 x 110` flow units.
- File cells halve per depth level (`FILE_SCALE = 2`) with floors of
  `80 x 44` flow units.
- Grid gap and system header height are derived from half the file-cell height
  at that depth.
- File content uses a `220 x 110` presentation reference.
- Infra content uses a `260 x 160` presentation reference.
- Systems use their authored presentation base dimensions, falling back to
  their current dimensions and then `620 x 420`.
- Presentation scale is uniform and controlled by the limiting axis. Resizing
  may change aspect ratio without stretching typography or internal chrome.
- Presentation scale is `canonical size / authored design size`. Both terms are
  canonical: it carries no world-scale factor on either side, so it is blind to
  nesting depth and to interior compression. It is computed once, in the
  projection. Components consume it and must never re-derive it from rendered
  dimensions.
- Depth reaches system chrome through `DEPTH_TITLE_PX` and nowhere else.
- A frame has two scales. `scale` is its own size in its parent's space;
  `interiorScale` is how much it compresses its contents. A child's world scale
  is `parent.worldScale x parent.interiorScale x child.scale`.
- A frame's own geometry, chrome, and presentation scale are never expressed in
  terms of its `interiorScale`, so compressing an interior cannot disturb the
  frame itself or anything outside it.
- Child positions and sizes convert through the parent's **content** scale;
  the parent's own box converts through its own world scale.
- Every layout write replaces a whole row, so `interiorScale` is mandatory on
  `FloorLayout` — a writer that is not about compression must carry it through.
- Node shells fill the live frame synchronously. Shell geometry must not trail
  resizing through a React-state measurement loop.
- Container children remain visually stationary when a north or west parent
  edge moves; their persisted local positions are compensated accordingly.
- Dragging a container moves every descendant as one rigid visual body; child
  wrappers must not ease behind the parent.

## Node visual states

### Files

- Compact and detailed states share one shell and one frame.
- Detailed symbol content remains `nodrag` and `nopan` but does not suppress
  canvas wheel zoom.
- Dimmed files render at opacity `0.22` with reduced saturation.
- Watched/runtime files can display pulse, call count, args, return,
  exception, rate-limit, perturbation, and verdict feedback.
- Runtime exception, rate-limit, perturbation, and success states keep their
  current semantic colors.
- Live filesystem edits always ping the affected file regardless of writer.
  Updates use teal, creation uses green, and deletion performs a red exit
  before semantic removal.
- File connection handles remain invisible until React Flow needs them and
  must never create a large invisible interaction surface at extreme zoom.

### Systems

- The system structural silhouette exists at every zoom.
- The centered identity and the detailed header/grid crossfade according to
  child reveal.
- Activity on a hidden descendant surfaces on the nearest visible semantic
  ancestor as a lower-right structural rail. The rail must remain clear of
  both the collapsed centered identity and the expanded title/tab band.
- Dimmed systems render at opacity `0.3`.
- Drop preview translation affects the visual shell, not the logical React
  Flow frame or interaction chrome.

### Infrastructure

- Category determines silhouette; provider/service determines identity and
  accent treatment.
- Proposed infrastructure is dashed and renders at opacity `0.65`.
- Missing registry entries retain an editable fallback node rather than
  disappearing.

### Planned UML elements

- Planned and partial elements remain visually distinct from realized/live
  elements.
- User-authored planned elements are approved intent. Agent-authored planned
  elements enter as pending proposals and must expose Confirm/Reject directly
  on the canvas.
- Pending and rejected agent proposals never enter planned reconciliation,
  build specs, or dispatched Sheet context. Rejection is final; agents poll
  the proposal status and must not implement before approval.
- Planned/partial outlines are dashed; realized/flattened outlines are solid.
- Realized members display independently from pending members.
- Status colors remain: planned/neutral, partial/warning, realized/success.
- Dispatch snapshots the active Sheet's approved build spec together with its
  live Floor context and the user's text. Later Sheet edits cannot mutate an
  already queued work order.
- Work-session presence is projected onto every declared live file/system
  boundary. Multiple agents can remain active on the same boundary and are
  shown together; finishing one session removes only that agent's presence.
- Morning Delta compares agent-produced claims with immutable dispatch
  snapshots. A matching plan or planned edge dispatched before the change is
  EXPECTED; unmatched agent work is DRIFT. Human work is not judged against an
  agent work order.

## Selection and resize

- A selected resizable node has one authoritative selection outline. Node
  components must not add a duplicate selected-frame border.
- The outline is one composed screen pixel at every viewport zoom.
- Eight resize anchors are located at the exact `0%`, `50%`, and `100%` SVG
  frame coordinates.
- Each visible resize anchor is `8 x 8` composed screen pixels.
- Each resize hit target is `18 x 18` composed screen pixels.
- Outline, visible anchors, and hit targets share one SVG coordinate system.
  CSS inverse-transform placement must not be reintroduced.
- Resize starts from controlled fractional width/height. Integer DOM
  `offsetWidth`/`offsetHeight` measurements are fallback data only.
- Pointer-to-flow conversion remains floating point. At `100x`, a one-screen-
  pixel movement changes geometry by `0.01` flow units.
- All eight directions resize independently, preserve the opposite edge when
  clamped, and support arbitrary aspect ratios.
- Pointer capture loss, pointer cancellation, window blur, rerender, and
  unmount terminate the resize session cleanly.
- Selection chrome follows the node's own DOM transform and must not update
  through an independently sampled portal frame.
- The shell drop shadow is suppressed only during active resizing to prevent
  Chromium from retaining a stale filtered surface.

## Selection, editing, and connections

- Read-only mode disables node changes, edge changes, dragging, connecting,
  box selection, and element selection.
- Box selection uses partial intersection while selection mode is active.
- Editable text, symbol rows, buttons, and scroll regions do not begin node
  drags or pane pans.
- Floor nodes are not manually connectable.
- Nodes become connectable on an active editable sheet overlay.
- Planned edges may connect planned and live sheet members according to the
  current sheet authoring rules.
- Default rendered edges use the orthogonal edge implementation.

## Floor, sheets, and persistence

- The Floor remains the live base model.
- Sheets are overlays over the Floor, not independent truth copies.

### What a sheet is (revised 2026-07-30)

- A sheet is a set of POSITION OPINIONS about live nodes plus a set of
  ADDITIONS that exist only on that sheet. It is not a subset of the map and
  never a copy of it. This is what makes a sheet an *alternative architecture*
  you can propose and hand to an agent.
- **Live nodes are anchored.** A sheet may move a live node anywhere, including
  into a different system, but it can never delete one. Removing a live node
  from a sheet discards only the sheet's opinion about where it sits, returning
  it to its Floor position. Deleting live code happens on the Floor.
- A sheet may freely delete its own content — planned elements and annotations
  belong to the sheet.
- **Nothing is scenery.** Every live node renders exactly once, at whichever
  position applies, fully interactive. The Floor is never drawn a second time
  as a dimmed, non-interactive base layer beneath a sheet: that duplication is
  what forced the base layer to be inert, and made working on a sheet feel like
  drawing on glass over the architecture instead of in it.
- A node the sheet has no opinion about is not re-created by the projection at
  all, so the Floor's own layout continues to work underneath unchanged.
- A node the sheet moves detaches from Floor containment, because a proposed
  arrangement is not bound by the current one.

### Sheet transitions

- Switching between the Floor and a sheet animates, because a cut between two
  static layouts hides what moved and whether it is even the same map.
- Two signals, never confused: live nodes the sheet repositions **glide**
  between their Floor and sheet positions and never fade, because they exist in
  both worlds; sheet-only additions **fade** in and out, because they do not.
- Live nodes the sheet says nothing about neither move nor fade.
- Additions resolve faster than movement and, on entry, start slightly later,
  so the rearrangement reads as the primary event.
- Transition state is a projection, never canvas state, so a layout, zoom or
  selection pass cannot strand a node mid-flight.
- Fading is driven by explicit progress rather than a CSS keyframe, so an
  interrupted transition resolves to a real opacity instead of snapping.
- Switching sheets mid-flight still takes out the previous sheet's additions;
  content is never stranded half-visible. A node the new plan moves is never
  also faded.
- Activating a sheet preserves live identity and displays planned/floating
  content through an interaction snapshot.
- Floor geometry persists as canonical layout geometry, independent of the
  current world/presentation scale.
- Incremental layout reconciliation registers persisted siblings before
  placing newcomers, persists missing geometry, and may grow (never shrink)
  an authored container to contain a newly indexed child.
- There is exactly one gap, `FRAME_ITEM_GAP`. It is the clearance between two
  occupants of a frame *and* between an occupant and the frame's own edge.
  Every in-frame path — drop placement, slide, interior compression, packing,
  tidy, incremental placement, resize clamping, resize minimums — reads it.
  No path may introduce its own spacing constant.
- The one asymmetry is the top inset: the tab the chrome **actually draws**,
  plus that same gap. `frameChromeBand` delegates to `systemTabHeight`, which
  is the single authority. Layout must never restate the tab formula — an
  independent "header budget" reserved more than twice what the tab drew, so
  the gap above a frame's first child was several times the gap on every other
  side.
- Tab height is never clamped by the layout's reservation. That would be
  circular, because the reservation is now derived from the tab.
- The tab draws in rendered pixels and is constant per depth, so its canonical
  cost scales inversely with world scale. That conversion is required, not
  optional.
- Top-level spacing on the open canvas is `FRAME_ROOT_GAP` and is deliberately
  separate: it reads as separation between unrelated systems, not as packing.
- Every "where may a child sit inside this frame?" question goes through
  `contentRectFor` / `frameContentInsets`.
- Dropping a node into a frame is resolved in order of how much it disturbs
  what is already there:
  1. It lands where it was released, nudged by the **minimum** amount that puts
     it inside the frame if it overhangs an edge.
  2. Otherwise it slides to the nearest free slot, searched outward from the
     drop point. Existing children are immovable obstacles.
  3. Otherwise the frame compresses its interior: every child gets uniformly
     smaller, together, in place, by the smallest amount that opens a slot.
- Every step nudges by the smallest amount that works. No placement step may
  recentre, seek a midpoint, or otherwise move a node further than required.
- The slot search is bounded by the frame's content box as a **filter**, never
  by clamping a result afterwards. A clamped result can land back on a
  neighbour, which reads as "no room" and escalates to compression while the
  frame still has obvious empty space.
- Case 3 may only be reached when no free slot exists anywhere in the frame.
- The scene projection must be a pure function of persisted state. A node that
  has no persisted row keeps the placement first decided for it, until it gains
  a row or changes parent. Re-deriving it per projection made every unpersisted
  node's position depend on the live geometry of everything around it, so one
  drop scattered unrelated nodes.
- A write signature used to suppress duplicate persists must cover every field
  the write changes.
- Clearances are compared against absolute world geometry, so the canonical gap
  converts through the frame's content scale before use.
- A drop never rewrites a sibling's row. Cases 1 and 2 write the newcomer only;
  case 3 writes the newcomer and the container's `interiorScale`.
- Compression preserves relative arrangement exactly, because it scales the
  coordinate space rather than re-laying-out its occupants. It never reorders,
  repacks, or resizes the container, so nothing cascades outward to parents.
- A newcomer adopts the world scale its new siblings already share; it never
  keeps its own.
- Compression stops at a legibility floor measured against the frame's smallest
  child, so it compounds honestly through nesting. At the floor the frame
  visibly overflows rather than compressing further.
- Compression is quantized: a drop that needs any shrink takes at least one
  full step, so most drops change nothing instead of nudging everything.
- Drop-induced movement animates through `.layout-transition` and must never be
  live during an interactive drag or resize.
- A drop commits in **two phases**. Phase one reparents the node at the exact
  point the pointer released it, untransitioned — visually a no-op. Phase two
  arms the transition, waits a frame, then applies the corrected geometry.
  Committing the reparent and the correction together gives the transition no
  previous value to interpolate from, and the node appears at its corrected
  spot instead of travelling there. Every correction — edge push, slide off a
  sibling, size parity, interior compression — must be a visible movement.
- Sheet geometry persists through sheet layout mutations. The sheet layer has
  no interior compression and keeps the whole-group reference-frame transform.
- Resize persistence occurs at gesture end; optimistic local geometry remains
  stable while the asynchronous save completes.
- A persistence response or layout rebuild must not visibly snap a node back
  to stale geometry.

## Living relationships

- Live reindexing diffs both file imports and the resolved symbol-level call
  graph; it never deletes inbound relationships owned by another source file.
- A created call travels source-to-target in green, every retained call touched
  by a real content edit travels in teal, and a removed call travels in red
  before fading. Choreography never depends on guessing who wrote the file.
- Flow endpoints resolve to the nearest visible semantic ancestor at the
  current zoom. An internal flow whose endpoints resolve to the same visible
  container becomes one surfaced container signal instead of a self-loop.
- Animated motion communicates direction; living and trace flows have no
  arrowheads.
- When an import and a resolved call change between the same files, both
  semantic updates are retained but only the higher-value function-call pulse
  renders, preventing coincident duplicate animation.
- Living relationship traces are transient event choreography, not permanent
  all-graph wiring. Persistent edges remain focus/selection driven so the
  Floor cannot collapse into a spaghetti graph.

## Morning Delta

### What a delta contains

- The delta is a NET architectural diff, never an event log. A file created
  and then deleted, or an edge wired and then unwired, does not appear at all.
  Repeated saves of one file are one entry.
- An endpoint with no system is UNCLASSIFIED, not a different system. A file
  the classifier has not placed has no boundary to cross and can never produce
  a cross-boundary claim.
- A project's first index is its baseline, not a delta. Classifier-contract
  migrations reshape systems without entering the delta for the same reason:
  they change how Axiom reads the code, not the code.
- Reopening a project reconciles the tree against disk through the same
  reindex path the watcher uses, so work done while Axiom was closed produces
  a true delta. Once the catch-up burst settles, the guarded live classifier
  may place new unclassified peers; authored systems and existing Floor
  layouts remain untouched.
- Returning focus to an open Axiom window reloads the delta, so work performed
  while the app was unattended surfaces without reopening the project.

### Claims are the unit of review

- The reviewable unit is a CLAIM — the smallest statement that changes your
  understanding of the architecture — not a raw change. Call sites, imports,
  and individual files are EVIDENCE nested under the claim they support.
- One new dependency between two systems is ONE claim, however many call sites
  it has. Twenty files newly importing one module is one claim with twenty
  pieces of evidence.
- An IMPORTS that merely accompanies a resolved CALLS between the same files is
  not separate evidence. This matches the living-relationship rule that one
  code change reads as one signal.
- Claims are titled by content, never by category: "Api now depends on
  Storage", not "New cross-boundary calls".
- Claims are ranked by consequence, not recency. A coupling that closes a
  dependency cycle outranks everything. Evidence count weights sub-linearly.
- Hub transitions and orphaned systems are asserted only from exact persisted
  before/after system-graph snapshots. A hub crosses from fewer than three
  neighbors to at least three; an orphaned system still exists but has lost
  its final incoming or outgoing architectural connection.
- Churn wholly inside one system is collapsed to one muted claim per system
  and hidden until the user asks for it.

### Narration (bidirectional)

- Structural facts alone are thin: topology says what moved, never why. The
  agent that made the change writes its intent INTO the map via MCP
  (`start_work` / `note_work` / `finish_work`). With one active session the
  row inherits it; with parallel sessions, declared file/system scope must
  select exactly one owner or the row remains unexplained.
- A claim shows the agent's own words as its rationale, preferring the closing
  summary and falling back to the declared goal while work is in flight.
- Narration is always optional. An un-narrated agent change still appears and
  is marked UNEXPLAINED — silence about a real change is information, not a
  reason to hide it.
- Starting new work closes only the same MCP client's session left open, so a
  crashed agent cannot block narration or evict another agent's live presence.
- Burst collapse never merges saves carrying different work-session IDs, and a
  net change spanning multiple sessions never quotes either as its sole cause.

### First-run payoff

- The initial review shows the real repository materializing as the baseline;
  it never substitutes sample data or calls the baseline a change.
- The guide advances from Sheet creation to drawing to dispatch only when each
  persisted state exists, and completes only when that exact planned node is
  realized or flattened.
- Hiding the guide does not mark onboarding complete.
- The launcher Command Deck derives recent-project signals from each durable
  project database: unreviewed claims, unexplained work, drift, active agents,
  open plans, and pending proposals.

### Review surface

- Review is triage, not playback: the whole ranked list is visible at once and
  any claim can be jumped to directly. There is no "item N of M" transport.
- The panel sets its own type scale. The workbench uses 8px monospace to label
  controls the user already recognises; the delta is prose that has to be read
  and acted on, so legibility outranks stylistic consistency with the chrome.
- Review marks and ghosting are a projection over the living nodes, exactly
  like live FX. Reviewing never mutates canvas state, and a live edit still
  animates on top of a mark.
- Mark colors are the living choreography's vocabulary: green created, teal
  edited, red deleted. During review the mark outranks the churn heat on the
  file perimeter.
- Selecting a claim ghosts everything unrelated using the existing dim
  treatment. The subject, everything inside it, and every container around it
  stay lit — never a lit node inside a ghosted parent.
- A boundary claim frames both SYSTEMS, because the boundary is the claim.
  A file claim frames the file within its parent. A claim with nothing on
  canvas leaves the camera where it is.
- Framing is bounded at both ends: a zoom floor so a small subject never lands
  illegibly, and a ceiling so a two-system claim never fills the viewport with
  one box.
- Reading a delta never acknowledges it. The watermark moves only on an
  explicit accept, and it never moves backwards, so closing Axiom mid-review
  leaves the delta waiting.
- An active review is a stable snapshot. A focus refresh waits until review
  ends rather than replacing claims or moving the cursor under the reader.
- An accept acknowledges the window that was actually shown, not "now", so
  changes landing during a review survive into the next delta, which is loaded
  immediately after the acknowledgement completes.

## Agent visibility

### Two streams, one animation

- Two live streams reach the canvas: the SEMANTIC stream (`graph:patch`,
  `call:trace`, `data:flow`, `runtime:*`, `planned:*`) describing consequence,
  and the ACTION stream (`agent:action`) describing agent activity including
  reads. They overlap almost entirely.
- **One consequence, one animation.** The semantic stream owns animation: it
  fires whether the change came from an agent, from you, or from git, and it
  carries the geometry. The action stream owns attribution and the log.
- The action stream's only original visual is the read/attention signal,
  because a read produces no consequence and therefore no semantic broadcast.
  Nothing else can show it.
- Adding an action kind requires answering one question: does a broadcast
  already exist for its consequence? If yes it must not animate from the
  action stream. `agentActionVisual.ts` encodes this per kind and names the
  owning stream, so the rule is executable rather than remembered.
- A failed action never lights a node. The agent looked and got nothing;
  showing it as read would be a lie.
- Repeated reads of one node deepen a single signal. Attention never stacks
  into overlapping glows, and expiry never clears a node a newer signal owns.

### The log

- Every MCP tool call is recorded from one wrapper around the dispatch, so a
  tool added later is captured without being instrumented individually.
- Reads are first-class in the log and absent from the structural journal.
  Watching an agent trace a path is the point of a living canvas even though
  tracing changes nothing.
- Actions are attributed to the declared work session when one is open, so the
  log groups into tasks rather than reading as a flat firehose.
- Recording is best-effort. Failing to log never fails the agent's work.

## Semantic system invariant

- Filesystem directories and filenames never create classifier membership
  edges and never form a system boundary.
- Inferred membership comes only from parsed dependency topology, symbol
  similarity, and git co-change evidence.
- Moving files between folders without changing those semantic signals cannot
  change their inferred systems.
- A single unconnected file remains at the current scope; the classifier must
  not invent a one-file system.

## Required regression matrix

The automated harness must cover these cases before structural extraction:

| Area | Required cases |
|---|---|
| Camera | wheel zoom on pane, compact file, revealed file, symbol row; pointer anchor remains fixed |
| Zoom range | `0.02`, `0.5`, `1`, detail threshold, `10`, `66+`, `100` |
| Selection | click, partial box selection, multi-selection, deselection, read-only |
| Resize | all eight handles; root and nested nodes; ordinary and `100x`; min clamp; cancellation |
| Drag | root, nested file, container, sheet member, drop preview, drop commit |
| Files | compact, detailed, selected, dimmed, runtime, perturbed, long symbol list |
| Systems | collapsed identity, revealed grid, selected, dimmed, drop target |
| Infra | confirmed, proposed, missing registry entry, selected/resized |
| Planned | planned, partial, realized, editable metadata, planned edge |
| Persistence | Floor drag/resize save, sheet drag/resize save, failed save rollback behavior |
| Chrome | 1px outline, 8px handles, 18px hit targets, no ghost shell, no duplicate borders |

## Initial extraction boundaries

The first architecture pass may extract these responsibilities without
changing their behavior:

1. Pure Floor scene projection.
2. Pure sheet-overlay scene projection.
3. Viewport and semantic-zoom controller.
4. Selection controller.
5. Drag/drop controller.
6. Resize persistence controller.
7. Layout persistence and optimistic update boundary.

`AxiomCanvas` remains the integration shell until each extracted module has
characterization coverage. Node components, `frameGeometry`, `packing`, and
the resize SVG remain protected until the harness covers their contracts.
