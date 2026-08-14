#!/usr/bin/env node
/**
 * Axiom MCP Server
 *
 * Bridges the GQP SQLite database (read-only queries forwarded to archd) and HTTP REST API
 * (writes on localhost:7743) to MCP tools that can be used by Claude Code, Cursor, and other agent platforms.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { join } from 'path'
import { homedir } from 'os'
import { actionKind, actionSummary, actionTargets } from './agentAction.ts'
import { routeTool } from './toolRouting.ts'
import { findWorktreeForCwd, type WorktreeContext, type WorktreeRow } from './worktreeContext.ts'
import fs from 'fs'

// Helper: UUID generator for system nodes
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Stable for this MCP process: starting another task supersedes only this
// client's forgotten session, never another agent working in parallel.
const workOwnerKey = generateUUID()
const connectionId = generateUUID()
const hostArgument = process.argv.find(argument => argument.startsWith('--axiom-host='))
const agentHostId = (
  process.env.AXIOM_AGENT_HOST ?? hostArgument?.slice('--axiom-host='.length) ?? 'unknown'
).trim() || 'unknown'
interface ActiveWorkSession extends WorktreeContext {
  id: string
}

const activeWorkSessions = new Map<string, ActiveWorkSession>()

// Helper: Retrieve the active project metadata
interface ActiveProject {
  workspaceId: string
  name: string
  rootPath: string
}

/**
 * archd's HTTP API. Overridable so the server can be driven against an
 * isolated daemon in tests without touching a developer's real workspace.
 */
const API_BASE = process.env.AXIOM_API_URL ?? 'http://127.0.0.1:7743'

/**
 * Which project the agent is acting on. The desktop app writes this; an
 * override lets a harness point at a throwaway workspace.
 */
const ACTIVE_PROJECT_PATH =
  process.env.AXIOM_ACTIVE_PROJECT ?? join(homedir(), '.axiom', 'data', 'active_project.json')

function getActiveProject(): ActiveProject {
  const activeProjectPath = ACTIVE_PROJECT_PATH
  if (!fs.existsSync(activeProjectPath)) {
    throw new Error('No active project found. Please open a project in the Axiom desktop application.')
  }
  return JSON.parse(fs.readFileSync(activeProjectPath, 'utf8')) as ActiveProject
}

// Helper: Secure read-only SQL execution via Go daemon query gateway
async function queryDb(workspaceId: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(`${API_BASE}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, sql, params }),
  })
  if (!res.ok) {
    throw new Error(`SQL query failed ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<any[]>
}

// Helper: Post agent activity log to Go backend which broadcasts to WS client UI
async function postAgentActivity(workspaceId: string, message: string, level: 'info' | 'warn' | 'success' | 'error') {
  try {
    await fetch(`${API_BASE}/api/agent/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message, level }),
    })
  } catch (err) {
    console.error('[axiom-mcp] failed to post agent activity:', err)
  }
}

/**
 * Records one agent action so the canvas can show it and the visual log can
 * keep it. Best-effort by design: failing to log must never fail the agent's
 * actual work, so this never throws and is never awaited on the hot path.
 */
async function postAgentAction(
  workspaceId: string,
  tool: string,
  args: Record<string, any>,
  result: unknown,
  startedAt: number,
  error?: string,
  session?: ActiveWorkSession,
) {
  try {
    await fetch(`${API_BASE}/api/agent/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        cwd: process.cwd(),
        agent: agentHostId,
        rootId: session?.rootId,
        branch: session?.branch,
        sessionId: session?.id,
        tool,
        kind: actionKind(tool),
        summary: actionSummary(tool, args),
        targets: actionTargets(tool, args, result),
        durationMs: Date.now() - startedAt,
        status: error ? 'error' : 'ok',
        error: error ?? '',
      }),
    })
  } catch {
    // The log is an observability aid, never a dependency.
  }
}

async function currentWorktreeContext(workspaceId: string, cwd: string): Promise<WorktreeContext | undefined> {
  const roots = await queryDb(workspaceId, `
    SELECT id, path, branch FROM roots
    WHERE workspace_id = ? AND is_active = 1`, [workspaceId]) as WorktreeRow[]
  return findWorktreeForCwd(roots, cwd)
}

// Helper: resolve a sheet by ID or exact name.
async function resolveSheetId(workspaceId: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return ref
  const res = await fetch(`${API_BASE}/api/sheets?workspace=${encodeURIComponent(workspaceId)}`)
  if (!res.ok) throw new Error(`sheets list failed: ${await res.text()}`)
  const sheets = await res.json() as { id: string; name: string }[]
  const hit = (sheets ?? []).find(s => s.name === ref) ?? (sheets ?? []).find(s => s.name.toLowerCase() === ref.toLowerCase())
  if (!hit) throw new Error(`Sheet not found: ${ref}. Existing: ${(sheets ?? []).map(s => s.name).join(', ') || '(none)'}`)
  return hit.id
}

// Helper: resolve a model ref (file rel path / system name / infra name / UUID)
// to exactly one of {fileId|systemId|infraId} for sheet membership.
async function resolveModelRef(
  workspaceId: string,
  ref: string,
  rootId?: string,
): Promise<{ fileId?: string; systemId?: string; infraId?: string }> {
  const norm = ref.replace(/\\/g, '/').replace(/^(file|sys|infra):\/\//, '')
  // Files: exact rel path, then unique suffix.
  const fileRows = await queryDb(workspaceId, `
    SELECT f.id FROM files f JOIN roots r ON f.root_id = r.id
    WHERE r.workspace_id = ? AND (? = '' OR f.root_id = ?)
      AND (f.id = ? OR f.rel_path = ? OR f.rel_path LIKE ?)
    LIMIT 2`, [workspaceId, rootId ?? '', rootId ?? '', ref, norm, `%/${norm.split('/').pop()}`])
  if (fileRows.length === 1) return { fileId: fileRows[0].id }
  if (fileRows.length > 1) {
    const exact = await queryDb(workspaceId, `
      SELECT f.id FROM files f JOIN roots r ON f.root_id = r.id
      WHERE r.workspace_id = ? AND (? = '' OR f.root_id = ?) AND f.rel_path = ? LIMIT 1`,
      [workspaceId, rootId ?? '', rootId ?? '', norm])
    if (exact.length === 1) return { fileId: exact[0].id }
    throw new Error(`Ambiguous file ref "${ref}" — use the full relative path`)
  }
  const sysRows = await queryDb(workspaceId,
    `SELECT id FROM systems WHERE workspace_id = ? AND (id = ? OR name = ?) LIMIT 2`,
    [workspaceId, ref, norm])
  if (sysRows.length === 1) return { systemId: sysRows[0].id }
  if (sysRows.length > 1) throw new Error(`Ambiguous system name "${ref}" — pass the system ID`)
  const infraRows = await queryDb(workspaceId,
    `SELECT id FROM infra_nodes WHERE workspace_id = ? AND (id = ? OR name = ? OR service = ?) LIMIT 2`,
    [workspaceId, ref, norm, norm])
  if (infraRows.length === 1) return { infraId: infraRows[0].id }
  if (infraRows.length > 1) throw new Error(`Ambiguous infra ref "${ref}" — pass the node ID`)
  throw new Error(`No file, system, or infra node matches "${ref}"`)
}

// Piggyback trailer: Axiom owns one channel into every agent's context on
// every MCP host — its own tool results. When canvas messages are queued,
// every response carries a one-line hint (except on the canvas tools
// themselves, which are already the answer to the hint).
const CANVAS_TOOLS = new Set(['get_canvas_updates', 'await_canvas', 'reply_to_canvas'])
async function canvasTrailer(workspaceId: string, toolName: string): Promise<string> {
  if (CANVAS_TOOLS.has(toolName)) return ''
  try {
    const res = await fetch(
      `${API_BASE}/api/canvas/outbox?workspace=${encodeURIComponent(workspaceId)}&peek=1`
    )
    if (!res.ok) return ''
    const { queued } = await res.json() as { queued: number }
    if (queued > 0) {
      return `\n\n⚑ ${queued} unread canvas message${queued === 1 ? '' : 's'} from the user — call get_canvas_updates now and reply with reply_to_canvas.`
    }
  } catch { /* archd down or no workspace — stay silent */ }
  return ''
}

const server = new Server(
  { name: 'axiom', version: '0.3.0' },
  { capabilities: { tools: {}, prompts: {} } }
)

// ─── MCP Prompts: /axiom:review-canvas ──────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'review-canvas',
      description: 'Pull the latest canvas messages and staged UML changes from Axiom and act on them.',
      arguments: [],
    },
    {
      name: 'name-architecture',
      description: "Read this codebase and tell its owner what its systems actually are, as a tree they can confirm.",
      arguments: [],
    },
  ],
}))

