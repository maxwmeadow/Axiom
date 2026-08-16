# Axiom - Infra Layer: Complete Architecture Plan

> Status: Draft for review
> Authors: Claude Fable 5 + Gemini (research/challenge)
> Last updated: 2026-07-09

---

## Vision

ARCHITECTURE.md names four node types. Three exist on the canvas today. **Infra - the fourth - has never rendered a single node.** The `infra_nodes` table, a bare `POST /api/infra` endpoint, and a generic `InfraNode.tsx` chip exist, but nothing creates infra nodes, no MCP tools expose them, and the type system is a flat `infra_type TEXT`.

The vision: **your codebase map shows what your code talks to, not just what it is.** Postgres, Mongo, Redis, S3, Stripe, OpenAI, Vercel - each a first-class canvas node with its own visual identity and its own capabilities, connected to the files and systems that touch it with semantically typed edges. When the runtime layer is active, those edges light up with real traffic.

Every provider node is instantly recognizable (a Mongo node looks like Mongo, an OpenAI node looks like OpenAI), and each knows what kinds of connections are legal for its category - a queue has publishers and consumers, a database has readers and writers, a platform has deployments.

---

## Prior Art

| Source | What we take |
|---|---|
| **mingrammer Diagrams** | The Provider → Category → Node taxonomy covering AWS/Azure/GCP/K8s/OnPrem/SaaS - proof that a registry of hundreds of services is tractable as data, not code |
| **Backstage software catalog** | The Component/API/Resource relations model - infra as "Resource" entities with typed `dependsOn`/`providesApis`/`consumesApis` relations |
| **OpenTelemetry semantic conventions** | Canonical service identifiers (`db.system.name`: `postgresql`, `mongodb`, `redis`, …) - we adopt OTel names as our service IDs wherever they exist, which also future-proofs runtime trace correlation |
| **simple-icons (CC0) + official provider icon sets** | 3,400+ monochrome brand SVGs with official brand colors for node skins; AWS/Azure/GCP publish official architecture icon sets permitted for architecture diagrams |
| **SCA tooling (Snyk/Dependabot model)** | Detection reads *manifests first* (package.json, requirements.txt, go.mod), then import statements, then config - layered confidence |

---

## Core Model: Category × Provider × Service

A flat `infra_type` cannot express "RDS is a database, from AWS, running Postgres." Three orthogonal axes:

- **Category** - the *semantic role*. Determines edge semantics, canvas shape language, and detail-panel layout. Small closed set (~12), owned by Axiom.
- **Provider** - the *brand*. Determines icon, color, grouping. Open set (aws, azure, gcp, cloudflare, vercel, railway, render, mongodb, openai, stripe, …).
- **Service** - the *specific product*. Determines capabilities, config fields, detection signatures. Open set, defined in the registry (aws/rds, aws/s3, aws/lambda, openai/api, mongodb/atlas, …).

Examples:

| Node | category | provider | service |
|---|---|---|---|
| Production Postgres on RDS | `database` | `aws` | `aws/rds` |
| Mongo Atlas cluster | `database` | `mongodb` | `mongodb/atlas` |
| Redis cache | `cache` | `redis` | `redis/redis` |
| OpenAI API | `llm` | `openai` | `openai/api` |
| Stripe | `api` | `stripe` | `stripe/api` |
| S3 bucket | `storage` | `aws` | `aws/s3` |
| SQS queue | `queue` | `aws` | `aws/sqs` |
| Vercel deployment | `platform` | `vercel` | `vercel/platform` |

### Categories and their edge semantics

The category defines which edge kinds are legal and what they mean. This is the "parent class" behavior Max described.

