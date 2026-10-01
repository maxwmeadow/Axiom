# Axiom - the product

Status: living definition of what Axiom is and the rules it keeps. Decisions and
their reasoning: [DECISIONS.md](DECISIONS.md). Open work: [../WORK.md](../WORK.md).
Observable canvas behaviour: [CANVAS_BEHAVIOR_CONTRACT.md](CANVAS_BEHAVIOR_CONTRACT.md).
Updated 2026-09-30. ("Axiom" is a working name; see DECISIONS §3.)

---

## 1. The thesis

**Axiom is the bidirectional architecture layer between you and your coding
agents.** It keeps a developer and their agents on the same page about the
architecture, in both directions, all the time.

Agents now write code faster than anyone can draw a diagram of it, and far
faster than anyone can write UML first and have an agent build it. Diagrams
drawn by hand go stale in a day; diagrams generated once are out of date the
next time an agent runs. So people stop looking at architecture at all and
review 40-file diffs instead.

Axiom closes that gap:

- **You → agent.** Draw or change the architecture - a new system, a moved
  responsibility, a relationship that should not exist - and hand it to your
  agent as a work order. Axiom checks what was built against what you drew.
- **Agent → you.** Your agent draws what it thinks the architecture is, what
  it plans to build, or what it just changed, on the same surface. You confirm,
  correct or reject it before or after the code moves.
- **Code → both of you.** The map is derived from the real code and updates
  live, so neither of you is ever looking at a picture of how things used to be.

The live map is how the architecture stays true. It is not the pitch: free
code-graph tools already draw codebases. What nobody does is make the
architecture a two-way contract that both the human and the agent read and
write.

### Every tool is bidirectional

This is the product's first rule. For every artifact Axiom shows - systems,
relationships, infrastructure, sheets, plans, rules - both parties can create
and change it, and each sees the other's changes:

| Artifact | You → agent | Agent → you | Code → both |
|---|---|---|---|
| Systems (what belongs to what) | Rename, regroup, nest; can become a work order | `edit_systems` proposals you review | Clustering + live indexing |
| Sheets (plans) | Draw, send as a work order, review realisation | `edit_sheet` / `plan_element` drafts you confirm | Structural comparison against the live map |
| Infrastructure | Add, confirm, decide | `edit_infra` records it with evidence | Detection from code and config |
| Changes | Review Changes; accept or undo | Narrated work sessions (`start_work`, `update_work`) | The structural journal |
| Rules (planned) | "Payments never calls Email directly" | Agents check before and after they work | Drift detection |

Where a row is not yet true in both directions, that gap is work in
[../WORK.md](../WORK.md) (section "Bidirectional core").

### Why the position is open

(From the September 2026 competitive research, `reports/` locally.)
Spec-driven tools (Kiro, Spec Kit, Tessl, Traycer) are text. Diagram tools
(IcePanel, Structurizr, Eraser, Mermaid) are hand-drawn or one-off AI
generations that go stale. Code-graph tools and context engines
(codebase-memory-mcp, Graphify, GitNexus, Sourcegraph, Augment) go one way,
code → picture or code → agent. Agent managers (Claude Code desktop, Codex,
Cursor, GitHub Agent HQ) show lists, chats and diffs. The closest things are
Windsurf Codemaps (AI-drawn, per task, read-only, IDE-locked) and Archyl (C4
plus drift checks). Nobody closes the loop where agents author architecture,
humans ratify it, plans go out as verified work, and changes come back as
architectural claims.

### Non-negotiable feeling: alive

When an agent makes a file, you see it arrive. When a file changes, you see it.
When a function starts calling something, the line traces to the other file.
Systems are clustered from real topology, never from folders.

---

## 2. The two surfaces: the Floor and sheets

- **The Floor** is the live architecture: what the code is. It is always
  complete and always current.
- **A sheet** is a proposal about the architecture: moves, additions and
  removals. A proposal never touches reality until someone builds it.

### What you may change on the Floor (proposed rule, `floor-edit-rules` in WORK.md)

Edits on the Floor come in three kinds, and each is handled differently:

1. **Presentation** - position, size, collapse, colour, pinning. Always free.
   It changes how the map looks, never what it says. (Today: dragging on the
   Floor never rewrites ownership.)
