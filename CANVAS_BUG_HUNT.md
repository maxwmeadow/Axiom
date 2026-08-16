# Canvas Bug Hunt

Working checklist for the Living Canvas solidity pass. Max hunts, Claude fixes.

Report by ID (e.g. "D4 is broken, the west handle jumps"). Expected results come
from `CANVAS_BEHAVIOR_CONTRACT.md` where that document specifies them; the rest
are read from the current handlers.

Status: `[ ]` untested · `[x]` verified good · `[!]` bug found · `[~]` fixed, needs recheck

---

## A. Camera and viewport

- [x] **A1** Wheel zoom over empty pane - flow point under cursor stays under cursor
- [x] **A2** Wheel zoom over a compact file node - same anchoring, no jump
- [x] **A3** Wheel over a scrollable symbol list scrolls the list, not the canvas.
  Was zoom-only. Fixed: `wheelRouting.ts` (scroll-chaining + per-notch step cap
  + per-gesture latching). Root cause of the follow-on "scrolls and zooms at
  once" was the oversized step hitting the list boundary within one notch.
- [x] **A4** Same for symbol rows and class-node member lists
- [x] **A5** Zoom to the extremes: 0.02 and 100 - clamps, no NaN geometry, no blank
- [x] **A6** Zoom easing - 15%/frame glide, never a hard snap
- [x] **A7** Pan with left drag (normal mode)
- [!] **A8** Middle-drag pans; **right-drag does nothing**. Deprioritized by Max.
- [x] **A9** `Fit view` toolbar button - smooth 850ms move, everything in frame
- [x] **A10** Auto-reframe on live growth - yields while you are navigating
- [?] **A11** Reported once: dragging a root-level leaf caused heavy resizing and
  teleporting. **Not reproducible** on retry - left open, not chased. If it
  returns, first suspect is that a Floor drop writes `floorLayouts`, which is a
  dependency of the full layout-rebuild effect (gesture → total re-layout).
- [x] **A12** Lag addressed: `applyZoomVisibility` rebuilt every node object on
  every zoom frame because the raw zoom was stamped into node data. Now
  publishes a resolved `detailRevealed` boolean and returns identical object
  references for unchanged nodes, so only nodes crossing a threshold re-render.

## B. Semantic zoom

> **Open intermittent bug - "zoom spaz".** At certain zoom thresholds the scene
> teleports for a frame or two: nodes drawn far from their real positions while
> the selected node's chrome stays correct and its body renders blank. Caught on
> camera at zoom ~7.98x. Stopped reproducing immediately after `sceneDiagnostics`
> was added, but that tracer is read-only and cannot fix rendering - treat it as
> **masked, not fixed**. If it returns, `[scene-move]` warns with the source
> label; leading suspects are `integrity-restore:no-visible-root` and
> `layout-rebuild`.


- [x] **B1** Zoom into a system - children reveal at ~480 screen px of container size
- [x] **B2** Nested system - child never reveals before its ancestors
- [x] **B3** Zoom out - descendants fade to 0, blur to 3px, stop taking clicks
- [x] **B4** File detail appears at effective zoom 1.075 (viewport zoom x node world scale)
- [x] **B5** Deeply nested file at high zoom - reveals correctly, detail crossfades
- [x] **B6** Drag a node while it is faded - it forces fully visible during the drag
- [x] **B7** Hidden detail does not receive pointer events

## C. Selection

- [x] **C1** Click a file / system / infra node - one authoritative outline, 1 screen px at any zoom
- [x] **C2** Click empty pane - clears selection and detail panel
- [x] **C3** Double-click a node - selects and opens the detail panel
- [x] **C4** Editable text / symbol rows do not trigger select-and-inspect (sheet-only behavior)
- [x] **C5** Lasso-drag no longer lags. Root cause: the `transition: none` guard
  keyed off React Flow's `.dragging` class, which a **box-selection drag never
  sets** (it moves nodes through the separate selection-rect path). Now keyed
  off `.axiom-dragging`, set by Axiom for any drag gesture;
  `onSelectionDragStart/Stop` were unwired entirely.
- [x] **C5b** Resizing one node of a multi-selection scales the whole selection as
  one frame (`selectionResize.ts`). Members sharing the anchor's parent only;
  24px floor.
- [x] **C6** Box selection uses partial intersection
- [x] **C7** Selection chip no longer flickers. It derived from `selected` on the
  projected nodes, which four independent paths rebuild/restore; now renders
  from the authoritative selection set via a single `commitSelection` writer.
- [x] **C8** Selection survives a live save burst
- [x] **C9** No duplicate/ghost selection border at any zoom

## D. Resize