| Category | Legal edge kinds (file/system → infra) | Notes |
|---|---|---|
| `database` | `READS`, `WRITES`, `MIGRATES` | subtype field: `sql` \| `document` \| `kv` \| `graph` \| `vector` \| `timeseries` |
| `cache` | `READS`, `WRITES` | TTL-oriented detail panel |
| `queue` | `PUBLISHES`, `CONSUMES` | two files on the same queue node form an implicit async call path - canvas can render publisher→queue→consumer as a traceable flow |
| `storage` | `READS`, `WRITES` | object/blob storage |
| `search` | `QUERIES`, `INDEXES` | Elasticsearch, Algolia, Meilisearch |
| `llm` | `CALLS` | model/token metadata in detail panel; OpenAI, Anthropic, local Ollama |
| `api` | `CALLS`, `HANDLES_WEBHOOK` | external SaaS APIs - Stripe, Twilio, GitHub; `HANDLES_WEBHOOK` marks webhook handler entry points |
| `auth` | `AUTHENTICATES_VIA` | Auth0, Clerk, Supabase Auth, Firebase Auth |
| `platform` | `DEPLOYS_TO` | source is usually a **system or root**, not a file - Vercel, Railway, Render, Fly, k8s |
| `cdn` | `SERVES_VIA` | Cloudflare, Fastly, CloudFront |
| `observability` | `REPORTS_TO` | Sentry, Datadog, Posthog |
| `email` | `SENDS_VIA` | Resend, SendGrid, SES |

**All edges are strictly file/system→infra - no reversed edge types.** (Hostile review flagged that a single infra→file edge kind would force direction-special-casing into every traversal in the Go query layer, MCP tools, and canvas. `HANDLES_WEBHOOK` keeps the record code→infra; the renderer draws the arrowhead pointing at the file to preserve the visual data-flow.) All infra edges live in the existing `dependencies` table with `dst_type='infra'` and the new `dependency_type` values above - no new edge table.

---

## The Service Registry (the heart of the design)

**Adding a new service must be a data change, not a code change.** All service knowledge lives in a registry: one definition per service, versioned in the repo, loaded by both archd (detection) and the renderer (display).

```jsonc
// registry/services/aws/rds.jsonc - one entry, illustrative
{
  "id": "aws/rds",
  "name": "Amazon RDS",
  "category": "database",
  "subtype": "sql",
  "provider": "aws",
  "brand": { "icon": "amazonrds", "color": "#527FFF", "darkColor": "#7A9FFF" },
  "configFields": ["engine", "region", "instance"],       // shown in detail panel / edit dialog
  "detect": {
    "packages": {                                          // manifest + import detection, per language
      "js":  ["@aws-sdk/client-rds", "pg", "mysql2"],      // driver packages imply engine
      "py":  ["boto3", "psycopg2", "pymysql"],
      "go":  ["github.com/aws/aws-sdk-go-v2/service/rds", "github.com/lib/pq"]
    },
    "envPatterns":  ["RDS_", "DATABASE_URL"],              // env var name prefixes
    "urlPatterns":  ["\\.rds\\.amazonaws\\.com"],          // connection-string / hostname regexes
    "confidence":   { "package": 0.5, "env": 0.7, "url": 0.9 }
  }
}
```

Notes:
- **Ambiguity is expected and handled by layering**: `pg` alone proposes a generic `database/postgresql` node; `pg` + an `.rds.amazonaws.com` URL upgrades the proposal to `aws/rds`. The most specific signal wins.
- **Generic fallbacks per category**: `generic/postgres`, `generic/http-api`, `generic/queue` - every category has an unbranded default so unknown services still get a correctly-behaving node (user can reskin later).
- **Layered registry resolution** (hostile-review fix - a compile-time-only registry would lock out private/internal services):
  1. Embedded defaults (`archd-go/registry/` via `go:embed`) - the ~40 shipped services
  2. Global user overrides: `~/.config/axiom/services/*.jsonc`
  3. Workspace overrides: `<root>/.axiom/services/*.jsonc` - teams define their internal RPC services, proprietary message buses, in-house platforms, committed to their repo
  Later layers override earlier by service id. The renderer never bundles its own copy: it fetches the *resolved* registry from archd (`GET /api/registry/services`) at startup, so archd and canvas cannot disagree and custom services get full visual treatment, not generic fallbacks.
- Initial registry: ~40 services covering the major providers (AWS core services, Azure core, GCP core, Cloudflare, Vercel/Railway/Render/Fly, Mongo/Supabase/Planetscale/Neon, Redis/Upstash, Stripe, OpenAI/Anthropic, Auth0/Clerk, Sentry, Resend/SendGrid). Grows by PR-adding JSON files.

---

## Schema Migration

