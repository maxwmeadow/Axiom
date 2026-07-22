# Axiom Canvas Behavior Contract

Status: preservation baseline for the renderer refactor  
Baseline commit: `7e55a2a` (`Canvas: stabilize extreme-zoom resize interactions`)  
Last verified: 2026-07-22

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
- React Flow's wheel zoom is disabled. Axiom owns wheel zoom.
- Each wheel step multiplies or divides the target zoom by `1.15`.
- Zoom eases toward its target by `15%` per animation frame.
- The flow coordinate beneath the pointer remains beneath the pointer while
  zooming.
- Wheel zoom works over revealed file-node content. Only an explicit `nowheel`
  ancestor may opt a surface out of canvas zoom.
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
- Node shells fill the live frame synchronously. Shell geometry must not trail
  resizing through a React-state measurement loop.
- Container children remain visually stationary when a north or west parent
  edge moves; their persisted local positions are compensated accordingly.

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
- File connection handles remain invisible until React Flow needs them and
  must never create a large invisible interaction surface at extreme zoom.

### Systems

- The system structural silhouette exists at every zoom.
- The centered identity and the detailed header/grid crossfade according to
  child reveal.
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
- Planned/partial outlines are dashed; realized/flattened outlines are solid.
- Realized members display independently from pending members.
- Status colors remain: planned/neutral, partial/warning, realized/success.

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
- Activating a sheet preserves live identity and displays planned/floating
  content through an interaction snapshot.
- Floor geometry persists as canonical layout geometry, independent of the
  current world/presentation scale.
- Sheet geometry persists through sheet layout mutations.
- Resize persistence occurs at gesture end; optimistic local geometry remains
  stable while the asynchronous save completes.
- A persistence response or layout rebuild must not visibly snap a node back
  to stale geometry.

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