// The instructions an agent follows to give a codebase its architecture.
//
// This deliberately hands over NO analysis. An earlier version of this workflow
// began from the clusters the indexer had already produced and asked the agent
// to repair them, which is a harder task than starting fresh: it inherits a
// hundred boundaries it did not set and cannot evaluate, and it anchors every
// answer to a partition chosen by symbol frequency. Reading code is the thing
// models are good at; arguing with someone else's partition is not.
const NAME_ARCHITECTURE_PROMPT = `Map this codebase's architecture for its owner, who is watching a spatial map of it in Axiom.

Produce a TREE OF SEMANTIC SYSTEMS.

**What a system is.** A responsibility — something the codebase does. Name it the way an engineer would say it aloud explaining the project to a new colleague.

A system is NOT a folder. Folders are for navigation; use them to find your way around, never as the answer. Two files in different directories belong to the same system when they serve the same responsibility, and one directory often holds several distinct systems.

**Nesting is the point, not a fallback.** Every system may contain sub-systems, and those may contain more. Go as deep as the code justifies — a large area earns four or five levels, a small utility earns none. "World Generation" contains "Biomes" contains "Temperature Falloff". If a system holds more than about ten files, ask whether it is really one thing or several. Prefer decomposing over leaving something flat. There may be hundreds of systems in the tree; that is correct. What must stay small is how many appear at any one level.

**Shape.** Around a dozen systems at the top — the parts you would list if asked what this application is made of. Then nest. For each: a name of two to four words in the vocabulary of the domain, one sentence saying what it is responsible for, and for leaf systems the files that belong to it. Parents own their children rather than files directly, unless a file genuinely sits at that level. Every source file lands somewhere, or is reported unplaced with a reason.

**How to work.** Start from the file tree only to orient yourself. Then READ. Open entry points, the largest files, anything whose name suggests it coordinates others. Do not infer from filenames — a file called utils.ts may be the core of a system. Where a boundary is genuinely ambiguous, say so and say what would settle it; you can call get_architecture with scope cross_dependencies or neighbors to ask what a specific file actually talks to, but only when a boundary is unclear. Do not begin from the systems that already exist on the map: those were named automatically from word frequency and describe nothing.

**What matters most.** Someone who did NOT write this code — because an agent wrote it for them — should read your tree and understand what this software is and how it is put together.

Write the result with edit_systems (op: create, then assign). The human confirms, renames or rejects what you propose; you are not committing an architecture, you are making a proposal they can read.`

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === 'name-architecture') {
    return { messages: [{ role: 'user', content: { type: 'text', text: NAME_ARCHITECTURE_PROMPT } }] }
  }
  if (request.params.name !== 'review-canvas') {
    throw new Error(`Unknown prompt: ${request.params.name}`)
  }
  const project = getActiveProject()
  const res = await fetch(
    `${API_BASE}/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=prompt`
  )
  const msgs = res.ok ? (await res.json() as any[]) ?? [] : []
  const text = msgs.length === 0
    ? 'The user invoked the Axiom canvas review, but there are no unread canvas messages. Call list_sheets / get_sheet to inspect the current diagrams and ask what they would like to look at.'
    : `The user sent ${msgs.length} message(s) from the Axiom UML canvas. For each: read it, inspect the referenced elements with axiom tools if needed, then ALWAYS answer via reply_to_canvas(msgId, body) — the user is watching the canvas, not this chat.\n\n` +
      msgs.map((m, i) =>
        `--- message ${i + 1} (msgId: ${m.id}) ---\nNote: ${m.note}\nSelection: ${m.selection}\nStaged canvas changes: ${m.changeSummary || '(none)'}${m.sheetId ? `\nSheet: ${m.sheetId}` : ''}`
      ).join('\n\n')
  return {
    messages: [{ role: 'user', content: { type: 'text', text } }],
  }
})

// ─── Tool list ─────────────────────────────────────────────────────────────

// ─── Tool surface ───────────────────────────────────────────────────────────
//
// Fifteen tools, not fifty-nine. Every legacy tool still executes — see
// toolRouting.ts — but only the consolidated set is advertised, because the
// listing is paid for on every single request an agent makes.
//
// Descriptions are deliberately short. They are the other half of the token
// cost, and a tool whose purpose needs a paragraph is usually two tools.

const CORE_TOOLS = [
  {
    name: 'get_architecture',
    description: "Read any part of the architecture map. Use `scope` to say what you want: overview | systems | system_files | files | unclassified | node | neighbors | family | cross_dependencies | dependency_graph | infra | infra_for_files | infra_catalog | hotspots. Start here before editing anything.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to describe. Defaults to overview.' },
        id: { type: 'string', description: 'Single system/node/file id, for the scopes that take one' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Several ids, for systems / infra_for_files' },
        depth: { type: 'number', description: 'How far to walk, for neighbors / family' },
        limit: { type: 'number' },
        minWeight: { type: 'number', description: 'cross_dependencies: ignore edges lighter than this' },
        status: { type: 'string', description: 'infra: filter by confirmed/proposed' },
      },
    },
  },
  {
    name: 'search_symbols',
    description: 'Find symbols by name across the workspace. The fastest way to locate something when you know roughly what it is called.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_symbols',
    description: 'List the symbols in one or more files, or fetch a single function body when you pass file + symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        fileIds: { type: 'array', items: { type: 'string' }, description: 'File IDs or relative paths' },
        file: { type: 'string', description: 'With `symbol`, returns that function body' },
        symbol: { type: 'string' },
      },
    },
  },
  {
    name: 'trace_calls',
    description: "Follow calls through the code: from → to for a path between two files, or fileIds for the call graph around a set of files. Traces animate live on the human's canvas as you run them.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        fileIds: { type: 'array', items: { type: 'string' } },
        direction: { type: 'string', description: 'in | out | both' },
        depth: { type: 'number' },
      },
    },
  },
  {
    name: 'get_data_flow',
    description: 'Trace where a variable is defined, written and read across files.',
    inputSchema: {
      type: 'object',
      properties: {
        variable: { type: 'string' },
        file: { type: 'string' },
        maxFiles: { type: 'number' },
      },
      required: ['variable'],
    },
  },
  {
    name: 'edit_systems',
    description: "Author the architecture map. YOU name the systems — existing names are placeholders from word frequency, never a starting point. Build a tree of responsibilities, not folders, nested as deep as the code justifies. `propose` submits the whole tree for the human to confirm and is the normal path; see /axiom:name-architecture. ops: propose | create | update | delete | assign | merge | bulk.",
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'propose | create | update | delete | assign | merge | bulk' },
        systems: {
          type: 'array',
          items: { type: 'object' },
          description: 'propose: the whole tree at once. Each: {systemKey, name, description, parentKey?, files?[]}',
        },
        rationale: { type: 'string', description: 'propose: one paragraph on how you read this codebase' },
        systemId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        parentId: { type: 'string' },
        fileIds: { type: 'array', items: { type: 'string' }, description: 'assign: files to move into systemId' },
        filePaths: { type: 'array', items: { type: 'string' } },
        sourceSystemId: { type: 'string', description: 'merge: system to absorb' },
        targetSystemId: { type: 'string', description: 'merge: system to keep' },
        updates: { type: 'array', items: { type: 'object' }, description: 'bulk: several system updates at once' },
      },
      required: ['op'],
    },
  },
  {
    name: 'edit_infra',
    description: 'Record the infrastructure the code actually talks to — databases, queues, caches, external APIs — and connect it to the files that use it. ops: create | update | delete | connect.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'create | update | delete | connect' },
        id: { type: 'string' },
        name: { type: 'string' },
        service: { type: 'string' },
        category: { type: 'string' },
        subtype: { type: 'string' },
        status: { type: 'string' },
        config: { type: 'object' },
        src: { type: 'string', description: 'connect: file or system id' },
        srcType: { type: 'string' },
        infraId: { type: 'string' },
        kind: { type: 'string', description: 'connect: READS | WRITES | PUBLISHES | ...' },
        evidence: { type: 'string', description: 'connect: file:line justifying the edge' },
      },
      required: ['op'],
    },
  },
  {
    name: 'edit_sheet',
    description: 'Work with sheets — named diagrams layered over the live map. ops: list | get | create | add | annotate.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'list | get | create | add | annotate' },
        sheet: { type: 'string', description: 'Sheet id or exact name' },
        name: { type: 'string' },
        purpose: { type: 'string' },
        members: { type: 'array', items: { type: 'object' } },
        target: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['op'],
    },
  },
  {
    name: 'get_inbox',
    description: 'Pending work from the human: messages, dispatched build plans, and staged UML changes. Call this first in a session. Pass waitSeconds to block until something arrives instead of polling.',
    inputSchema: {
      type: 'object',
      properties: {
        waitSeconds: { type: 'number', description: 'Block up to this long waiting for new work' },
      },
    },
  },
  {
    name: 'get_build_plan',
    description: 'Fetch a dispatched build plan: the boxes, paths, relationships and constraints the human drew for you to implement. By sheet, or by plan id.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        id: { type: 'string' },
      },
    },
  },
  {
    name: 'plan_element',
    description: 'Draw a planned element onto a sheet — a class, service or data store you intend to build. The human sees it appear and can confirm or reject before you write code.',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string' },
        declaredPath: { type: 'string', description: 'Where it will live' },
        members: { type: 'array', items: { type: 'object' } },
        notes: { type: 'string' },
        shape: { type: 'string' },
        color: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'reply_to_canvas',
    description: 'Answer a message the human left on the canvas. Your reply is anchored to whatever they were pointing at.',
    inputSchema: {
      type: 'object',
      properties: {
        msgId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['msgId', 'body'],
    },
  },
  {
    name: 'start_work',
    description: "Declare what you are about to build, BEFORE editing files. Every structural change you then make is recorded under this goal, so the human's Morning Delta shows your intent next to its architectural effect instead of bare topology. Call this at the start of any multi-file task.",
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you are setting out to do, in one plain sentence' },
        agent: { type: 'string', description: 'Your name/model, so the human knows who did the work' },
        focus: { type: 'array', items: { type: 'string' }, description: 'System or file ids you expect to touch' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'update_work',
    description: "Record a decision or caveat while you work — especially anything the human would otherwise reverse-engineer from the diff: why you crossed a boundary, what you deliberately skipped, a tradeoff you took. Pass done:true with a summary to close the session.",
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The decision, reason or caveat' },
        summary: { type: 'string', description: 'With done:true — what changed architecturally' },
        done: { type: 'boolean', description: 'Close this work session' },
      },
    },
  },
]