```sql
-- infra_nodes gains typed identity + lifecycle
ALTER TABLE infra_nodes ADD COLUMN category    TEXT;                 -- 'database' | 'queue' | ...
ALTER TABLE infra_nodes ADD COLUMN provider    TEXT;                 -- 'aws' | 'openai' | ...
ALTER TABLE infra_nodes ADD COLUMN service     TEXT;                 -- 'aws/rds' registry id
ALTER TABLE infra_nodes ADD COLUMN subtype     TEXT;                 -- category-specific ('sql', 'vector', ...)
ALTER TABLE infra_nodes ADD COLUMN status      TEXT DEFAULT 'confirmed';  -- 'proposed' | 'confirmed' | 'dismissed'
ALTER TABLE infra_nodes ADD COLUMN detected_by TEXT;                 -- json: [{signal, file, evidence, confidence}]
-- existing: id, workspace_id, name, infra_type (kept, deprecated), config, position_x/y
```

Detection evidence rides on the node (`detected_by`), and per-edge evidence on `dependencies.created_by='parser'` plus a new `dependencies.evidence` column (file:line of the import/call that justified the edge).

**Referential integrity (hostile-review fix):** the `dependencies` table is polymorphic (`src`/`dst` + type columns) and SQLite cannot enforce foreign keys across it - today, deleting a file, system, or infra node strands its edges, and infra edges will make this visible fast. Add `AFTER DELETE` triggers on `files`, `systems`, and `infra_nodes` that delete matching `dependencies` rows. This fixes a latent pre-existing bug for file/system edges at the same time.

---

## Detection: Propose, Never Assert

**Manual creation is the primary path.** The user (add-infra dialog, registry picker) and the agent (MCP tools) build the infra map themselves; the canvas is fully functional with zero detection code. Detection is a convenience layer that ships in later phases and can be deferred indefinitely without blocking anything else - it only fills the tray with suggestions the user/agent would otherwise create by hand.

When detection does run: **the parser proposes, the human or agent confirms.** No node silently appears as confirmed. Proposals commit only to what the evidence supports - a `pg` import proposes *"a Postgres-compatible database"* as a generic category node; the confirm step asks the user to assign which actual service it is (RDS? Supabase? Neon? local?), pre-filtered to compatible registry entries. Confidence never exceeds evidence.

Three signal channels, cheapest first:

1. **Manifests** (index time, per root): parse `package.json` / `requirements.txt` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `*.csproj` dependencies against registry `detect.packages`. Yields *workspace-level* proposals ("this project uses Stripe") with low confidence - it can't say which files.
2. **Imports** (already parsed): archd's tree-sitter pass already extracts per-file imports. Match against the same package lists → yields the **file→infra edges** and raises node confidence. This is nearly free - it's a lookup over data we already have.
3. **Config / connection strings** (index time, opt-in file set): scan `.env*`, `docker-compose.y(a)ml`, `serverless.yml`, `vercel.json`, `fly.toml`, k8s manifests, and appsettings for `envPatterns` / `urlPatterns`. Highest confidence; can distinguish *instances* (two different `DATABASE_URL`s = two database nodes) and upgrades generic proposals to branded ones.
   - **Key-presence first** (hostile-review fix): the primary signal is *env variable names* (`STRIPE_API_KEY`, `REDIS_PASSWORD`) - values are often constructed dynamically in code, so URL-regex-only detection would miss most real projects.
   - **Secret safety**: connection strings are parsed with a strict RFC-3986 URI parser (Go `net/url`), the userinfo block is discarded before anything is inspected, and evidence records only the variable *name* and matched *host*. No custom regex ever touches a value - a malformed password in a regex capture is exactly how credentials leak into databases.

