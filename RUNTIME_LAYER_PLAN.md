# Axiom - Runtime Debugging Layer: Complete Architecture Plan

> Status: Planning  
> Authors: Claude Sonnet 4.6 + Gemini (research)  
> Last updated: 2026-07-01

---

## Vision

Axiom already maps the static skeleton of a codebase: files, systems, import relationships, and call paths. The runtime layer puts flesh on that skeleton.

When an AI agent debugs a codebase today, it reads files silently and reasons in its own context window. The user cannot see what the agent is investigating, and the agent cannot verify its mental model against real execution. The result is slow, opaque, and error-prone.

The runtime layer changes this in four ways:

1. **TRACE** - the agent follows call paths on the canvas (done)
2. **INSPECT** - the agent reads actual function bodies at each hop, sees real argument and return values from live execution
3. **SLICE** - given a variable name, the agent sees every file and line where it is defined, mutated, or read - highlighted live on the canvas
4. **PERTURB** - the agent injects a value into a running function, re-executes, and watches which downstream paths turn green or red

Every one of these operations is rendered spatially on the canvas in real-time. The user watches the agent close in on a bug. This has never been built before.

---

## Prior Art and White Space

### What exists

| Tool | What it does | What it lacks |
|---|---|---|
| **Sourcetrail** (archived) | Static call graph, interactive node navigation | No runtime data, no agent integration |
| **CodeSee** (shut down) | Architecture maps, PR diff visualization | Treated as documentation, not active debugging |
| **Replay.io** | Deterministic browser session recording, time-travel debugging | Browser-only, no spatial codebase map, no agent |
| **Jaeger / Zipkin** | Distributed trace visualization across microservices | Performance APM only, not code-level debugging |
| **LangGraph Studio / LangSmith** | Visualizes the agent's tool call sequence | Shows agent state machine, not codebase structure |
| **Python Tutor** | Step-by-step stack/heap visualization | Single-file scope, doesn't scale |
| **Debug Visualizer (VS Code)** | Renders variables as trees/graphs during breakpoint | Local scope only, no global codebase view |

### The white space

**Zero tools fuse all three layers simultaneously:**
- Agent reasoning map (what the AI is investigating)
- Codebase dependency map (where the code lives)
- Live dynamic execution data (what variables are actually resolving to)

Combining these three onto a 2D interactive canvas - with the AI's investigation rendered as animated paths in real-time - is the core innovation.

### Academic foundation

Three recent papers (2024–2025) directly validate this architecture:

**ADI - Agent-centric Debugging Interface (2024)**
Standard line-by-line debugger stepping is too expensive for LLMs. ADI proposes a *Frame Lifetime Trace* (FLT): capture variable states only at function boundaries (entry, exit, major state changes), not on every line. This matches the granularity of Axiom's call graph naturally.

**InspectCoder / InspectWare (2024)**
Implements an *Inspect-Perturb-Validate* loop: the agent sets a breakpoint, inspects a variable, *changes* its value (perturbation), and observes whether the downstream behavior matches the expected output. This is the formal basis for Axiom's perturbation step.

**ARISE - Agentic Repository-level Issue Solving Engine (2025)**
Uses *data-flow slicing* as a first-class agent primitive. When the agent asks "where does `userId` get mutated?", the tool returns a slice of the codebase containing only the relevant lines. On SWE-bench Lite, this significantly outperformed agents without slicing. This is the basis for Axiom's `get_data_flow` tool.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Axiom Canvas (React)                    │
│  Nodes: files    Paths: call traces    Colors: live state│
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket (existing)
┌────────────────────────▼────────────────────────────────┐
│                  archd - Go Daemon                       │
│  HTTP API · SQLite · WebSocket Hub · MCP Bridge          │
│  + NEW: DAP Client · Event Router · Trace Store          │
└──────┬──────────────────────────────────────┬───────────┘
       │ DAP Protocol                          │ DAP Protocol