All verified. Bugs found and fixed in this section:

- [x] **D1–D4, D6, D8, D9** verified good as written.
- [x] **D5 / chrome** System tab chrome rewritten as a swept pure model,
  [`systemChrome.ts`](src/renderer/canvas/systemChrome.ts), with ~17k combinations
  enforcing: no line box exceeds its band, chip inside the slant, title never
  under the chip, tab never exceeds the shell, name truncates only when needed,
  and **tab geometry independent of both frame width and height**.
  Root causes were all one family - chrome measured against node dimensions via
  `presentationScale = min(w/designW, h/designH)`:
  - title clipped in 35% of the size space (font sized to band height, ignoring
    the 1.25 line box);
  - narrowing a node shortened its tab (width leaking into tab height);
  - growing a node taller walked the title sideways (`left: padX`, and padX
    rides presentationScale). **Fixed only once the DOM was actually rewired -
    the model was correct for three rounds while the div still read `padX`.**
  - chip border constant while the tab shrank, crowding the number; stroke now
    scales with tab height and the chip's padding clears its own stroke.
- [x] **D7** Resize now clamps to the parent's *content box* (header-aware), and
  the drag hit-test no longer uses the cursor point alone.
- [x] **D10** Container minimum was derived from the container's own current
  width, so a frame could never narrow. Now the children's bounding box + insets.
- [x] **D11/D12** Multi-select resize scales the whole selection; cross-parent
  members are excluded by design.
- [x] **North/west resize** regression (mine, from D10): east/south and
  west/north need *separate* minima because the latter move the origin while
  children are compensated. `minimumContainerSize` returns both now.

**Lesson recorded:** a script-driven edit that silently no-ops will send you
fixing a value nothing reads. Verify the string landed in source *and* the
identifier landed in the bundle before reporting a UI fix done.

## E. Drag, drop, reparenting

Fixed during this pass:

- [x] **Hit-testing through hidden nodes.** A node hidden by semantic zoom kept
  stealing clicks aimed at the container around it. `pointer-events: none` on
  the wrapper is overridden by any descendant that sets `auto` (file nodes do,
  for editable chrome). Disabling `draggable` alone then made it *swallow* the
  pointer instead - the click fell through to whatever was painted behind, and
  since React Flow renders node wrappers as **siblings**, that was the outer
  depth-0 container. Now `.axiom-node-hidden` kills pointer events on the node
  and every descendant, plus React Flow's `draggable`/`selectable` flags as a
  second layer for keyboard/programmatic paths.
- [x] **Stuck-to-cursor drag.** The drag-start visibility override sat *after*
  the drag-trace gate, so gating the trace off skipped it; a faded node has
  `pointerEvents: none` and never receives its own pointerup.
- [x] **Drop targeting.** Cursor decides the parent; containment is enforced
  separately at commit by nudging the landing rect inside the frame.

- [ ] **E1** Drag a root-level node
- [ ] **E2** Drag a file that is nested inside a system
- [ ] **E3** Drag a whole container (system) with children - children follow
- [ ] **E4** Drag a file INTO a system - drop preview shows, commit reparents
- [ ] **E5** Drag a file OUT of a system to the Floor
- [ ] **E6** Drag between two different systems
- [ ] **E7** Drop on an invalid target - clean reject, node returns
- [ ] **E8** Drag does not start from editable text, symbol rows, buttons, scroll regions
- [ ] **E9** Drag a node during a live flow animation - no teleport, no lost geometry
- [ ] **E10** Rapid drag + release + immediate re-drag

## F. Tidy and layout

- [ ] **F1** `Tidy frame` with a system selected - arranges inside that container only
- [ ] **F2** `Tidy frame` with nothing selected - arranges the current frame
- [ ] **F3** `Tidy canvas` - full force-directed pass, no overlaps left
- [ ] **F4** Spinner/busy state shows and clears; button disabled while running
- [ ] **F5** Camera reframes sensibly after a tidy
- [ ] **F6** Tidy never resets or discards authored geometry it should keep
- [ ] **F7** Tidy while a save/live burst is landing

## G. Systems and grouping

- [ ] **G1** Select files -> `Group` -> GroupDialog creates a system with them
- [ ] **G2** Cancel the group dialog - nothing changes
- [ ] **G3** Group a single file (classifier must not invent a one-file system)
- [ ] **G4** System auto-grows to contain a newly indexed child (never shrinks)
- [ ] **G5** Collapsed system identity: title, count, no bleed-through of children
- [ ] **G6** System as an active drop target - highlight is legible
- [ ] **G7** Moving a file between folders on disk does NOT change its inferred system