const DEBUG_PROFILE_TOOLS = [
  {
    name: 'debug_runtime',
    description: 'Live runtime debugging: watch symbols, inject test values, launch and inspect a target. ops: watch | unwatch | inject | cancel_inject | snapshot | launch | stop | log.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        file: { type: 'string' },
        symbol: { type: 'string' },
        param_name: { type: 'string' },
        value: {},
        once: { type: 'boolean' },
        injectId: { type: 'string' },
        command: { type: 'string' },
        cwd: { type: 'string' },
        language: { type: 'string' },
        targetId: { type: 'string' },
      },
      required: ['op'],
    },
  },
  {
    name: 'investigation',
    description: 'Record a debugging session as a replayable timeline. ops: start | note | stop | list | get.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['op'],
    },
  },
]

// Runtime/investigation tooling is real capability but wrong as a default: a
// coding agent does not need value injection in its context to write a class.
// Opt in with AXIOM_MCP_PROFILE=debug.
const DEBUG_PROFILE_ENABLED = (process.env.AXIOM_MCP_PROFILE ?? '').toLowerCase() === 'debug'

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: DEBUG_PROFILE_ENABLED ? [...CORE_TOOLS, ...DEBUG_PROFILE_TOOLS] : CORE_TOOLS,
}))

// ─── Tool execution ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params
  let args = rawArgs as Record<string, any> ?? {}
  // Preserved for the log: what the AGENT actually called, before routing.
  const callerArgs = args

  const startedAt = Date.now()
  let loggedWorkspaceId = ''
  let loggedWorkSession: ActiveWorkSession | undefined

  try {
    const project = getActiveProject()
    loggedWorkspaceId = project.workspaceId
    loggedWorkSession = activeWorkSessions.get(project.workspaceId)
    let result: unknown

    // Consolidated tools are rewritten into the legacy call that already
    // implements them. Legacy names still work when called directly — they are
    // simply no longer advertised, so they cost no context.
    const routed = routeTool(name, args)
    const call = routed?.tool ?? name
    if (routed) args = routed.args

    switch (call) {
      // ── READS (Queried via Go REST API Query Gateway) ──────────────────────
      case 'get_systems_overview': {
        await postAgentActivity(project.workspaceId, 'Agent queried systems overview', 'info')
        const sql = `
          SELECT id, name, parent_id as parentId, source, description, depth,
                 (SELECT COUNT(*) FROM files WHERE system_id = systems.id) as fileCount
          FROM systems
          WHERE workspace_id = ?
          ORDER BY depth ASC, name ASC
        `
        result = await queryDb(project.workspaceId, sql, [project.workspaceId])
        break
      }

      case 'get_unclassified_files': {
        await postAgentActivity(project.workspaceId, 'Agent queried unclassified files', 'info')
        const sql = `
          SELECT f.id, f.rel_path as relPath, f.language, f.line_count as lineCount
          FROM files f
          JOIN roots r ON f.root_id = r.id
          WHERE r.workspace_id = ? AND (f.system_id IS NULL OR f.system_id = '')
          ORDER BY f.rel_path ASC
        `
        result = await queryDb(project.workspaceId, sql, [project.workspaceId])
        break
      }

      case 'get_system_files': {
        const sysId = args.systemId as string
        const sysRows = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [sysId])
        const sysLabel = sysRows.length > 0 ? sysRows[0].name : sysId
        await postAgentActivity(project.workspaceId, `Agent queried files for system "${sysLabel}"`, 'info')
        const sql = `
          SELECT id, rel_path as relPath, language, line_count as lineCount
          FROM files
          WHERE system_id = ?
          ORDER BY rel_path ASC
        `
        result = await queryDb(project.workspaceId, sql, [sysId])
        break
      }

      case 'get_raw_files': {
        await postAgentActivity(project.workspaceId, 'Agent queried raw file list', 'info')
        const sql = `
          SELECT f.id, f.rel_path as relPath, f.language, f.line_count as lineCount, f.system_id as systemId
          FROM files f
          JOIN roots r ON f.root_id = r.id
          WHERE r.workspace_id = ?
          ORDER BY f.rel_path ASC
        `
        result = await queryDb(project.workspaceId, sql, [project.workspaceId])
        break
      }

      case 'get_call_graph': {
        await postAgentActivity(project.workspaceId, 'Agent queried call graph', 'info')
        const sql = `
          SELECT f1.rel_path AS caller, cg.caller_symbol AS callerSymbol,
                 f2.rel_path AS callee, cg.callee_symbol AS calleeSymbol,
                 cg.call_count AS callCount
          FROM call_graph cg
          JOIN files f1 ON cg.caller_file = f1.id
          JOIN files f2 ON cg.callee_file = f2.id
          JOIN roots r ON f1.root_id = r.id
          WHERE r.workspace_id = ?
        `
        result = await queryDb(project.workspaceId, sql, [project.workspaceId])
        break
      }

      case 'search_symbols': {
        const query = args.query as string
        const limit = args.limit ?? 20
        await postAgentActivity(project.workspaceId, `Agent searched symbols for query "${query}"`, 'info')
        const sql = `
          SELECT s.id, s.name, s.kind, s.line_start as lineStart, s.line_end as lineEnd, f.rel_path as relPath
          FROM symbols s
          JOIN files f ON s.file_id = f.id
          JOIN roots r ON f.root_id = r.id
          WHERE r.workspace_id = ? AND s.name LIKE ?
          LIMIT ?
        `
        result = await queryDb(project.workspaceId, sql, [project.workspaceId, `%${query}%`, limit])
        break
      }

      case 'get_node': {
        const id = args.id as string
        let rows = await queryDb(project.workspaceId, 'SELECT * FROM systems WHERE id = ?', [id])
        if (rows.length > 0) {
          result = { type: 'system', ...rows[0] }
          break
        }
        rows = await queryDb(project.workspaceId, 'SELECT * FROM files WHERE id = ?', [id])
        if (rows.length > 0) {
          result = { type: 'file', ...rows[0] }
          break
        }
        rows = await queryDb(project.workspaceId, 'SELECT * FROM infra_nodes WHERE id = ?', [id])
        if (rows.length > 0) {
          result = { type: 'infra', ...rows[0] }
          break
        }
        throw new Error(`Node ${id} not found`)
      }

      case 'get_neighbors': {
        const id = args.id as string
        const depth = args.depth ?? 2

        const visitedNodes = new Set<string>([id])
        const resultDependencies: any[] = []
        let currentFrontier = [id]

        for (let step = 0; step < depth; step++) {
          if (currentFrontier.length === 0) break
          const placeholders = currentFrontier.map(() => '?').join(',')
          const params = [project.workspaceId, ...currentFrontier, ...currentFrontier]
          
          const foundDependencies = await queryDb(project.workspaceId, `
            SELECT id, src, dst, src_type as srcType, dst_type as dstType, dependency_type as dependencyType, weight
            FROM dependencies
            WHERE workspace_id = ? AND (src IN (${placeholders}) OR dst IN (${placeholders}))
          `, params)

          const nextFrontier: string[] = []
          for (const dep of foundDependencies) {
            if (!resultDependencies.some(d => d.id === dep.id)) {
              resultDependencies.push(dep)
            }
            if (!visitedNodes.has(dep.src)) {
              visitedNodes.add(dep.src)
              nextFrontier.push(dep.src)
            }
            if (!visitedNodes.has(dep.dst)) {
              visitedNodes.add(dep.dst)
              nextFrontier.push(dep.dst)
            }
          }
          currentFrontier = nextFrontier
        }

        const nodes: any[] = []
        for (const nodeId of visitedNodes) {
          try {
            let rows = await queryDb(project.workspaceId, 'SELECT * FROM systems WHERE id = ?', [nodeId])
            if (rows.length > 0) { nodes.push({ type: 'system', ...rows[0] }); continue }
            rows = await queryDb(project.workspaceId, 'SELECT * FROM files WHERE id = ?', [nodeId])
            if (rows.length > 0) { nodes.push({ type: 'file', ...rows[0] }); continue }
            rows = await queryDb(project.workspaceId, 'SELECT * FROM infra_nodes WHERE id = ?', [nodeId])
            if (rows.length > 0) { nodes.push({ type: 'infra', ...rows[0] }); continue }
          } catch { /* ignore */ }
        }
        result = { nodes, dependencies: resultDependencies }
        break
      }

      // ── WRITES (Forwarded HTTP Mutations) ──────────────────────────────────

      // Propose a whole architecture for the human to confirm.
      //
      // One call carrying the entire tree, rather than a create-per-system
      // walk. A half-written architecture is not something anyone can review:
      // it reads as the agent's mistake rather than as work in progress, and
      // there is no honest moment at which to show it.
      //
      // Nothing here reaches the live map. Candidates sit in their own tables
      // until a human approves them one at a time, which is what makes "the
      // agent proposes, you decide" structurally true rather than a convention
      // some later code path forgets.
      case 'propose_architecture': {
        const proposed = Array.isArray(args.systems) ? args.systems : []
        if (proposed.length === 0) {
          throw new Error(
            'propose needs `systems`: the tree you are proposing. Each entry takes a systemKey, a ' +
            'name, a one-sentence description, an optional parentKey naming another proposed ' +
            'system, and files (relative paths) for leaf systems.',
          )
        }
        await postAgentActivity(
          project.workspaceId,
          `Proposing an architecture: ${proposed.length} systems`,
          'info',
        )
        // Depth is derived here rather than asked for. An agent that has to
        // keep a depth counter consistent with its own parent keys will
        // eventually disagree with itself, and the tree it drew is the truth.
        const keyOf = (system: any) => system.systemKey ?? system.key ?? system.name
        const parentKeyOf = (system: any) => system.parentKey ?? null
        const byKey = new Map(proposed.map((system: any) => [keyOf(system), system]))
        const depthOf = (system: any): number => {
          let depth = 0
          const seen = new Set<string>([keyOf(system)])
          let parent = parentKeyOf(system)
          while (parent && byKey.has(parent) && !seen.has(parent)) {
            seen.add(parent)
            depth += 1
            parent = parentKeyOf(byKey.get(parent))
          }
          return depth
        }

        // Membership travels as repository-relative paths, because that is what
        // an agent has after reading a repository. The daemon resolves them and
        // aborts the whole proposal if any path is missing or ambiguous — a
        // half-resolved architecture is not reviewable.
        const memberships = proposed.flatMap((system: any) =>
          (system.files ?? []).map((filePath: string) => ({
            filePath,
            targetSystemKey: keyOf(system),
            disposition: 'assign',
          })),
        )

        const res = await fetch(`${API_BASE}/api/architecture-proposals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            parentScopeType: 'workspace',
            createdBy: 'agent',
            round: {
              rationale: args.rationale ?? null,
              evidenceSummary: args.evidenceSummary ?? null,
              coverage: memberships.length > 0 ? 'complete' : 'no_change',
              systems: proposed.map((system: any) => ({
                systemKey: keyOf(system),
                name: system.name,
                description: system.description ?? null,
                parentRefType: parentKeyOf(system)
                  ? 'proposed_system'
                  : system.parentSystemId ? 'live_system' : 'scope',
                parentRefId: parentKeyOf(system) ?? system.parentSystemId ?? null,
                depth: depthOf(system),
              })),
              memberships,
            },
          }),
        })
        if (!res.ok) {
          const errMsg = await res.text()
          await postAgentActivity(project.workspaceId, `Proposal was not recorded: ${errMsg}`, 'error')
          throw new Error(`Could not record the proposal: ${errMsg}`)
        }
        const created = await res.json() as { id?: string; unresolvedFiles?: string[] }
        await postAgentActivity(
          project.workspaceId,
          `Architecture proposed — ${proposed.length} systems awaiting review`,
          'success',
        )
        result = {
          status: 'proposed',
          proposalId: created.id,
          systems: proposed.length,
          unresolvedFiles: created.unresolvedFiles ?? [],
          note: 'Nothing is on the map yet. The user approves, renames or sends back each system.',
        }
        break
      }

      case 'create_system': {
        // Writing straight to the map while a proposal is awaiting review is
        // how "the human confirms" quietly becomes optional: the agent gets
        // the same result without asking, so nothing forces it to ask. Refused
        // with the alternative named, not silently ignored.
        // The daemon returns a bare array. Reading `.proposals` off it found
        // nothing, so the guard silently passed and an agent wrote straight to
        // the map — the exact bypass this exists to prevent. Accept both
        // shapes: a guard that fails open is worse than no guard, because it
        // reads as enforcement while enforcing nothing.
        type Candidates = { decision?: string }
        type Listed = { systems?: Candidates[]; round?: { systems?: Candidates[] } }
        const openBody = await fetch(
          `${API_BASE}/api/architecture-proposals?workspace=${encodeURIComponent(project.workspaceId)}`,
        ).then(res => res.ok ? res.json() : null).catch(() => null) as
          Listed[] | { proposals?: Listed[] } | null
        const openProposals = Array.isArray(openBody) ? openBody : openBody?.proposals ?? []
        const awaitingReview = openProposals.some(proposal =>
          (proposal.round?.systems ?? proposal.systems ?? [])
            .some(system => system.decision === 'pending'),
        )
        if (awaitingReview) {
          throw new Error(
            'An architecture you proposed is still awaiting review. Adding systems directly would ' +
            'bypass it. Wait for the user to approve or send back what you proposed, then revise ' +
            'with edit_systems(op: "propose").',
          )
        }
        const systemId = generateUUID()
        const payload = {
          id: systemId,
          workspaceId: project.workspaceId,
          name: args.name,
          parentId: args.parentId || null,
          description: args.description || null,
          source: 'agent',
        }
        await postAgentActivity(project.workspaceId, `Creating system "${args.name}"`, 'info')
        const res = await fetch(`${API_BASE}/api/systems`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const errMsg = await res.text()
          await postAgentActivity(project.workspaceId, `Error creating system "${args.name}": ${errMsg}`, 'error')
          throw new Error(`HTTP mutation failed: ${errMsg}`)
        }
        await postAgentActivity(project.workspaceId, `System "${args.name}" created successfully`, 'success')
        result = { status: 'success', systemId }
        break
      }

      case 'update_system': {
        const sysId = args.systemId as string
        const dbRows = await queryDb(project.workspaceId, 'SELECT * FROM systems WHERE id = ?', [sysId])
        if (dbRows.length === 0) {
          throw new Error(`System ${sysId} not found`)
        }
        const existing = dbRows[0]

        const payload = {
          id: sysId,
          workspaceId: project.workspaceId,
          name: args.name !== undefined ? args.name : existing.name,
          parentId: args.parentId !== undefined ? (args.parentId || null) : existing.parent_id,
          description: args.description !== undefined ? (args.description || null) : existing.description,
          source: existing.source,
          color: existing.color,
          agentNotes: existing.agent_notes,
          depth: existing.depth,
          positionX: existing.position_x,
          positionY: existing.position_y,
          width: existing.width,
          height: existing.height,
        }

        await postAgentActivity(project.workspaceId, `Updating system "${payload.name}"`, 'info')
        const res = await fetch(`${API_BASE}/api/systems/${sysId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const errMsg = await res.text()
          await postAgentActivity(project.workspaceId, `Error updating system "${payload.name}": ${errMsg}`, 'error')
          throw new Error(`HTTP mutation failed: ${errMsg}`)
        }
        await postAgentActivity(project.workspaceId, `System "${payload.name}" updated successfully`, 'success')
        result = { status: 'success' }
        break
      }

      case 'delete_system': {
        const sysId = args.systemId as string
        const existing = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [sysId])
        const sysLabel = existing.length > 0 ? existing[0].name : sysId

        await postAgentActivity(project.workspaceId, `Deleting system "${sysLabel}"`, 'info')
        const res = await fetch(`${API_BASE}/api/systems/${sysId}?workspace=${project.workspaceId}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const errMsg = await res.text()
          await postAgentActivity(project.workspaceId, `Error deleting system "${sysLabel}": ${errMsg}`, 'error')
          throw new Error(`HTTP mutation failed: ${errMsg}`)
        }
        await postAgentActivity(project.workspaceId, `System "${sysLabel}" deleted successfully`, 'success')
        result = { status: 'success' }
        break
      }

      case 'assign_files_to_system': {
        const systemId = args.systemId as string
        const fileIds = args.fileIds as string[] | undefined
        const filePaths = args.filePaths as string[] | undefined

        const idsToAssign: string[] = []
        if (fileIds && fileIds.length > 0) {
          idsToAssign.push(...fileIds)
        }

        if (filePaths && filePaths.length > 0) {
          for (const fp of filePaths) {
            const f = await queryDb(project.workspaceId, `
              SELECT f.id FROM files f
              JOIN roots r ON f.root_id = r.id
              WHERE r.workspace_id = ? AND (f.path = ? OR f.rel_path = ?)
            `, [project.workspaceId, fp, fp])
            if (f.length > 0) {
              idsToAssign.push(f[0].id)
            } else {
              await postAgentActivity(project.workspaceId, `Warning: File not found ${fp}`, 'warn')
            }
          }
        }

        const systemName = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [systemId])
        const sysLabel = systemName.length > 0 ? systemName[0].name : systemId

        await postAgentActivity(project.workspaceId, `Assigning ${idsToAssign.length} files to system "${sysLabel}"`, 'info')

        for (const fileId of idsToAssign) {
          const res = await fetch(`${API_BASE}/api/files/${fileId}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemId, workspaceId: project.workspaceId }),
          })
          if (!res.ok) {
            const errMsg = await res.text()
            await postAgentActivity(project.workspaceId, `Error assigning file ${fileId}: ${errMsg}`, 'error')
            throw new Error(`HTTP mutation failed: ${errMsg}`)
          }
        }

        await postAgentActivity(project.workspaceId, `Assigned ${idsToAssign.length} files to system "${sysLabel}" successfully`, 'success')
        result = { status: 'success', assignedCount: idsToAssign.length }
        break
      }

      case 'merge_systems': {
        const sourceId = args.sourceSystemId as string
        const targetId = args.targetSystemId as string
        
        const sourceRows = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [sourceId])
        const targetRows = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [targetId])
        
        if (sourceRows.length === 0) throw new Error(`Source system ${sourceId} not found`)
        if (targetRows.length === 0) throw new Error(`Target system ${targetId} not found`)
        
        const sourceLabel = sourceRows[0].name
        const targetLabel = targetRows[0].name
        
        await postAgentActivity(project.workspaceId, `Merging system "${sourceLabel}" into "${targetLabel}"`, 'info')
        
        // 1. Reassign files in source system
        const filesToMove = await queryDb(project.workspaceId, 'SELECT id FROM files WHERE system_id = ?', [sourceId])
        for (const file of filesToMove) {
          const res = await fetch(`${API_BASE}/api/files/${file.id}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemId: targetId, workspaceId: project.workspaceId }),
          })
          if (!res.ok) throw new Error(`Failed to reassign file ${file.id}: ${await res.text()}`)
        }
        
        // 2. Reassign subsystems in source system
        const subsystemsToMove = await queryDb(project.workspaceId, `
          SELECT id, name, parent_id, source, color, description, agent_notes,
                 depth, position_x, position_y, width, height 
          FROM systems WHERE parent_id = ?
        `, [sourceId])
        for (const sys of subsystemsToMove) {
          const payload = {
            id: sys.id,
            workspaceId: project.workspaceId,
            name: sys.name,
            parentId: targetId,
            description: sys.description || null,
            source: sys.source,
            color: sys.color || null,
            agentNotes: sys.agent_notes || null,
            depth: sys.depth,
            positionX: sys.position_x,
            positionY: sys.position_y,
            width: sys.width,
            height: sys.height,
          }
          const res = await fetch(`${API_BASE}/api/systems/${sys.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!res.ok) throw new Error(`Failed to reassign subsystem ${sys.id}: ${await res.text()}`)
        }
        
        // 3. Delete the source system
        const res = await fetch(`${API_BASE}/api/systems/${sourceId}?workspace=${project.workspaceId}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(`Failed to delete source system ${sourceId}: ${await res.text()}`)
        
        await postAgentActivity(project.workspaceId, `System "${sourceLabel}" merged into "${targetLabel}" successfully`, 'success')
        result = { status: 'success' }
        break
      }

      case 'get_systems_with_files': {
        const systemIds = args.systemIds as string[]
        if (!systemIds || systemIds.length === 0) {
          result = []
          break
        }
        await postAgentActivity(project.workspaceId, `Agent queried files for ${systemIds.length} systems`, 'info')
        
        const placeholders = systemIds.map(() => '?').join(',')
        
        // 1. Fetch system metadata
        const systems = await queryDb(project.workspaceId, `
          SELECT id, name, parent_id as parentId, source, description, depth
          FROM systems
          WHERE id IN (${placeholders})
        `, systemIds)
        
        // 2. Fetch directly assigned files
        const files = await queryDb(project.workspaceId, `
          SELECT id, rel_path as relPath, language, line_count as lineCount, system_id as systemId
          FROM files
          WHERE system_id IN (${placeholders})
          ORDER BY rel_path ASC
        `, systemIds)
        
        // Map files to systems
        result = systems.map((sys: any) => ({
          ...sys,
          files: files.filter((f: any) => f.systemId === sys.id).map((f: any) => {
            const { systemId, ...rest } = f
            return rest
          })
        }))
        break
      }

      case 'update_systems_bulk': {
        const updates = args.updates as Array<{
          systemId: string
          name?: string
          description?: string
          parentId?: string | null
        }>
        
        if (!updates || updates.length === 0) {
          result = { status: 'success', updatedCount: 0, errors: [] }
          break
        }
        
        await postAgentActivity(project.workspaceId, `Batch updating ${updates.length} systems`, 'info')
        
        const systemIds = updates.map(u => u.systemId)
        const placeholders = systemIds.map(() => '?').join(',')
        
        // Fetch all existing states
        const dbRows = await queryDb(project.workspaceId, `
          SELECT * FROM systems WHERE id IN (${placeholders})
        `, systemIds)
        
        const lookup = new Map<string, any>()
        for (const row of dbRows) {
          lookup.set(row.id, row)
        }
        
        const errors: Array<{ systemId: string; error: string }> = []
        let updatedCount = 0
        
        // Process updates in parallel
        await Promise.all(updates.map(async (u) => {
          try {
            const existing = lookup.get(u.systemId)
            if (!existing) {
              throw new Error(`System ${u.systemId} not found`)
            }
            
            const payload = {
              id: u.systemId,
              workspaceId: project.workspaceId,
              name: u.name !== undefined ? u.name : existing.name,
              parentId: u.parentId !== undefined ? (u.parentId || null) : existing.parent_id,
              description: u.description !== undefined ? (u.description || null) : existing.description,
              source: existing.source,
              color: existing.color,
              agentNotes: existing.agent_notes,
              depth: existing.depth,
              positionX: existing.position_x,
              positionY: existing.position_y,
              width: existing.width,
              height: existing.height,
            }
            
            const res = await fetch(`${API_BASE}/api/systems/${u.systemId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            
            if (!res.ok) {
              throw new Error(await res.text())
            }
            updatedCount++
          } catch (err: any) {
            errors.push({
              systemId: u.systemId,
              error: err.message || String(err)
            })
          }
        }))
        
        await postAgentActivity(
          project.workspaceId, 
          `Batch update completed: ${updatedCount} success, ${errors.length} failures`, 
          errors.length > 0 ? 'warn' : 'success'
        )
        
        result = {
          status: errors.length > 0 ? 'partial_failure' : 'success',
          updatedCount,
          errors
        }
        break
      }

      case 'get_cross_system_dependencies': {
        const systemId = args.systemId as string | undefined
        const minWeight = args.minWeight ?? 1
        const limit = args.limit ?? 100
        
        await postAgentActivity(project.workspaceId, `Agent queried cross-system dependencies`, 'info')
        
        let sql = `
          SELECT
            d.id,
            d.src AS srcFileId, f1.rel_path AS srcFilePath, f1.system_id AS srcSystemId, COALESCE(s1.name, 'Unclassified') AS srcSystemName,
            d.dst AS dstFileId, f2.rel_path AS dstFilePath, f2.system_id AS dstSystemId, COALESCE(s2.name, 'Unclassified') AS dstSystemName,
            d.dependency_type AS dependencyType, d.weight
          FROM dependencies d
          JOIN files f1 ON d.src = f1.id
          JOIN files f2 ON d.dst = f2.id
          LEFT JOIN systems s1 ON f1.system_id = s1.id
          LEFT JOIN systems s2 ON f2.system_id = s2.id
          WHERE d.workspace_id = ?
            AND d.src_type = 'file'
            AND d.dst_type = 'file'
            AND f1.system_id IS NOT f2.system_id
            AND d.weight >= ?
        `
        const params: any[] = [project.workspaceId, minWeight]
        
        if (systemId) {
          sql += ` AND (f1.system_id = ? OR f2.system_id = ?)`
          params.push(systemId, systemId)
        }
        
        sql += ` ORDER BY d.weight DESC, f1.rel_path ASC LIMIT ?`
        params.push(limit)
        
        const rows = await queryDb(project.workspaceId, sql, params)
        
        const headers = ['Weight', 'Type', 'Source File (System)', 'Target File (System)']
        const rowsStr = rows.map((r: any) => 
          `| ${r.weight} | ${r.dependencyType} | ${r.srcFilePath} (${r.srcSystemName}) | ${r.dstFilePath} (${r.dstSystemName}) |`
        ).join('\n')
        
        result = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rowsStr}`
        break
      }

      case 'get_family': {
        const sysId = args.systemId as string
        const descendantDepth = args.descendantDepth as number | undefined
        
        const sysRows = await queryDb(project.workspaceId, 'SELECT name FROM systems WHERE id = ?', [sysId])
        if (sysRows.length === 0) {
          throw new Error(`System ${sysId} not found`)
        }
        
        await postAgentActivity(project.workspaceId, `Agent queried family of system "${sysRows[0].name}"`, 'info')
        
        // 1. Fetch all systems in the workspace
        const allSystems = await queryDb(project.workspaceId, `
          SELECT id, name, parent_id as parentId, source, description, depth
          FROM systems
          WHERE workspace_id = ?
        `, [project.workspaceId])
        
        const targetSystem = allSystems.find((s: any) => s.id === sysId)
        if (!targetSystem) {
          throw new Error(`System ${sysId} not found in workspace list`)
        }
        
        // 2. Build map by ID for fast lookup
        const sysMap = new Map<string, any>()
        const childrenMap = new Map<string, any[]>()
        
        for (const s of allSystems) {
          sysMap.set(s.id, s)
          if (s.parentId) {
            const list = childrenMap.get(s.parentId) || []
            list.push(s)
            childrenMap.set(s.parentId, list)
          }
        }
        
        // 3. Find ancestors
        const ancestors: any[] = []
        let currentParentId = targetSystem.parentId
        while (currentParentId) {
          const parent = sysMap.get(currentParentId)
          if (!parent) break
          ancestors.push(parent)
          currentParentId = parent.parentId
        }
        
        // 4. Find descendants with optional depth limit
        const descendants: any[] = []
        
        function collectDescendants(parentId: string, currentDepth: number) {
          if (descendantDepth !== undefined && currentDepth > descendantDepth) {
            return;
          }
          const children = childrenMap.get(parentId) || []
          for (const child of children) {
            descendants.push(child)
            collectDescendants(child.id, currentDepth + 1)
          }
        }
        
        collectDescendants(sysId, 1)
        
        const familyIds = [sysId, ...ancestors.map(a => a.id), ...descendants.map(d => d.id)]
        const placeholders = familyIds.map(() => '?').join(',')
        
        // 5. Fetch all files for the family systems in a single call
        const files = await queryDb(project.workspaceId, `
          SELECT id, rel_path as relPath, language, line_count as lineCount, system_id as systemId
          FROM files
          WHERE system_id IN (${placeholders})
          ORDER BY rel_path ASC
        `, familyIds)
        
        const filesBySys = new Map<string, any[]>()
        for (const f of files) {
          const list = filesBySys.get(f.systemId) || []
          const { systemId, ...rest } = f
          list.push(rest)
          filesBySys.set(f.systemId, list)
        }
        
        result = {
          targetSystem: {
            ...targetSystem,
            files: filesBySys.get(sysId) || []
          },
          ancestors: ancestors.map(a => ({
            ...a,
            files: filesBySys.get(a.id) || []
          })),
          descendants: descendants.map(d => ({
            ...d,
            files: filesBySys.get(d.id) || []
          }))
        }
        break
      }

      case 'get_call_graph_for_files': {
        const fileIds = args.fileIds as string[]
        const direction = (args.direction ?? 'both') as 'inbound' | 'outbound' | 'both'
        const depth = args.depth ?? 1
        
        if (!fileIds || fileIds.length === 0) {
          result = []
          break
        }
        
        await postAgentActivity(project.workspaceId, `Agent queried call graph for ${fileIds.length} files (depth: ${depth})`, 'info')
        
        // BFS traversal
        const visited = new Set<string>(fileIds)
        const dependencies: any[] = []
        let currentFrontier = [...fileIds]
        
        for (let step = 0; step < depth; step++) {
          if (currentFrontier.length === 0) break
          
          const placeholders = currentFrontier.map(() => '?').join(',')
          const params: any[] = [project.workspaceId]
          
          let queryCondition = ''
          if (direction === 'outbound') {
            queryCondition = `cg.caller_file IN (${placeholders})`
            params.push(...currentFrontier)
          } else if (direction === 'inbound') {
            queryCondition = `cg.callee_file IN (${placeholders})`
            params.push(...currentFrontier)
          } else {
            queryCondition = `(cg.caller_file IN (${placeholders}) OR cg.callee_file IN (${placeholders}))`
            params.push(...currentFrontier, ...currentFrontier)
          }
          
          const found = await queryDb(project.workspaceId, `
            SELECT f1.rel_path AS caller, cg.caller_symbol AS callerSymbol, cg.caller_file AS callerFileId,
                   f2.rel_path AS callee, cg.callee_symbol AS calleeSymbol, cg.callee_file AS calleeFileId,
                   cg.call_count AS callCount
            FROM call_graph cg
            JOIN files f1 ON cg.caller_file = f1.id
            JOIN files f2 ON cg.callee_file = f2.id
            JOIN roots r ON f1.root_id = r.id
            WHERE r.workspace_id = ? AND ${queryCondition}
          `, params)
          
          const nextFrontier: string[] = []
          for (const dep of found) {
            // Keep unique dependencies
            const exists = dependencies.some(d => 
              d.callerFileId === dep.callerFileId && 
              d.calleeFileId === dep.calleeFileId &&
              d.callerSymbol === dep.callerSymbol &&
              d.calleeSymbol === dep.calleeSymbol
            )
            if (!exists) {
              dependencies.push(dep)
            }
            
            // Collect next nodes to traverse depending on direction
            if (direction === 'outbound' || direction === 'both') {
              if (!visited.has(dep.calleeFileId)) {
                visited.add(dep.calleeFileId)
                nextFrontier.push(dep.calleeFileId)
              }
            }
            if (direction === 'inbound' || direction === 'both') {
              if (!visited.has(dep.callerFileId)) {
                visited.add(dep.callerFileId)
                nextFrontier.push(dep.callerFileId)
              }
            }
          }
          currentFrontier = nextFrontier
        }
        
        result = dependencies
        break
      }

      case 'get_symbols_for_files': {
        const fileIds = args.fileIds as string[]
        if (!fileIds || fileIds.length === 0) {
          result = []
          break
        }
        
        await postAgentActivity(project.workspaceId, `Agent queried symbols for ${fileIds.length} files`, 'info')
        const placeholders = fileIds.map(() => '?').join(',')
        
        const rows = await queryDb(project.workspaceId, `
          SELECT id, file_id as fileId, name, kind, line_start as lineStart, line_end as lineEnd
          FROM symbols
          WHERE file_id IN (${placeholders})
          ORDER BY file_id, line_start ASC
        `, fileIds)
        
        // Group by fileId
        const grouped = new Map<string, any[]>()
        for (const fileId of fileIds) {
          grouped.set(fileId, [])
        }
        
        for (const r of rows) {
          const list = grouped.get(r.fileId) || []
          list.push({
            id: r.id,
            name: r.name,
            kind: r.kind,
            lineStart: r.lineStart,
            lineEnd: r.lineEnd
          })
          grouped.set(r.fileId, list)
        }
        
        result = Array.from(grouped.entries()).map(([fileId, symbols]) => ({
          fileId,
          symbols
        }))
        break
      }

      case 'start_review': {
        await postAgentActivity(project.workspaceId, 'Agent started architecture baseline review', 'success')
        result = {
          message: "Architecture baseline review started.",
          instructions: `Review the UML architecture baseline for this project using the registered axiom MCP tools.

