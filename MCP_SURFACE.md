# Axiom MCP tool surface

Status: consolidated 2026-07-30. 59 advertised tools → 14 core (+2 debug).

## Why this is a budget, not a detail

The tool listing is sent on **every request an agent makes**, before it has
read a line of code. Axiom's 59 tools cost roughly **9,600 tokens** per
request. That is both a context tax and a selection problem: a model choosing
between `get_neighbors`, `get_family`, `get_node` and `get_systems_with_files`
is choosing between four spellings of one question.

The advertised surface is now **~2,460 tokens** with the default profile — a
74% reduction — and `mcp/toolSurface.test.mjs` fails the build if it creeps
back.

## The merge rule

> **Merge when the question is identical and only the selector varies.
> Split when the question genuinely differs.**

Twelve graph reads became one `get_architecture` with a `scope`, because every
one of them asks "describe this part of the graph". `search_symbols` and
`trace_calls` stayed separate, because they are different questions with
different mental models and each schema stays small.

This is deliberate. A single polymorphic `query_anything` tool trades a token
saving for a worse one: a giant discriminated union costs more schema than the
tools it replaced, and models select from it badly.

## Nothing was removed

**All 58 legacy handlers still execute.** `mcp/toolRouting.ts` rewrites a
consolidated call into the legacy call that already implements it, and unknown
names fall through untouched — so an existing agent configuration calling
`create_system` directly still works. The handlers are simply no longer
*advertised*, which is where the cost was.

That includes every architecture-curation tool. The indexer gets you most of
the way and cannot know the architecture in the human's head; an agent fixing
boundaries after a build, or during first-run review, is the bidirectional
thesis, not a risk to be gated. `edit_systems` carries the longest description
in the surface for exactly that reason.

## Core profile — 14 tools

| Tool | Absorbs |
|---|---|
| `get_architecture` | overview, systems, system_files, files, unclassified, node, neighbors, family, cross_dependencies, dependency_graph, infra, infra_for_files, infra_catalog, hotspots |
| `search_symbols` | — |
| `get_symbols` | `get_symbols_for_files`, `get_function_body` |
| `trace_calls` | `get_call_path`, `get_call_graph`, `get_call_graph_for_files` |
| `get_data_flow` | — |
| `edit_systems` | create, update, delete, assign, merge, bulk |
| `edit_infra` | create, update, delete, connect |
| `edit_sheet` | list, get, create, add, annotate |
| `get_inbox` | `get_canvas_updates`, `await_canvas` (via `waitSeconds`) |
| `get_build_plan` | `get_build_spec`, `get_plan_status` |
| `plan_element` | — |
| `reply_to_canvas` | — |
| `start_work` | — |
| `update_work` | `note_work`, `finish_work` (via `done`) |

## Debug profile — 2 tools, off by default

Set `AXIOM_MCP_PROFILE=debug` to advertise:

| Tool | Absorbs |
|---|---|
| `debug_runtime` | watch, unwatch, inject, cancel_inject, snapshot, launch, stop, log |
| `investigation` | start, note, stop, list, get |

Real capability, wrong default. A coding agent does not need value injection in
its context to write a class.

## Adding a tool

Ask first whether it is a new *question* or a new *selector* on an existing
one. A selector is a scope or an op on a tool that already exists. Only a
genuinely new question earns a new name.

The guard tests enforce: core surface ≤ 15, core schema under 3,200 tokens,
no merged-away name re-advertised, every legacy handler still present, and no
tool description over 460 characters.

## Migration

Legacy names remain callable but unlisted for one release. Before removing
them, instrument which adapters are actually being hit — `agent_actions` in
archd already records every call by tool name, so the data is there.