## H. Files and detail panel

- [ ] **H1** Compact file card renders correctly at every depth
- [ ] **H2** Revealed file with a long symbol list - scrolls, does not overflow the card
- [ ] **H3** Symbol tabs: functions / variables / classes
- [ ] **H4** Rename a file node inline (Enter commits, Escape cancels)
- [ ] **H5** Detail panel: Imports / Imported by lists navigate to the target node
- [ ] **H6** Detail panel: open file / show in folder
- [ ] **H7** Source preview dialog opens and closes (Escape)
- [ ] **H8** Churn/heat border shows on hot files only
- [ ] **H9** Dimmed state under focus mode

## I. Infrastructure

- [ ] **I1** `Add infra` -> InfraPickerDialog -> node lands on the Floor
- [ ] **I2** Group results by type / by provider
- [ ] **I3** Confirmed vs proposed infra visual distinction
- [ ] **I4** Infra with a missing registry entry - graceful fallback icon
- [ ] **I5** Select and resize an infra node
- [ ] **I6** Connect infra to files (where the model allows it)

## J. Sheets and planned UML

- [ ] **J1** Create a sheet (SheetRail); Escape cancels naming
- [ ] **J2** Activate a sheet - live nodes dim in place, sheet is an overlay NOT a separate tab
- [ ] **J3** Drag a stencil from SheetPalette onto the sheet
- [ ] **J4** Planned outlines dashed; realized solid; status colors planned/partial/realized
- [ ] **J5** Connect two nodes on an active sheet (Floor nodes must NOT be connectable)
- [ ] **J6** Edit planned element name / path / members inline
- [ ] **J7** `Delete`/`Backspace` removes the selected sheet node (must not fire while typing)
- [ ] **J8** Delete/Backspace on the **Floor** must do nothing
- [ ] **J9** Deactivate the sheet - live identity preserved, nothing orphaned
- [ ] **J10** Sheet geometry persists across sheet layout mutations

## K. Persistence

- [ ] **K1** Drag a Floor node, reload - position persisted
- [ ] **K2** Resize a Floor node, reload - size persisted
- [ ] **K3** Drag/resize a sheet member, reload - persisted
- [ ] **K4** No visible snap-back to stale geometry after the async save returns
- [ ] **K5** Failed save - sensible rollback, no silent divergence
- [ ] **K6** Reopen an already-indexed project - NO repeat source-boundary prompt
- [ ] **K7** Floor geometry stays canonical and independent of world/presentation scale

## L. Living canvas (the choreography)

- [ ] **L1** Edit a file - teal perimeter pulse on the edited node
- [ ] **L2** Edited file inside a collapsed system - pops out through the aperture
- [ ] **L3** Flows travel to each impacted file, terminate on the destination EDGE
- [ ] **L4** Exactly one pulse per route (no second stunted ghost)
- [ ] **L5** Impact highlight fires as the pulse lands, not early
- [ ] **L6** Create a file - green materialize + CREATED card + green link flows
- [ ] **L7** Delete a file - red ring, DELETED card, fuse flows outward, THEN dissolves
- [ ] **L8** Delete a file inside a collapsed system - aperture opens for it
- [ ] **L9** Rapid successive saves - no stacked/duplicated pulses
- [ ] **L10** Multi-file burst (git checkout / branch switch) - legible, not a storm
- [ ] **L11** Rename a file on disk - behaves sensibly (delete + create?)
- [ ] **L12** Canvas NEVER goes blank during any of the above
- [ ] **L13** No arrowheads on living or trace flows
- [ ] **L14** Import + call change between the same two files = one pulse, not two
- [ ] **L15** Save while zoomed way out (endpoints resolve to containers, no self-loop)

## M. Toolbar and global

- [ ] **M1** `Ctrl+K` opens search; Escape closes
- [ ] **M2** Search results navigate to and select the file
- [ ] **M3** `Open project`
- [ ] **M4** `Send to agent` dialog
- [ ] **M5** Selection mode toggle reflects state visually
- [ ] **M6** Status bar counts stay accurate after live changes
- [ ] **M7** Replay bar scrubbing
- [ ] **M8** Read-only mode disables drag, resize, connect, box select, selection

## N. Stability and integrity

- [ ] **N1** No `[scene-integrity]` errors in console during a normal session
- [ ] **N2** No React key warnings / duplicate node id warnings
- [ ] **N3** Canvas survives archd restart / disconnect / reconnect
- [ ] **N4** Switch projects back and forth - no leaked state from the previous one
- [ ] **N5** Long idle session then a save - still alive and correct
- [ ] **N6** Memory/perf: no unbounded growth after many save bursts