IMPORTANT AUDIT RULES:
1. Do NOT assume get_unclassified_files has files. If it returns empty, it means files are already clustered and you must perform a structural audit.
2. You MUST run get_cross_system_dependencies first to identify cross-boundary dependencies. This is your primary signal for misclassified files.
3. Call get_systems_with_files or get_family to inspect multiple systems and their files efficiently in bulk.
4. Call get_symbols_for_files to see symbol lists (classes, functions, etc.) for suspect files to understand their purpose without downloading full file contents.

Steps to execute:
1. Call get_systems_overview to see the high-level layout.
2. Run get_cross_system_dependencies to detect systems with tight coupling or misclassified files.
3. Move misclassified files to their correct systems using assign_files_to_system (which can move already-assigned files).
4. Rename and document systems semantically, nesting subsystems as needed. Use update_systems_bulk to apply updates in parallel.
5. Keep file/system operations batched to stay within context limits.`
        }
        break
      }

      case 'watch_function': {
        const file = args.file as string
        const symbol = args.symbol as string
        await postAgentActivity(project.workspaceId, `Agent watching function: ${symbol} in ${file}`, 'info')
        const res = await fetch(`${API_BASE}/api/runtime/watch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, file, symbol }),
        })
        if (!res.ok) throw new Error(`watch failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'unwatch_function': {
        const file = args.file as string
        const symbol = args.symbol as string
        await postAgentActivity(project.workspaceId, `Agent removed watch: ${symbol} in ${file}`, 'info')
        const res = await fetch(`${API_BASE}/api/runtime/unwatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, file, symbol }),
        })
        if (!res.ok) throw new Error(`unwatch failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'inject_value': {
        const file = args.file as string
        const symbol = args.symbol as string
        const paramName = args.param_name as string
        const value = args.value
        const once = args.once !== false
        await postAgentActivity(
          project.workspaceId,
          `Agent requests injection: ${symbol}(${paramName}=${JSON.stringify(value)}) in ${file} — awaiting user confirmation`,
          'warn',
        )
        const res = await fetch(`${API_BASE}/api/runtime/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, file, symbol, paramName, value, once }),
        })
        if (!res.ok) throw new Error(`inject failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'cancel_injection': {
        const injectId = args.injectId as string
        await postAgentActivity(project.workspaceId, `Agent cancelled injection ${injectId}`, 'info')
        const res = await fetch(`${API_BASE}/api/runtime/inject/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, injectId }),
        })
        if (!res.ok) throw new Error(`cancel failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_runtime_snapshot': {
        const res = await fetch(
          `${API_BASE}/api/runtime/snapshot?workspace=${encodeURIComponent(project.workspaceId)}`
        )
        if (!res.ok) throw new Error(`snapshot failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'launch_target': {
        const command = args.command as string[]
        const cwd = args.cwd as string | undefined
        const language = args.language as string | undefined
        await postAgentActivity(project.workspaceId, `Agent launching target: ${command.join(' ')}`, 'info')
        const res = await fetch(`${API_BASE}/api/runtime/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, command, cwd, language }),
        })
        if (!res.ok) throw new Error(`launch failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'stop_target': {
        const targetId = args.targetId as string
        await postAgentActivity(project.workspaceId, `Agent stopping target ${targetId}`, 'info')
        const res = await fetch(`${API_BASE}/api/runtime/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId }),
        })
        if (!res.ok) throw new Error(`stop failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_target_log': {
        const targetId = args.targetId as string
        const res = await fetch(
          `${API_BASE}/api/runtime/target-log?target=${encodeURIComponent(targetId)}`
        )
        if (!res.ok) throw new Error(`target-log failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'start_work': {
        const goal = args.goal as string
        const agent = (args.agent as string) ?? ''
        const focus = (args.focus as string[] | undefined) ?? []
        const focusSystemIds: string[] = []
        const focusFileIds: string[] = []
        const cwd = process.cwd()
        const worktree = await currentWorktreeContext(project.workspaceId, cwd)
        for (const ref of focus) {
          const resolved = await resolveModelRef(project.workspaceId, ref, worktree?.rootId)
          if (resolved.systemId) focusSystemIds.push(resolved.systemId)
          else if (resolved.fileId) focusFileIds.push(resolved.fileId)
          else throw new Error(`Work focus "${ref}" is infrastructure; use a file or system boundary`)
        }
        const res = await fetch(`${API_BASE}/api/work/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            cwd,
            ownerKey: workOwnerKey,
            goal,
            agent,
            focusSystemIds: [...new Set(focusSystemIds)],
            focusFileIds: [...new Set(focusFileIds)],
          }),
        })
        if (!res.ok) throw new Error(`start_work failed: ${await res.text()}`)
        result = await res.json()
        const session = result as ActiveWorkSession
        activeWorkSessions.set(project.workspaceId, session)
        loggedWorkSession = session
        await postAgentActivity(project.workspaceId, `Working: ${goal}`, 'info')
        break
      }

      case 'note_work': {
        const text = args.text as string
        const session = activeWorkSessions.get(project.workspaceId)
        if (!session) throw new Error('No active work session in this MCP client — call start_work first')
        const res = await fetch(`${API_BASE}/api/work/note`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, sessionId: session.id, text }),
        })
        if (!res.ok) throw new Error(`note_work failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Note: ${text}`, 'info')
        break
      }

      case 'finish_work': {
        const summary = args.summary as string
        const session = activeWorkSessions.get(project.workspaceId)
        if (!session) throw new Error('No active work session in this MCP client — call start_work first')
        const res = await fetch(`${API_BASE}/api/work/finish`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, sessionId: session.id, summary }),
        })
        if (!res.ok) throw new Error(`finish_work failed: ${await res.text()}`)
        result = await res.json()
        activeWorkSessions.delete(project.workspaceId)
        await postAgentActivity(project.workspaceId, `Finished: ${summary}`, 'success')
        break
      }

      case 'start_investigation': {
        const name = (args.name as string) ?? ''
        const res = await fetch(`${API_BASE}/api/investigation/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, name }),
        })
        if (!res.ok) throw new Error(`start_investigation failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent started investigation "${name || 'untitled'}" — recording`, 'success')
        break
      }

      case 'annotate_investigation': {
        const text = args.text as string
        const res = await fetch(`${API_BASE}/api/investigation/note`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, text }),
        })
        if (!res.ok) throw new Error(`annotate_investigation failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `📝 ${text}`, 'info')
        break
      }

      case 'stop_investigation': {
        const res = await fetch(`${API_BASE}/api/investigation/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId }),
        })
        if (!res.ok) throw new Error(`stop_investigation failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent saved investigation ${(result as any).id}`, 'success')
        break
      }

      case 'list_investigations': {
        const res = await fetch(`${API_BASE}/api/investigation/list?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`list_investigations failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_investigation': {
        const id = args.id as string
        const res = await fetch(`${API_BASE}/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`get_investigation failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_data_flow': {
        const variable = args.variable as string
        const file = args.file as string | undefined
        const maxFiles = args.maxFiles as number | undefined
        await postAgentActivity(project.workspaceId, `Agent slicing data-flow for variable "${variable}"${file ? ` in ${file}` : ''}`, 'info')
        const params = new URLSearchParams({ workspace: project.workspaceId, variable })
        if (file) params.set('file', file)
        if (maxFiles) params.set('maxFiles', String(maxFiles))
        const res = await fetch(`${API_BASE}/api/data-flow?${params.toString()}`)
        if (!res.ok) throw new Error(`data-flow failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_function_body': {
        const file = args.file as string
        const symbol = args.symbol as string
        await postAgentActivity(project.workspaceId, `Agent reading function body: ${symbol} in ${file}`, 'info')
        const res = await fetch(
          `${API_BASE}/api/function-body?workspace=${encodeURIComponent(project.workspaceId)}&file=${encodeURIComponent(file)}&symbol=${encodeURIComponent(symbol)}`
        )
        if (!res.ok) {
          const errMsg = await res.text()
          throw new Error(`function-body failed: ${errMsg}`)
        }
        result = await res.json()
        break
      }

      case 'get_call_path': {
        const from = args.from as string
        const to   = args.to   as string

        // Resolve path strings to file IDs if needed
        const resolveFileId = async (ref: string): Promise<string> => {
          // UUID pattern — already an ID
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return ref
          const rows = await queryDb(project.workspaceId, `
            SELECT f.id FROM files f
            JOIN roots r ON f.root_id = r.id
            WHERE r.workspace_id = ? AND (f.rel_path = ? OR f.path = ?)
            LIMIT 1
          `, [project.workspaceId, ref, ref])
          if (rows.length === 0) throw new Error(`File not found: ${ref}`)
          return rows[0].id
        }

        const fromId = await resolveFileId(from)
        const toId   = await resolveFileId(to)

        await postAgentActivity(project.workspaceId, `Agent tracing call path: ${from} → ${to}`, 'info')

        const res = await fetch(
          `${API_BASE}/api/call-path?workspace=${encodeURIComponent(project.workspaceId)}&from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`
        )
        if (!res.ok) {
          const errMsg = await res.text()
          throw new Error(`call-path failed: ${errMsg}`)
        }
        const data = await res.json() as { path: any[] }
        result = {
          found: data.path.length > 0,
          steps: data.path.length,
          path: data.path,
          note: data.path.length > 0
            ? 'Path is now animating on the Axiom canvas.'
            : 'No call path found between these files within 6 hops.',
        }
        break
      }

      // ── Infra layer (INFRA_LAYER_PLAN.md Phase I1) ─────────────────────────
      case 'list_infra_services': {
        const res = await fetch(`${API_BASE}/api/registry/services`)
        if (!res.ok) throw new Error(`registry fetch failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'list_infra': {
        await postAgentActivity(project.workspaceId, 'Agent listed infra nodes', 'info')
        const res = await fetch(`${API_BASE}/api/infra?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`infra list failed: ${await res.text()}`)
        const data = await res.json() as { nodes: any[]; edges: any[] }
        if (args.status) {
          data.nodes = (data.nodes ?? []).filter((n) => n.status === args.status)
        }
        result = data
        break
      }

      case 'create_infra_node': {
        const label = (args.name as string) || (args.service as string) || (args.category as string) || 'infra node'
        await postAgentActivity(project.workspaceId, `Agent creating infra node "${label}"`, 'info')
        const res = await fetch(`${API_BASE}/api/infra`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            name: args.name ?? '',
            service: args.service ?? '',
            category: args.category ?? '',
            subtype: args.subtype ?? '',
            config: args.config, // raw object — archd stores it as a JSON blob
            createdBy: 'agent',
          }),
        })
        if (!res.ok) {
          const errMsg = await res.text()
          await postAgentActivity(project.workspaceId, `Error creating infra node "${label}": ${errMsg}`, 'error')
          throw new Error(`create infra failed: ${errMsg}`)
        }
        await postAgentActivity(project.workspaceId, `Infra node "${label}" created`, 'success')
        result = await res.json()
        break
      }

      case 'update_infra_node': {
        const res = await fetch(`${API_BASE}/api/infra/${encodeURIComponent(args.id as string)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            name: args.name,
            service: args.service,
            status: args.status,
            config: args.config, // raw object — archd stores it as a JSON blob
          }),
        })
        if (!res.ok) throw new Error(`update infra failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent updated infra node ${args.id}`, 'success')
        break
      }

      case 'delete_infra_node': {
        const res = await fetch(
          `${API_BASE}/api/infra/${encodeURIComponent(args.id as string)}?workspace=${encodeURIComponent(project.workspaceId)}`,
          { method: 'DELETE' }
        )
        if (!res.ok) throw new Error(`delete infra failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent deleted infra node ${args.id}`, 'info')
        break
      }

      case 'connect_infra': {
        const srcType = (args.srcType as string) || 'file'
        let srcId = args.src as string
        // Resolve file relative paths to IDs (systems must be passed by ID).
        if (srcType === 'file' && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(srcId)) {
          const rows = await queryDb(project.workspaceId, `
            SELECT f.id FROM files f
            JOIN roots r ON f.root_id = r.id
            WHERE r.workspace_id = ? AND (f.rel_path = ? OR f.path = ? OR f.rel_path LIKE ?)
            LIMIT 1
          `, [project.workspaceId, srcId, srcId, `%${srcId}`])
          if (rows.length === 0) throw new Error(`File not found: ${srcId}`)
          srcId = rows[0].id
        }
        await postAgentActivity(project.workspaceId, `Agent connecting ${args.src} → infra (${args.kind})`, 'info')
        const res = await fetch(`${API_BASE}/api/infra/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            srcId,
            srcType,
            infraId: args.infraId,
            kind: args.kind,
            evidence: args.evidence,
            createdBy: 'agent',
          }),
        })
        if (!res.ok) throw new Error(`connect infra failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_activity_hotspots': {
        const limit = args.limit ?? 20
        const res = await fetch(
          `${API_BASE}/api/activity/hotspots?workspace=${encodeURIComponent(project.workspaceId)}&limit=${limit}`
        )
        if (!res.ok) throw new Error(`hotspots failed: ${await res.text()}`)
        const hots = await res.json() as any[]
        result = {
          hotspots: hots,
          note: hots.length > 0
            ? 'Scores decay with a 24h half-life; normalized is the 0-1 percentile within this workspace.'
            : 'No recent edit activity recorded. Activity tracking starts when files are saved while archd is running.',
        }
        break
      }

      case 'get_infra_for_files': {
        const refs = (args.fileIds as string[]) ?? []
        if (refs.length === 0) throw new Error('fileIds must not be empty')
        const ids: string[] = []
        for (const ref of refs) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) {
            ids.push(ref)
          } else {
            const rows = await queryDb(project.workspaceId, `
              SELECT f.id FROM files f
              JOIN roots r ON f.root_id = r.id
              WHERE r.workspace_id = ? AND (f.rel_path = ? OR f.rel_path LIKE ?)
              LIMIT 1
            `, [project.workspaceId, ref, `%${ref}`])
            if (rows.length > 0) ids.push(rows[0].id)
          }
        }
        const placeholders = ids.map(() => '?').join(',')
        result = await queryDb(project.workspaceId, `
          SELECT f.rel_path AS file, d.dependency_type AS kind, d.evidence,
                 i.id AS infraId, i.name AS infraName, i.category, i.provider, i.service
          FROM dependencies d
          JOIN files f ON f.id = d.src
          JOIN infra_nodes i ON i.id = d.dst
          WHERE d.src_type = 'file' AND d.dst_type = 'infra' AND d.src IN (${placeholders})
          ORDER BY f.rel_path, i.name
        `, ids)
        break
      }

      // ── Sheets (UML experience layer — UML_UX_PLAN.md U1) ─────────────────
      case 'list_sheets': {
        const res = await fetch(`${API_BASE}/api/sheets?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`sheets list failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_sheet': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const res = await fetch(
          `${API_BASE}/api/sheets/${encodeURIComponent(sheetId)}/asm?workspace=${encodeURIComponent(project.workspaceId)}`
        )
        if (!res.ok) throw new Error(`get sheet failed: ${await res.text()}`)
        const data = await res.json() as { asm: string }
        result = data.asm
        break
      }

      case 'create_sheet': {
        const members = (args.members as string[]) ?? []
        const elements = []
        for (const ref of members) {
          elements.push(await resolveModelRef(project.workspaceId, ref))
        }
        await postAgentActivity(project.workspaceId, `Agent creating sheet "${args.name}"`, 'info')
        const res = await fetch(`${API_BASE}/api/sheets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            name: args.name,
            purpose: args.purpose,
            createdBy: 'agent',
            elements,
          }),
        })
        if (!res.ok) throw new Error(`create sheet failed: ${await res.text()}`)
        const sheet = await res.json() as { id: string }
        await postAgentActivity(project.workspaceId, `Sheet "${args.name}" created`, 'success')
        result = { created: sheet, note: `Sheet created with ${elements.length} elements. The user can open it from the sheet rail.` }
        break
      }

      case 'add_to_sheet': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const elements = []
        for (const ref of (args.members as string[]) ?? []) {
          elements.push(await resolveModelRef(project.workspaceId, ref))
        }
        const res = await fetch(`${API_BASE}/api/sheets/${encodeURIComponent(sheetId)}/elements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, elements: elements.map(e => ({ ...e, addedBy: 'agent' })) }),
        })
        if (!res.ok) throw new Error(`add to sheet failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'annotate_sheet': {
        let sheetId: string | undefined
        if (args.sheet) sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        let targetType: string | undefined
        let targetId: string | undefined
        if (args.target) {
          const ref = await resolveModelRef(project.workspaceId, args.target as string)
          if (ref.fileId) { targetType = 'file'; targetId = ref.fileId }
          else if (ref.systemId) { targetType = 'system'; targetId = ref.systemId }
          else if (ref.infraId) { targetType = 'infra'; targetId = ref.infraId }
        }
        const res = await fetch(`${API_BASE}/api/annotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            sheetId,
            targetType, targetId,
            body: args.body,
            author: 'agent',
          }),
        })
        if (!res.ok) throw new Error(`annotate failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'plan_element': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const res = await fetch(`${API_BASE}/api/sheets/${encodeURIComponent(sheetId)}/planned`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            name: args.name,
            kind: args.kind ?? 'class',
            declaredPath: args.declaredPath ?? '',
            members: (args.members as any[] ?? []).map(m => ({ ...m, realized: false })),
            notes: args.notes ?? '',
            shape: args.shape ?? '',
            color: args.color ?? '',
            createdBy: 'agent',
          }),
        })
        if (!res.ok) throw new Error(`plan element failed: ${await res.text()}`)
        const planned = await res.json() as any
        result = {
          ...planned,
          instruction: planned.approvalStatus === 'pending'
            ? 'Await user confirmation on the Axiom canvas. Poll get_plan_status(id) and do not write code until approved.'
            : 'This element is approved.',
        }
        await postAgentActivity(project.workspaceId, `Agent planned element "${args.name}"`, 'success')
        break
      }

      case 'get_plan_status': {
        const res = await fetch(
          `${API_BASE}/api/planned/${encodeURIComponent(args.id as string)}?workspace=${encodeURIComponent(project.workspaceId)}`
        )
        if (!res.ok) throw new Error(`plan status failed: ${await res.text()}`)
        const planned = await res.json() as any
        result = {
          id: planned.id,
          name: planned.name,
          approvalStatus: planned.approvalStatus,
          realizationStatus: planned.status,
          instruction: planned.approvalStatus === 'pending'
            ? 'Still awaiting user confirmation; do not implement yet.'
            : planned.approvalStatus === 'rejected'
              ? 'Proposal rejected; do not implement it.'
              : 'Approved; implementation may proceed.',
        }
        break
      }

      case 'get_build_spec': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const res = await fetch(
          `${API_BASE}/api/sheets/${encodeURIComponent(sheetId)}/buildspec?workspace=${encodeURIComponent(project.workspaceId)}`
        )
        if (!res.ok) throw new Error(`build spec failed: ${await res.text()}`)
        const data = await res.json() as { buildSpec: string }
        result = data.buildSpec
        break
      }

      // ── Canvas → agent channel (UML_UX_PLAN.md U-C) ────────────────────────
      case 'get_canvas_updates': {
        const res = await fetch(
          `${API_BASE}/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=mcp`
        )
        if (!res.ok) throw new Error(`canvas outbox failed: ${await res.text()}`)
        const msgs = await res.json() as any[]
        result = {
          messages: msgs ?? [],
          note: (msgs ?? []).length > 0
            ? 'Reply to each with reply_to_canvas(msgId, body) — the user is waiting on the canvas.'
            : 'No unread canvas messages.',
        }
        break
      }

      case 'await_canvas': {
        const timeoutS = Math.min(Math.max((args.timeoutSeconds as number) ?? 40, 5), 45)
        const deadline = Date.now() + timeoutS * 1000
        let messages: any[] = []
        while (Date.now() < deadline) {
          const res = await fetch(
            `${API_BASE}/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=mcp`
          )
          if (res.ok) {
            messages = await res.json() as any[] ?? []
            if (messages.length > 0) break
          }
          await new Promise(r => setTimeout(r, 2000))
        }
        result = messages.length > 0
          ? { messages, note: 'Reply with reply_to_canvas(msgId, body), then call await_canvas again if still collaborating.' }
          : { timedOut: true, keep_waiting: true, note: 'No canvas message in the window. Call await_canvas again to keep collaborating, or stop if the session is over.' }
        break
      }

      case 'reply_to_canvas': {
        const res = await fetch(`${API_BASE}/api/canvas/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: project.workspaceId,
            msgId: args.msgId,
            body: args.body,
          }),
        })
        if (!res.ok) throw new Error(`reply failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }

    // Every tool lands here, so a tool added later is visible on the canvas
    // and in the log without anyone remembering to instrument it.
    // Logged under the name the AGENT used, not the legacy name it routed to.
    void postAgentAction(
      project.workspaceId, name, callerArgs, result, startedAt, undefined, loggedWorkSession,
    )

    const trailer = await canvasTrailer(project.workspaceId, call)
    return {
      content: [{
        type: 'text',
        text: (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + trailer,
      }],
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // A failed attempt is still something the agent did, and seeing it fail is
    // often the most useful entry in the log.
    if (loggedWorkspaceId) {
      void postAgentAction(
        loggedWorkspaceId, name, callerArgs, undefined, startedAt, msg, loggedWorkSession,
      )
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
      isError: true,
    }
  }
})