┌──────▼──────────┐                  ┌────────▼──────────┐
│  debugpy (Python)│                  │  delve (Go)       │
│  js-debug (Node) │                  │  mono-debug (C#)  │
│  [DAP servers]   │                  │  [DAP servers]    │
└──────┬───────────┘                  └────────┬──────────┘
       │ attaches to                            │ attaches to
┌──────▼───────────┐                  ┌────────▼──────────┐
│  Target Python / │                  │  Target Go / C# / │
│  Node.js App     │                  │  Unity App        │
└──────────────────┘                  └───────────────────┘
```

### Key architectural decision: DAP Client in archd

Microsoft's **Debug Adapter Protocol (DAP)** is exactly the adapter pattern this system needs - and battle-tested implementations already exist for every major language:

| Language | DAP Server | Notes |
|---|---|---|
| Python | `debugpy` (Microsoft) | Production-grade, pip install |
| JavaScript / Node.js | `js-debug` | Built into VS Code |
| Go | `delve` | The standard Go debugger |
| C# / Unity | `mono-debug` / `.NET` DAP | Mono supports Unity |
| C++ | `cpptools` DAP / LLDB-DAP | Fallback to GDB MI if needed |
| Ruby | `ruby-debug-ide` | DAP wrapper exists |
| Java | `java-debug` (Microsoft) | LSP4J-based |

Instead of writing custom per-language adapters from scratch, archd acts as a **DAP client** and connects to these existing DAP servers. We get breakpoints, variable inspection, stack frames, and call stacks for free - in every language - without writing a single debugger.

This is the decision that makes this buildable by a small team.

---

## Wire Protocol

### Between archd (DAP client) and DAP servers

Standard DAP messages. archd sends `setFunctionBreakpoints` targeting the symbols the agent is watching, receives `stopped` events on each hit, evaluates variable frames, then resumes execution.

### Between adapters and archd (internal event bus)

All runtime events - regardless of language - are normalized into a single internal schema before being stored and broadcast:

```json
{
  "jsonrpc": "2.0",
  "method": "axiom/event",
  "params": {
    "traceId": "t-8f92-4c91",
    "parentTraceId": "t-1a2b-3c4d",
    "type": "call",
    "timestamp": 1782806728000,
    "file": "src/services/payment.py",
    "symbol": "process_payment",
    "threadId": "thread-14",
    "args": {
      "amount": { "type": "float", "value": "150.00" },
      "currency": { "type": "str", "value": "USD" }
    }
  }
}
```

Return event:
```json
{
  "traceId": "t-8f92-4c91",
  "type": "return",
  "timestamp": 1782806728150,
  "returnValue": { "type": "dict", "value": "{'success': true, 'id': 'tx_9921'}" }
}
```

Perturbation command (archd → adapter):
```json
{
  "jsonrpc": "2.0",
  "id": 102,
  "method": "axiom/inject",
  "params": {
    "file": "src/services/payment.py",
    "symbol": "process_payment",
    "paramName": "amount",
    "value": "-1.00",
    "once": true
  }
}
```

### Between archd and canvas (WebSocket - existing pattern extended)

New event types added to the existing WebSocket hub:

```
runtime:call       - function was called with these args, highlight node
runtime:return     - function returned this value, annotate node
runtime:exception  - exception thrown, path turns red
runtime:inject     - perturbation active, node turns orange
runtime:rate_limit - adapter throttled a hot function, warn user
```

---

## MCP Tools - New Additions

These tools extend the existing MCP server (`mcp/axiom-mcp.ts`) and are callable by any agent.

### `get_function_body(file, symbol)`
Returns the source code of a specific function. No runtime required - uses the `LineStart`/`LineEnd` already stored in the symbol table from indexing.

**Why it matters:** The agent can trace a call path AND read the actual code at each hop. Currently it can only see that A calls B - with this tool it can read what A and B actually do.

### `watch_function(file, symbol)`
Instructs the DAP adapter to place a function breakpoint on the named symbol. All future calls stream back as `runtime:call` / `runtime:return` events to the canvas.

The canvas animates the node every time the function is called and shows the last seen argument values as a tooltip.

### `unwatch_function(file, symbol)`
Removes the breakpoint. Stops streaming.

### `inject_value(file, symbol, param_name, value)`
On the next call to the named function, the adapter overrides `param_name` with `value` before execution continues. One-shot by default - fires once and removes itself.

The canvas marks the node orange during the perturbation. Downstream paths turn green or red based on observed behavior.

### `get_data_flow(variable_name, file?)`
Returns a data-flow slice: every file and line in the project where the named variable is defined, assigned, passed as an argument, or read. Optionally scoped to a single file.

Static analysis runs first (Tree-sitter def-use graph, pre-built at index time). If a runtime adapter is active, live values at each hit are also included.

The canvas highlights all affected nodes and draws data-flow paths in a distinct color (separate from call traces).

### `get_runtime_snapshot()`
Returns the current state of all active watch points: which functions are being watched, how many times they have been called this session, and the last seen argument and return values.

---

## Asynchronous and Concurrent Code

The `traceId` / `parentTraceId` pair propagates across async execution boundaries. Each language has a different mechanism:

| Language | Concurrency Model | Trace Propagation |
|---|---|---|
| Python | `asyncio` | `contextvars.ContextVar` - propagates automatically across `await` |
| JavaScript | Event loop | `AsyncLocalStorage` - inherits across all callbacks and promises |
| C# / Unity | ThreadPool + Tasks | `AsyncLocal<string>` - flows across `await` boundaries |
| Go | Goroutines | No goroutine-local storage - requires `context.Context` carrying trace ID, injected at build time via AST rewrite, OR eBPF uprobe on `runtime.newproc` to map parent→child goroutine IDs |

Go is the hardest. The pragmatic approach: provide an `axiom instrument` build step that rewrites the Go source AST to inject `context.Context` propagation, similar to how OpenTelemetry instrumentation works.

---

## Compiled vs. Interpreted Language Lifecycles

```
Interpreted (Python, JS, Ruby)
  ├── Target app already running
  ├── DAP server attaches dynamically (no restart needed)
  └── Zero code changes required

Compiled, DAP-native (Go with delve, C# with mono-debug)
  ├── App started with debug flags (e.g. dlv exec, mono --debug)
  ├── DAP server connects on launch
  └── Function breakpoints work on debug builds

Compiled, no debug symbols (C++ release, Unity IL2CPP)
  ├── GDB/LLDB MI protocol as fallback
  ├── Significant overhead (~100x) - watchpoints only, not streaming
  └── Annotation-based SDK as alternative: developer imports axiom-cpp-sdk
      and marks functions to watch with a macro
```

The **Embedded SDK Mode** is a fallback for sandboxed environments (Unity WebGL, serverless, highly optimized release builds). The developer adds a small SDK to their project that speaks the same JSON-RPC protocol back to archd. This is more invasive but works where dynamic attachment is impossible.

---

## Safe Perturbation Model

Injecting values into running code can corrupt state, trigger side effects, or blow up the database. Three safety tiers:

**Tier 1 - Copy-on-Write**
Before overriding a parameter, the adapter deep-clones the original value. The running function sees the injected value; the rest of the application state is unaffected. Maximum clone depth: 5 levels. Binary/unknown types are replaced with null and flagged.

**Tier 2 - Boundary Sandboxing**
When a perturbation is active, outgoing network calls (HTTP, gRPC, database writes) that originate from the perturbed function's call subtree are intercepted and mocked. The app executes the logic; the side effects never reach external systems.

**Tier 3 - Database Transaction Wrapping**
For apps using standard ORMs (SQLAlchemy, GORM, Entity Framework), Axiom wraps the entire perturbation execution in a transaction and forces a `ROLLBACK` on completion. No writes reach the actual database.

The agent always specifies `"once": true` on inject commands by default. Persistent injection requires explicit opt-in.

---

## Data-Flow Slicing - Technical Implementation

Data-flow slicing answers the question: "everywhere this variable matters."

### Static pass (runs at index time, no runtime needed)

Tree-sitter already parses every file during indexing. Extend the parser pass to build a **def-use graph** per file:

For each variable assignment, function parameter, or return value, record:
- The file and line number
- Whether this is a definition, mutation, or read
- The enclosing function name

Store in a new SQLite table:
```sql
CREATE TABLE data_flow (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id),
  variable    TEXT NOT NULL,         -- normalized variable name
  kind        TEXT NOT NULL,         -- 'def' | 'use' | 'mutation' | 'param' | 'return'
  line        INTEGER NOT NULL,
  enclosing_symbol TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_data_flow_variable ON data_flow(variable);
CREATE INDEX idx_data_flow_file ON data_flow(file_id);
```

### Runtime enrichment (when adapter is active)

When the agent calls `get_data_flow("userId")` and a runtime adapter is connected, Axiom places temporary watches on every line identified in the static pass. As those lines execute, real values are captured and annotated onto the canvas nodes.

This is the hybrid model from ARISE (2025): static analysis finds the candidates, runtime execution fills in the actual values.

---

## Canvas Runtime Visualization

The canvas gains a new visual layer on top of the existing static graph:

### Node states

| State | Visual | Meaning |
|---|---|---|
| Idle | Default (white/dark border) | File exists, no runtime activity |
| Active | Cyan pulse ring | Function being watched, has been called |
| Hot | Orange glow | Function called more than N times/sec |
| Perturbed | Orange filled ring | Value injection active on this node |
| Passing | Green border | Last perturbation result: expected output |
| Failing | Red border | Last perturbation result: unexpected output / exception |
| Sliced | Purple highlight | Node is in the current data-flow slice |

### Call count badges

Nodes with active watches show a small badge with the number of times their watched function has been called this session. This lets the user see at a glance which functions are on the hot path.

### Inline value tooltips

Hovering a watched node shows: last seen argument values, last return value, last exception (if any). Values are truncated at 256 chars; deep objects show depth indicators.

### Inspect-Perturb-Validate loop on canvas

1. Agent traces a path → cyan animated edges
2. Agent watches a function → node pulses
3. Agent injects a value → node turns orange, other nodes dim
4. Execution resumes → downstream nodes turn green or red
5. Agent reports finding → path annotated with hypothesis text
6. User sees the entire investigation as it happened

---

## Trace Storage and Shareable Replay Links

Every runtime session is serialized to a `AxiomTrace` JSON document stored in SQLite.

```json
{
  "version": "1.0",
  "id": "trace-abcd-1234",
  "project": {
    "name": "payment-api",
    "commit": "ab2c9f182e",
    "language": "python"
  },
  "canvasSnapshot": {
    "nodes": [ { "id": "file_1", "path": "src/services/payment.py", "position": { "x": 100, "y": 200 } } ],
    "callTraces": [ { "source": "file_1", "target": "file_2", "symbol": "process_payment" } ]
  },
  "events": [
    { "type": "call",        "file": "src/services/payment.py", "symbol": "process_payment", "args": { "amount": "150.00" }, "timestamp": 1782806728000 },
    { "type": "inject",      "symbol": "process_payment", "param": "amount", "original": "150.00", "injected": "-1.00",   "timestamp": 1782806728010 },
    { "type": "exception",   "symbol": "validate_amount", "message": "Amount must be positive",                            "timestamp": 1782806728050 },
    { "type": "agent_note",  "text": "Bug confirmed: negative amounts bypass validation in validate_amount()",              "timestamp": 1782806728100 }
  ],
  "codeSnapshots": {
    "src/services/payment.py": "def process_payment(amount, currency):\n    ..."
  }
}
```

Saving this JSON to the DB and generating a short ID gives us a **shareable replay link**. When opened, the canvas plays back the agent's entire investigation step-by-step: which paths it traced, what values it saw, what it injected, where the bug appeared.

Instead of pasting a stack trace in Slack, you send a link where your teammate watches the bug execute.

---

## Cross-Language Traces

When a Python service calls a Go service via HTTP, passing an `X-Axiom-Trace-Id` header allows archd to stitch the two adapter event streams into a single continuous trace on the canvas.

```
Python service (debugpy adapter)
  calls HTTP → Go service (delve adapter)
    both report to archd with same traceId
      canvas renders one path: Python node → Go node → Go node
```

This works across any number of service hops as long as the trace ID is propagated in the request headers. For languages with standard HTTP middleware (Express, FastAPI, Gin), Axiom ships a middleware snippet that handles this automatically.

---

## Failure Modes and Mitigations

| Failure | Risk | Mitigation |
|---|---|---|
| **Event flooding** | Watching a function inside a render loop or tight inner loop crashes the WebSocket and buries the canvas in noise | Sliding-window rate limiter in the adapter: if call rate exceeds 100/sec, auto-disable the watch and send `runtime:rate_limit` to canvas. User sees warning, can re-enable with explicit throttle setting |
| **Large object serialization** | Serializing an ORM model or a deep data structure blocks execution and inflates memory | Max depth: 3 levels. Max string: 256 chars. Binary/unknown types: replaced with `[binary N bytes]` placeholder. Circular references: detected and truncated |
| **Orphaned adapter processes** | If archd crashes, per-language adapter processes stay alive consuming CPU | Adapters monitor stdin EOF. If stdin closes OR no heartbeat from archd in 10 seconds, adapter self-terminates |
| **State corruption from injection** | Injecting a value into a function that modifies shared state can corrupt the app | Copy-on-Write + boundary sandboxing + transaction rollback (tiered safety model above) |
| **Compiled builds without debug symbols** | Release builds of C++, Unity IL2CPP, etc. have no symbol information | Fallback to Embedded SDK mode; surface a clear error to the agent rather than silently returning empty data |
| **Agent debugging loop** | Agent gets stuck in an infinite inject-observe-inject cycle | Canvas surfaces a "loop detected" warning after 5 identical perturbation attempts. User can break the loop via the canvas UI |
| **Graph spaghetti** | Real-world codebases have thousands of nodes; drawing every data-flow path makes the canvas unreadable | Data-flow slices shown as a separate toggleable overlay layer. Only the files directly relevant to the current slice are highlighted; others are dimmed but not hidden |

---

## Language Adapter Build Roadmap

> Revised after hostile review. High-risk technical spikes are moved to the front so they gate the rest of the roadmap. Easy phases do not ship before we know if the hard ones are feasible.

### Phase 1 - Static inspection, no runtime (immediate)

**`get_function_body` MCP tool**
- Read `LineStart` / `LineEnd` from existing symbol table
- Slice the source file
- Return the raw source of the requested function
- Estimated: 1 day
- Value: agent can trace a path AND read every function body along it

### Phase 2 - Technical spike: DAP port sharing and streaming mode (Python)

**Goal:** Validate the two-mode architecture before committing to it.

Deliverables:
- Python `sys.monitoring` adapter (streaming mode - native hooks, non-blocking)
- DAP multiplexer prototype in archd (inspection mode - confirms IDE co-existence is solvable)
- `watch_function` with `runtime:call` / `runtime:return` events to canvas
- Canvas node pulse + call count badge
- Confirm: can archd and VS Code both debug the same Python process simultaneously?

This phase gates the rest. If DAP multiplexing is not feasible, inspection mode is IDE-takeover only (warn user). If `sys.monitoring` streaming is too slow, re-evaluate.

Estimated: 2–3 weeks

### Phase 3 - Technical spike: Go trace propagation without AST rewriting

**Goal:** Confirm that Go goroutine tracing works via delve's native capabilities before committing to Go support.

Deliverables:
- delve DAP connection from archd
- Goroutine tracking via delve's native `goroutines` command - no AST rewrite
- Confirm: can we track which goroutine a call came from without injecting context.Context?
- Decision: if not feasible without AST rewriting, Go tracing ships as single-goroutine only (no propagation across goroutine boundaries)

Estimated: 1–2 weeks

### Phase 4 - Python streaming: full watch + basic perturbation

With streaming mode validated, extend to full feature set:

Deliverables:
- `inject_value` via function wrapper (shallow copy only - refuses complex types)
- Warn-and-Confirm UI before any injection
- Canvas orange node state for active perturbation
- Green/red downstream path coloring
- Rate limiter in Python adapter (>100 calls/sec → auto-disable watch)

Estimated: 2 weeks

### Phase 5 - Canvas focused subgraph and viewport culling

Before more languages, make the canvas production-ready for runtime data:

Deliverables:
- Viewport culling enabled (nodes outside viewport not rendered)
- Focused subgraph mode - when a trace is active, dim irrelevant nodes, hide off-path edges
- Inline value tooltips on watched nodes (last args, last return, last exception)
- Profile at 500 nodes with runtime events active - decision point on Canvas/WebGL rewrite

Estimated: 1–2 weeks

### Phase 6 - Node.js / JavaScript

Deliverables:
- V8 Inspector / CDP client in archd (or thin Node.js bridge process)
- Streaming mode: CPU profiler trace events (non-blocking)
- Inspection mode: CDP `Debugger.evaluateOnCallFrame` for deep inspection
- `AsyncLocalStorage` trace propagation middleware snippet
- `watch_function`, `inject_value` for Node.js targets

Estimated: 2 weeks

### Phase 7 - Variable references (data-flow, scoped)

Deliverables:
- Tree-sitter def-use graph extraction per file during indexing
- `variable_refs` SQLite table (scoped to file - not cross-file)
- `get_data_flow` MCP tool with LSP delegation for cross-file references
- Canvas variable reference overlay (purple highlight, separate layer from call traces)
- LSP query fallback: if LSP is running, query `textDocument/references` for cross-file hits

Estimated: 2–3 weeks

### Phase 8 - Investigation capture (shareable links)

Deliverables:
- `AxiomTrace` JSON schema linked to Git commit SHA
- Serialize sessions to SQLite with short IDs
- Canvas investigation replay mode - plays back agent steps in order
- Clearly named "Investigation Capture" not "replay" - sets accurate expectations

Estimated: 1–2 weeks

### Phase 9 - C# / Unity

Deliverables:
- `mono-debug` DAP connection from archd
- Streaming mode via Mono profiler API (MonoProfiler hooks)
- IL2CPP fallback: Embedded SDK mode (`axiom-unity-sdk` package)
- Unity MonoBehaviour lifecycle awareness (Start, Update, Awake hooks)

Estimated: 3–4 weeks

### Phase 10 - C++ and beyond

- LLDB-DAP adapter
- GDB MI protocol as fallback for unstripped binaries
- Embedded SDK (`axiom-cpp-sdk`) with macro annotations as primary path
- Java: `java-debug` (Microsoft's DAP server for JVM)
- Ruby: `ruby-debug-ide` DAP wrapper

Pattern repeats for every new language: find the DAP server or native hook mechanism, write archd connection glue, normalize events to the universal event schema.

---

## What This Looks Like as a Demo

A developer has a bug in a Python payment service. The amount validator is passing negative values through.

1. Agent calls `get_call_path("process_payment.py", "validate_amount.py")` → path animates on canvas
2. Agent calls `get_function_body("validate_amount.py", "validate")` → reads the actual validation code
3. Agent spots a suspicious branch: `if amount > 0` (should be `>= 0`)
4. Agent calls `watch_function("process_payment.py", "process_payment")` → node starts pulsing
5. Developer runs the app, triggers a payment → canvas shows `process_payment` called with `amount=150.00`, returned `success`
6. Agent calls `inject_value("process_payment.py", "process_payment", "amount", "-1.00")` → node turns orange
7. Developer triggers another payment → canvas shows exception in `validate_amount` → path turns red
8. Agent: "Bug confirmed. `validate_amount` at line 12 uses `> 0` instead of `>= 0`, which allows negative values. Injecting `-1.00` exposes the gap - negative amounts reach `process_payment` without being caught."
9. Developer shares trace link - teammate opens it, watches the entire investigation play back

This is reproducible, visual, and shareable. It is not a wall of terminal output. It is not a static stack trace. It is the AI's investigation made spatially legible.

---

## Critical Issues Raised by Review (and Resolutions)

After hostile review, these concerns were identified. Each is addressed:

### 1. DAP breakpoints are blocking - they will grind the app to a halt

**The problem:** DAP breakpoints suspend the entire execution thread. At 50 calls/sec, stopping at a function breakpoint for 10–100ms per hit will make any real app unusable. Health checks will fail in containers. HTTP clients will time out.

**Resolution:** DAP is used *only* for deep inspection and perturbation - one-shot, agent-requested pauses. For continuous call streaming, use native language hooks instead:
- Python: `sys.monitoring` (PEP 669) directly - compiles into bytecode, near-zero overhead
- Node.js: V8 CPU Profiler trace events or `--cpu-prof` - non-blocking
- Go: eBPF uprobes or OpenTelemetry SDK hooks - out of process

Two modes: **Streaming mode** (native hooks, always on, low overhead) and **Inspection mode** (DAP, agent-requested, halts execution briefly). The agent explicitly requests inspection mode when it wants to freeze a call and perturb values.

### 2. IDE debugger port lockout - one debugger per process

**The problem:** `debugpy`, `delve`, and Node inspector only allow one debugger connection. If archd connects, the developer's VS Code is locked out.

**Resolution:** archd implements a **DAP multiplexer** in inspection mode - it acts as a DAP server to the IDE while connecting as a DAP client to the language adapter. It merges breakpoint lists from both sources and routes stopped events to both clients. In streaming mode (native hooks), no conflict exists because the IDE debugger remains free.

For the initial implementation: streaming mode ships first. Inspection/perturbation mode is explicitly opt-in and surfaces a warning: "Axiom is taking debugger control. Your IDE debugger will be disconnected."

### 3. Safe perturbation is harder than claimed

**The problem:** Copy-on-Write fails on objects containing sockets, locks, or circular references. Auto-mocking via DAP cannot intercept system calls or async-escaped side effects. DB transaction wrapping requires ORM-specific integration that cannot be generic.

**Resolution:** Abandon automatic sandboxing as the default. Replace with:
- **Warn-and-Confirm model**: before any injection, the agent describes what it is changing and requires user confirmation. The canvas shows a clear "Perturbation active - side effects may occur" warning.
- **Explicit mock definitions**: the developer provides mock return values for external calls (DB, HTTP) if they want sandboxed behavior. Not automatic.
- **Shallow copy only**: Copy-on-Write limited to primitive types and plain data objects. If a type cannot be safely cloned (contains a socket, lock, or cycle), injection is refused and the agent is told why.
- **DB transactions**: opt-in via explicit session flag, not automatic. Works only with supported ORMs (SQLAlchemy, GORM, EF Core) when the developer opts in.

### 4. Cross-language trace stitching is fragile

**The problem:** Injecting `X-Axiom-Trace-Id` only handles incoming HTTP. Outgoing HTTP clients need library-specific monkeypatching. Kafka/gRPC/message queues are completely unhandled. Clock drift between adapters creates ordering problems.

**Resolution:**
- Don't invent a custom header scheme. Use W3C Trace Context (`traceparent`) - it's already the standard. If a project uses OpenTelemetry, Axiom reads its spans directly.
- Replace timestamps with causal IDs: every event carries `traceId` + `spanId` + `parentSpanId`. Canvas reconstructs the graph by causality, not by clock.
- Cross-language stitching is an **advanced feature**. Ship single-language tracing first. Document that cross-service tracing requires W3C Trace Context propagation in the target app.

### 5. Tree-sitter cannot do repository-wide data-flow slicing

**The problem:** Tree-sitter parses one file at a time with no type resolver or import graph. It cannot track a variable across file boundaries. Dynamic property access (`user['id']`) is invisible to static analysis.

**Resolution:**
- Static data-flow slicing is scoped to **single files only**. Within a file, Tree-sitter's def-use graph is accurate.
- Cross-file slicing delegates to an active **Language Server (LSP)** via `textDocument/references` - this is what LSP exists for. If an LSP is running (most developers have one), Axiom queries it. If not, slicing is file-scoped and the agent is told so.
- Rename "data-flow slicing" to "variable references" to set accurate expectations.

### 6. Go AST rewriting will corrupt DWARF debug tables

**The problem:** Rewriting Go source ASTs to inject `context.Context` changes line numbers, corrupting DWARF tables used by delve. It also breaks any function that implements an interface defined in an external package (cannot add a parameter to a function that must match an external interface signature).

**Resolution:**
- No AST rewriting for Go. Drop it.
- Goroutine trace propagation via delve's native goroutine tracking instead.
- Cross-service Go tracing requires the project to already use OpenTelemetry context propagation. Axiom reads those spans.
- `axiom instrument` CLI is removed from the plan.

### 7. Replay schema is misleading

**The problem:** Storing file paths without a Git commit SHA means replays break if the code changes. Calling it "replay" implies Replay.io-style time travel execution, which this is not.

**Resolution:**
- Rename to **"Investigation Capture"**. Clearly documented as a recording of the agent's path and observed values - not executable replay.
- Link all events to a **Git commit SHA** (`"commit": "ab2c9f182e"`) rather than file snapshots. Canvas renders the correct code version from git history when replaying.
- Store `codeSnapshots` only for the specific functions that were inspected, not whole files. Limits DB bloat.

### 8. ReactFlow performance cliff

**The problem:** Rendering 500+ DOM nodes with live pulse animations, badges, and animated SVG edges will drop below 10fps.

**Resolution:**
- Enable ReactFlow viewport culling immediately - only render nodes in the current viewport.
- **Focused subgraph mode**: when a trace or investigation is active, dim all nodes not in the call chain and hide edges outside it. The canvas shows a focused view, not the full 500-node graph.
- Defer Canvas/WebGL rewrite until profiling at 500 nodes with runtime events active shows it's actually needed - but design the node renderer to be swappable.

---

## Open Decisions

These are not yet resolved and need input before implementation begins:

1. **DAP transport: stdio vs TCP** - stdio is simpler for local development, TCP is required for containerized/remote targets. Default to stdio, add TCP support in Phase 5.

2. **Go context propagation: AST rewrite vs eBPF** - AST rewrite works everywhere but requires a build step. eBPF is zero-code-change but Linux-only and cannot easily read local variables. Recommendation: AST rewrite as primary, eBPF for network/syscall-level tracing only.

3. **Perturbation auto-mocking depth** - How aggressively should the adapter intercept outgoing network calls during a perturbation? Recommendation: opt-in per session. User enables "sandbox mode" before injecting; without it, network calls are real.

4. **Data-flow variable name disambiguation** - A variable named `id` exists in hundreds of files. Slicing on `id` without a file scope produces noise. Recommendation: always require a file scope for common names; warn the agent when the slice exceeds 50 files.

5. **Canvas performance at scale** - ReactFlow with SVG edges degrades past ~500 nodes. Runtime overlay adds more elements. Recommendation: profile at 500 nodes with runtime events active; if frame rate drops below 60fps, switch hot-path rendering to Canvas API / WebGL.