Proposal lifecycle: detection creates `status='proposed'` nodes + edges → canvas renders them ghosted in a "Proposed infra" tray → user confirms/dismisses per node (or "confirm all"), agent can do the same via MCP with reasoning. Re-index reconciles: proposals whose evidence vanished are auto-removed; dismissed nodes stay dismissed (keyed by service id, so the same dismissal isn't re-proposed every index).

---

## Canvas Design

### Node visuals - category shape, provider skin

The current `InfraNode.tsx` generic chip becomes a dispatcher:

- **Category → silhouette + layout**: databases render as the classic cylinder motif (drafting-table style: cylinder outline, engine badge), queues as a horizontal channel with in/out ports on opposite sides, storage as a bucket/tray, platforms as a wide underline band that systems sit above, APIs as a hexagonal port, LLMs as the API hexagon with a model chip.
- **Provider → skin**: brand icon (simple-icons id from registry) and brand color as the node's accent, following the existing drafting-table restyle (accent line + monochrome icon, not full-color logos, so the canvas stays coherent).
- **Status**: proposed nodes render ghosted (dashed outline, reduced opacity) with a confirm/dismiss affordance.
- **Category-specific ports**: a queue node exposes distinct `PUBLISHES` (left) and `CONSUMES` (right) handles; a database exposes read/write handles. Hand-drawn edges through a port get that edge kind automatically - this is how "custom ways you can connect them" becomes concrete.

### Placement and the Infra view

- Default placement: infra nodes auto-layout in a **band along the bottom edge** of the canvas (databases/caches/queues) and **top band** for platforms/CDN - code in the middle, dependencies at the periphery, deployment above. Draggable as usual afterward.
- **Infra lens** (toggle, like the data-flow overlay): dims file/system internals, thickens file→infra edges aggregated to system→infra ("Payments system → Stripe: 12 call sites"), giving the classic architecture-diagram view for free.
- Edge LOD follows the existing tiers: collapsed systems show system→infra bundles; expanded systems show file→infra edges; file selection shows the evidence list (file:line per call site) in the detail panel.

### Detail panel per category

Clicking an infra node shows: identity (service, provider, config fields), **who touches it** (files/systems grouped by edge kind - readers vs writers vs migrators), detection evidence, and - when the runtime layer is live - recent traffic (see below).

---

## MCP Tools

```
list_infra(status?)                        → all infra nodes with categories, providers, edge counts
create_infra_node(service, name, config?)  → agent-created node (status confirmed, source agent)
update_infra_node(id, …)                   → rename, reskin (change service), edit config
confirm_infra(id) / dismiss_infra(id)      → resolve proposals
connect_infra(file_or_system_id, infra_id, edge_kind, evidence?)
get_infra_for_files(file_ids)              → which infra these files touch, via which edge kinds
run_infra_detection()                      → re-run the detection pass on demand
```

Agent debugging flows this unlocks: *"which files write to the production DB?"*, *"trace the path from the webhook handler to the queue consumer"*, *"what breaks if we swap SendGrid for Resend?"* - all answerable from the graph.

---

## Runtime Enrichment (the Axiom-only differentiator)

Static detection says "this file *can* talk to Stripe." The runtime layer proves it:

- The Python/Node adapters already intercept function calls. A thin outbound-call observer (Python: `http.client`/`aiohttp` hooks; Node: `undici`/`http` diagnostics channel - both are existing, documented hook points) maps request hosts against registry `urlPatterns` and emits `runtime:infra_call` events.
- **File attribution without per-request stack traces** (hostile-review fix - full stack capture on every outbound request is a serious latency tax): the adapters already carry execution context. Node propagates the current instrumented function through `AsyncLocalStorage` (the tracing layer sets it on entry); Python uses the existing contextvar the monitor sets. The HTTP observer reads that context - O(1), no stack walk. Fallback when no instrumented frame is active: a sampled stack capture (first sighting of a `(host, path)` pair only) builds a cached host→file routing table; subsequent requests hit the cache.
- Canvas: the file→infra edge **pulses on real traffic**, the infra detail panel shows live request counts/last-seen, and unexercised static edges are distinguishable from hot ones.
- During a perturbation, outbound infra calls from the perturbed subtree render on the infra edges - the user *sees* the side-effect surface of an injection before confirming it.

This stays read-only observation (no mocking/blocking - that's the deferred Tier 2 sandbox work) and ships as a later phase.

---

## Failure Modes and Mitigations

| Failure | Mitigation |
|---|---|
| **False-positive proposals** (a dep in package.json that's never imported) | Manifest-only signals stay low-confidence and are labeled "declared but unused"; import/URL evidence required to cross the default proposal threshold |
| **Proposal spam on big monorepos** | Proposals are batched into one tray notification, deduped by service id per workspace; "dismiss provider" wildcard |
| **Secret leakage via evidence** | Evidence stores variable names/host patterns only; values are never read into the DB; `.env` scanning parses keys and URL *hosts*, redacting userinfo |
| **Registry staleness** (new SDK package names) | Generic category fallbacks catch unmatched DB drivers/HTTP clients; registry updates are data PRs |
| **Same service, multiple instances** (dev + prod Postgres, or users-db/orders-db/logs-db in a monorepo) | URL-channel detection keys nodes by host. For routing edges: exactly one confirmed instance → attach automatically; multiple → **system-level routing rules** ("files in the Orders system importing `pg` → orders-db"), set once by user or agent, evaluated before any per-file proposal. Per-file manual routing is the last resort, never the default - 100 files importing `pg` must be one decision, not 100 |
| **Canvas clutter** | Infra nodes live in peripheral bands, participate in existing viewport culling/LOD; infra lens for focus; per-category show/hide toggles |
| **Brand icon licensing** | simple-icons (CC0 set, monochrome paths) as the default skin source; official AWS/Azure/GCP architecture icons permitted for architecture diagrams if we later want full-fidelity icons |

---

## Build Roadmap

### Phase I1 - Foundation: registry + schema + manual nodes (1–1.5 weeks)
- Service registry format, layered loader (embedded + user + workspace overrides), `GET /api/registry/services`, initial ~40 service definitions + generic fallbacks
- Schema migration (category/provider/service/subtype/status/detected_by, dependencies.evidence, **referential-integrity triggers**)
- CRUD API completion + all MCP tools except `run_infra_detection`
- `InfraNode.tsx` dispatcher: category silhouettes × provider skins, drafting-table styled; detail panel v1
- User flow: add-infra dialog (searchable registry picker), draw file→infra edges with port-typed edge kinds

### Phase I2 - Detection channels 1+2: manifests + imports (1 week, optional/deferrable)
- Manifest parsers (npm/pip/go.mod/cargo/csproj), import matching against registry
- Proposal lifecycle (proposed/confirmed/dismissed, reconciliation on re-index)
- Proposal tray UI, ghosted nodes, confirm/dismiss (UI + MCP)

### Phase I3 - Detection channel 3: config + connection strings (1 week, optional/deferrable)
- `.env*` / compose / platform-config scanners, secret-safe evidence, instance disambiguation by host
- Brand upgrade logic (generic → specific service)

### Phase I4 - Infra lens + system aggregation (0.5–1 week)
- System→infra edge bundling with counts, infra lens toggle, placement bands

### Phase I5 - Runtime enrichment (1–2 weeks, after I1–I4 proven)
- Outbound-call observers in Python/Node adapters, `runtime:infra_call` events, live edge pulses + traffic panel

---

## Hostile Review Summary

The plan was challenged by Gemini before review. Six issues were raised; all are resolved inline above (marked "hostile-review fix"):

1. **Orphaned polymorphic edges** (severity 1) - `dependencies` has no FK integrity across `src`/`dst`; deleting nodes strands edges today. → `AFTER DELETE` triggers; also fixes a latent pre-existing bug.
2. **Compile-time registry lockout** - private/internal services impossible without rebuilding. → Layered registry (embedded → `~/.config/axiom` → workspace `.axiom/`), renderer fetches resolved registry from archd.
3. **Per-request stack traces in runtime enrichment** - serious latency tax. → Reuse the adapters' existing async-context propagation; sampled stack capture only as a cache-building fallback.
4. **Monorepo proposal fatigue** - 100 files importing `pg` must not mean 100 routing decisions. → System-level routing rules evaluated before per-file proposals.
5. **Reversed webhook edge direction** - one backwards edge type poisons every graph traversal. → `HANDLES_WEBHOOK`, strictly file→infra; renderer flips the arrowhead visually.
6. **Regex-parsed connection strings leak credentials / miss dynamic construction** - → key-presence detection first; strict RFC URI parsing with userinfo discarded before inspection.

---

## Open Decisions

1. **Registry format**: JSONC files per service (PR-friendly, diffable, and required anyway for user/workspace override layers) vs one TS module (type-checked). Recommendation: JSONC + a schema-validating test; renderer consumes the resolved registry from archd at runtime.
2. **Platform nodes' edge source**: `DEPLOYS_TO` from a root, a system, or the workspace? Recommendation: root (matches how deploys actually work in multi-root workspaces).
3. **Proposal confidence threshold**: auto-confirm ≥0.9 (URL evidence) or always require a click? Recommendation: always require confirmation in v1 - trust is earned.
4. **Icon strategy**: monochrome simple-icons only (coherent, CC0) vs official provider icon sets (recognizable, license-constrained). Recommendation: simple-icons monochrome as accent-colored line art in v1, consistent with the drafting-table aesthetic.
5. **Cross-service infra edges** (Lambda → SQS → Lambda without code in between): out of scope until IaC parsing (Terraform/CDK) is considered - flag as future work.