// ─── Start ─────────────────────────────────────────────────────────────────

// Renew this MCP process's presence lease for whichever project Axiom has open.
//
// A single announcement at startup only covers one ordering: agent first, then
// project. Start Claude Code before opening the project in Axiom -- which is
// the normal way round, since the editor is already open -- and the server
// announced itself against no project at all, then never spoke again. Axiom sat
// on "waiting for an agent" beside a client that plainly said connected.
//
// Presence itself is a short lease, not an action-log inference. Heartbeats do
// not fill history, and they recover automatically after an Axiom/archd restart
// or workspace database reset while this same agent process stays alive.
let announcedWorkspace: string | null = null

async function renewPresence() {
  let workspaceId: string
  try {
    workspaceId = getActiveProject().workspaceId
  } catch {
    return // No project open yet. Try again on the next tick.
  }
  if (!workspaceId) return
  try {
    const heartbeat = await fetch(`${API_BASE}/api/agent/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        connectionId,
        hostId: agentHostId,
      }),
    })
    if (!heartbeat.ok) return

    const lease = await heartbeat.json() as { newLease?: boolean }

    // Keep one durable event per workspace/process visit so Axiom can also say
    // which harness connected before after the live lease expires. A new lease
    // also means archd restarted or forgot its in-memory presence state, so
    // restore that durable record without writing on every heartbeat.
    if (workspaceId !== announcedWorkspace || lease.newLease) {
      const announcement = await fetch(`${API_BASE}/api/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          cwd: process.cwd(),
          agent: agentHostId,
          tool: 'connect',
          kind: 'session',
          summary: 'Agent connected to Axiom',
          targets: [],
          durationMs: 0,
          status: 'ok',
        }),
      })
      if (!announcement.ok) return
      await postAgentActivity(workspaceId, 'Agent MCP server connected', 'success')
      announcedWorkspace = workspaceId
    }
  } catch {
    // archd may not be up yet; the next tick retries.
  }
}

async function main() {
  void renewPresence()
  const presence = setInterval(() => { void renewPresence() }, 5_000)
  presence.unref?.()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[axiom-mcp] SQLite-over-HTTP MCP server started, ready for queries.')
}

main().catch(console.error)