2. **Meaning** - what a system is called, which files belong to which system,
   how systems nest. Systems are Axiom's interpretation of the code, not the
   code, so changing them does not lie about reality. Allowed on the Floor, but
   every meaning edit is journaled, attributed (you or an agent), visible to
   agents, and undoable from Review Changes. (Today: placing unsorted files
   from the bins; not journaled yet.)
3. **Reality** - anything that needs the code to change: a new system that has
   no code yet, removing a relationship, splitting a module so files move,
   deleting a system's code. The Floor cannot fake these. The gesture instead
   offers **Draft as a work order**, which opens a sheet with the change
   already drawn, ready to send.

After a meaning edit, Axiom may also ask "Make the code match?" - for example
when a file moved into Payments still imports half of Orders - which drafts the
same kind of sheet. This keeps the Floor honest without making it read-only,
and without forcing a sheet for every rename.

---

## 3. The daily loop

1. **Review Changes (the Morning Delta)** - see what changed while you were
   away as architectural claims ("Api now depends on Storage"), attributed to
   you or an agent. Accept, or undo.
2. **Watch and steer** - agents' work shows up live on the map: planned →
   active → realized.
3. **Draw the next piece** - on a sheet, or by changing meaning on the Floor.
4. **Send it** - the sheet becomes an addressed work order an agent claims
   through MCP. Agents can also draw their own plan first for you to confirm.
5. **Check it** - what was built is compared with what was sent: MATCHED,
   FLEXED, DRIFTED, MISSING or UNKNOWN.
6. **Zoom to truth** - any box → files → symbols → source, instantly.

---

## 4. Design laws

Round-trip engineering died twice before, on *drift* (diagrams became shelfware
the moment code changed) and the *reconciliation paradox* (strict diagrams →
rigid boilerplate; flexible code → an unreadable canvas). Doing it at agent
speed makes that worse if done naively. These are hard constraints:

| Failure mode | Law |
|---|---|
| Spaghetti | Semantic zoom and deterministic per-cluster layout. Never render a flat graph. Re-indexing never resets a human's layout. |
| Too coarse to trust | Map → symbol → source is always one zoom away. |
| Rigid generation | A drawing is intent, not a codegen straitjacket. Reconciliation confirms; it does not dictate. |
| Look-once destination | The daily surface is live agent activity and changes, not a static picture. |
| Meaningless diffs | Review units are architectural claims, never raw events. |
| One-way tools | Every artifact can be written by both the human and the agent (§1). |
| Unrecorded change | Every change to meaning or reality is journaled, attributed and reversible. |

---

## 5. The UML bet

Semantic architecture - systems, relationships, infrastructure, plans and rules
- is the primary diagram. Classic class and sequence UML becomes too large, too
detailed and too quickly outdated once agents write most of the code, and the
bet is that it fades. It is still worth having: generated algorithmically from
the index (what attaches to what), scoped to a selection rather than the whole
codebase, and live. It is not the centre of the product. Work items:
`uml-class-sheets`, `uml-sequence-sheets` in WORK.md.

---

## 6. Where things stand (2026-09-30)

Verified by a code audit of `main` on 2026-09-30.

| Capability | State |
|---|---|
| Indexing (tree-sitter), live watching, clustering into nested systems | ✅ Deep for TS/JS, Python, Go; C# close; Rust, Java, Ruby, C++ get symbols and calls but no import edges; C, Kotlin, Swift, PHP not parsed |
| Agents propose the architecture; you review and approve | ✅ Chunked proposal sessions that survive restarts |
| Sheets → addressed work orders → structural comparison | ✅ Real Codex runs pass end to end; delivery is a copy-pasted ID |
| Agent-drawn sheets and planned elements | ✅ Draw-first skills, project reminders and MCP guidance across supported hosts; live model behavior still needs authenticated trials |
| Review Changes (claims, attribution, realisation against plans) | ✅ Meaning edits (file reassignment) are not journaled yet |
| Infrastructure detection, contracts, hosting frames, sidebar | ✅ 87-service registry; no Kubernetes/Terraform |
| Worktrees and cross-branch collisions on systems | ✅ |
| Investigations (hypothesis-driven debugging) | ✅ Node and Python; other languages are debug-profile only and barely tested |
| Rules and drift checks, class/sequence sheets, export | ⬜ Designed, not built |
| Undo | ⬜ |
| Launch plumbing (install, updates, security, backups, OS integration) | ✅ See DECISIONS §6 |
