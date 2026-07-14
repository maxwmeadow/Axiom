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
import fs from 'fs'

// Helper: UUID generator for system nodes
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Helper: Retrieve the active project metadata
interface ActiveProject {
  workspaceId: string
  name: string
  rootPath: string
}

function getActiveProject(): ActiveProject {
  const activeProjectPath = join(homedir(), '.axiom', 'data', 'active_project.json')
  if (!fs.existsSync(activeProjectPath)) {
    throw new Error('No active project found. Please open a project in the Axiom desktop application.')
  }
  return JSON.parse(fs.readFileSync(activeProjectPath, 'utf8')) as ActiveProject
}

// Helper: Secure read-only SQL execution via Go daemon query gateway
async function queryDb(workspaceId: string, sql: string, params: any[] = []): Promise<any[]> {
  const res = await fetch('http://localhost:7743/api/query', {
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
    await fetch('http://localhost:7743/api/agent/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message, level }),
    })
  } catch (err) {
    console.error('[axiom-mcp] failed to post agent activity:', err)
  }
}

// Helper: resolve a sheet by ID or exact name.
async function resolveSheetId(workspaceId: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return ref
  const res = await fetch(`http://localhost:7743/api/sheets?workspace=${encodeURIComponent(workspaceId)}`)
  if (!res.ok) throw new Error(`sheets list failed: ${await res.text()}`)
  const sheets = await res.json() as { id: string; name: string }[]
  const hit = (sheets ?? []).find(s => s.name === ref) ?? (sheets ?? []).find(s => s.name.toLowerCase() === ref.toLowerCase())
  if (!hit) throw new Error(`Sheet not found: ${ref}. Existing: ${(sheets ?? []).map(s => s.name).join(', ') || '(none)'}`)
  return hit.id
}

// Helper: resolve a model ref (file rel path / system name / infra name / UUID)
// to exactly one of {fileId|systemId|infraId} for sheet membership.
async function resolveModelRef(workspaceId: string, ref: string): Promise<{ fileId?: string; systemId?: string; infraId?: string }> {
  const norm = ref.replace(/\\/g, '/').replace(/^(file|sys|infra):\/\//, '')
  // Files: exact rel path, then unique suffix.
  const fileRows = await queryDb(workspaceId, `
    SELECT f.id FROM files f JOIN roots r ON f.root_id = r.id
    WHERE r.workspace_id = ? AND (f.id = ? OR f.rel_path = ? OR f.rel_path LIKE ?)
    LIMIT 2`, [workspaceId, ref, norm, `%/${norm.split('/').pop()}`])
  if (fileRows.length === 1) return { fileId: fileRows[0].id }
  if (fileRows.length > 1) {
    const exact = await queryDb(workspaceId, `
      SELECT f.id FROM files f JOIN roots r ON f.root_id = r.id
      WHERE r.workspace_id = ? AND f.rel_path = ? LIMIT 1`, [workspaceId, norm])
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
      `http://localhost:7743/api/canvas/outbox?workspace=${encodeURIComponent(workspaceId)}&peek=1`
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
  ],
}))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== 'review-canvas') {
    throw new Error(`Unknown prompt: ${request.params.name}`)
  }
  const project = getActiveProject()
  const res = await fetch(
    `http://localhost:7743/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=prompt`
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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_systems_overview',
      description: 'Get a high-level overview of all systems, subsystems, descriptions, and file counts in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_unclassified_files',
      description: 'Get a list of files that have not yet been grouped or assigned into any system.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_system_files',
      description: 'Get a list of files assigned to a specific system ID.',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'System Node ID (UUID)' },
        },
        required: ['systemId'],
      },
    },
    {
      name: 'get_raw_files',
      description: 'Get a list of all indexed files, their relative paths, languages, and assigned systems.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_call_graph',
      description: 'Get the file-level import and call graph for dependency analysis.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'search_symbols',
      description: 'Search across all code symbol definitions (functions, classes, interfaces, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Fuzzy symbol name' },
          limit: { type: 'number', description: 'Max results', default: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_node',
      description: 'Retrieve full metadata for any node (system, file, or infra) by its ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node ID (UUID)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_neighbors',
      description: 'Retrieve nodes and dependencies within N hops of a focused node ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Focus Node ID (UUID)' },
          depth: { type: 'number', description: 'Hop depth', default: 2 },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_system',
      description: 'Create a named system on the Axiom canvas. Systems contain related files or other subsystems.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'System name (e.g. "Auth System", "Routing Engine")' },
          description: { type: 'string', description: 'Description of what this system handles' },
          parentId: { type: 'string', description: 'Optional ID of a parent system to nest under' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_system',
      description: 'Update the properties of a system node: name, parentId (nesting), or description.',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'System ID (UUID) to modify' },
          name: { type: 'string', description: 'New system name' },
          description: { type: 'string', description: 'New system description' },
          parentId: { type: 'string', description: 'New parent system ID (pass null or empty string to un-nest)' },
        },
        required: ['systemId'],
      },
    },
    {
      name: 'delete_system',
      description: 'Delete a system node from the workspace canvas. Child subsystems and files will be unclassified (parent set to NULL).',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'System ID (UUID) to delete' },
        },
        required: ['systemId'],
      },
    },
    {
      name: 'assign_files_to_system',
      description: 'Assign or move files into a system. Sets the parent system grouping for the files. Reassigns files regardless of current assignment - use this to move misclassified files between existing systems.',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'Target system ID (UUID)' },
          fileIds: { type: 'array', items: { type: 'string' }, description: 'Array of file IDs (UUIDs) to assign' },
          filePaths: { type: 'array', items: { type: 'string' }, description: 'Alternative: Array of file relative or absolute paths' },
        },
        required: ['systemId'],
      },
    },
    {
      name: 'merge_systems',
      description: 'Merge all contents of a source system (files + subsystems) into a target system and delete the source system.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceSystemId: { type: 'string', description: 'System ID (UUID) to merge FROM' },
          targetSystemId: { type: 'string', description: 'System ID (UUID) to merge INTO' },
        },
        required: ['sourceSystemId', 'targetSystemId'],
      },
    },
    {
      name: 'get_systems_with_files',
      description: 'Get metadata and assigned files for multiple system IDs at once. Very efficient for bulk auditing.',
      inputSchema: {
        type: 'object',
        properties: {
          systemIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of system IDs (UUIDs)'
          }
        },
        required: ['systemIds'],
      },
    },
    {
      name: 'update_systems_bulk',
      description: 'Batch update metadata (name, description, parentId) for multiple systems at once.',
      inputSchema: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                systemId: { type: 'string', description: 'System ID (UUID) to modify' },
                name: { type: 'string', description: 'New system name' },
                description: { type: 'string', description: 'New system description' },
                parentId: { type: 'string', description: 'New parent system ID (pass null or empty string to un-nest)' }
              },
              required: ['systemId']
            }
          }
        },
        required: ['updates'],
      },
    },
    {
      name: 'get_cross_system_dependencies',
      description: 'Retrieve a list of file-to-file dependencies that cross system boundaries (source and target belong to different systems), formatted as a compact markdown table.',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'Optional: Filter dependencies where either the source or target file belongs to this system ID' },
          minWeight: { type: 'number', description: 'Optional: Minimum dependency weight/call-count (default: 1)' },
          limit: { type: 'number', description: 'Optional: Maximum number of dependencies to return to prevent context overflow (default: 100)' }
        }
      },
    },
    {
      name: 'get_family',
      description: 'Retrieve a system, all its ancestors, and descendants with their files in one tree. Scoped by depth.',
      inputSchema: {
        type: 'object',
        properties: {
          systemId: { type: 'string', description: 'System ID (UUID)' },
          descendantDepth: { type: 'number', description: 'Optional: Max depth limit for descendant systems (default: unlimited)' }
        },
        required: ['systemId'],
      },
    },
    {
      name: 'get_call_graph_for_files',
      description: 'Scoped call graph to trace imports and calls only for specific file IDs, with depth and direction filters.',
      inputSchema: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: 'Array of file IDs (UUIDs)' },
          direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Direction of dependencies to traverse (default: both)' },
          depth: { type: 'number', description: 'Graph traversal depth limit (default: 1)' }
        },
        required: ['fileIds'],
      },
    },
    {
      name: 'get_symbols_for_files',
      description: 'Retrieve lists of symbol definitions (classes, functions, etc.) for a set of files to inspect their contents without viewing the full source code.',
      inputSchema: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: 'Array of file IDs (UUIDs)' }
        },
        required: ['fileIds'],
      },
    },
    {
      name: 'start_review',
      description: 'Start the architecture baseline review process. Returns the initial review instructions, rules, and steps for the agent.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'watch_function',
      description: 'Place a live watch on a function. Every future call streams to the Axiom canvas in real-time (node pulses, call count badge, last args/return values). Requires a running target process with the Axiom adapter — use launch_target to start one. Auto-disables above 100 calls/sec.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File ID (UUID), relative path, or path suffix' },
          symbol: { type: 'string', description: 'Function or method name to watch' },
        },
        required: ['file', 'symbol'],
      },
    },
    {
      name: 'unwatch_function',
      description: 'Remove a live function watch and stop streaming its calls.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File ID (UUID), relative path, or path suffix' },
          symbol: { type: 'string', description: 'Function or method name to unwatch' },
        },
        required: ['file', 'symbol'],
      },
    },
    {
      name: 'inject_value',
      description: 'Perturbation: override one parameter of a function on its NEXT call (one-shot by default), then observe whether downstream behavior changes — the canvas colors the perturbed path green (clean return) or red (exception). SAFETY: requires user confirmation on the canvas before arming; only primitives or flat lists/dicts can be injected; the target process must be running with the Axiom adapter. Returns pending_confirm — poll get_runtime_snapshot for armed → fired status and the observed original/injected values.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File ID (UUID), relative path, or path suffix' },
          symbol: { type: 'string', description: 'Function or method name to perturb' },
          param_name: { type: 'string', description: 'Name of the parameter to override' },
          value: { description: 'Value to inject: number, string, boolean, null, or a flat array/object of those' },
          once: { type: 'boolean', description: 'Fire once then auto-remove (default true). Persistent injection requires explicit false.', default: true },
        },
        required: ['file', 'symbol', 'param_name', 'value'],
      },
    },
    {
      name: 'cancel_injection',
      description: 'Cancel an armed or pending value injection before it fires.',
      inputSchema: {
        type: 'object',
        properties: {
          injectId: { type: 'string', description: 'Injection ID returned by inject_value' },
        },
        required: ['injectId'],
      },
    },
    {
      name: 'get_runtime_snapshot',
      description: 'Get the current runtime debugging state: connected target processes, active function watches (with call counts and last seen argument/return values), launched targets, and the most recent runtime events.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'launch_target',
      description: 'Launch the user\'s application under Axiom with runtime tracing attached (zero code changes). Python 3.12+ streams calls with near-zero overhead via sys.monitoring. Node.js (auto-detected from `node`/`.js`/`.mjs`/`.cjs`) is AST-instrumented at module load — exact call/return/exception events with args, works for CJS and ESM including non-exported functions, and supports inject_value. Go (delve) and C#/.NET (netcoredbg) are traced via DAP — NOTE: the debugger stops the whole process on every breakpoint hit, so these are inspection-mode only (call events with args, no return events); Go auto-detected from `go run`/`.go`, C# from a `.dll` or `dotnet app.dll` (keep watches to low-frequency synchronous methods; requires a prebuilt .dll with .pdb). Pass language ("go"/"csharp") for prebuilt binaries. stdout/stderr stream to the canvas (Python/Node; retrievable via get_target_log).',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' }, description: 'Command as argv array, e.g. ["python", "app.py"], ["node", "app.js"], ["go", "run", "."], or ["dotnet", "app.dll"]' },
          cwd: { type: 'string', description: 'Working directory (defaults to the workspace root)' },
          language: { type: 'string', enum: ['python', 'javascript', 'go', 'csharp', 'cpp', 'ruby', 'java'], description: 'Optional language hint. Needed to trace a prebuilt Go/C# binary, a C++ executable (gdb — build with -g, static-link on MinGW), Ruby (rdbg), or Java (java-debug). C++/Ruby/Java use blocking DAP: keep watches to low-frequency functions.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'stop_target',
      description: 'Stop a target process previously started with launch_target.',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Target ID returned by launch_target' },
        },
        required: ['targetId'],
      },
    },
    {
      name: 'get_target_log',
      description: 'Get the recent stdout/stderr output of a target process started with launch_target.',
      inputSchema: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: 'Target ID returned by launch_target' },
        },
        required: ['targetId'],
      },
    },
    {
      name: 'get_data_flow',
      description: 'Variable references / data-flow slice: every file and line where a variable is defined, passed as a parameter, written (reassigned/mutated), or read. Highlights the affected files on the Axiom canvas in purple. Static analysis (tree-sitter) — cross-file matches are NAME-BASED (no type resolution), so same-named variables in unrelated files may appear; pass `file` to scope to one file, and use each ref\'s enclosingSymbol to disambiguate. Supports TS/JS/Python/Go.',
      inputSchema: {
        type: 'object',
        properties: {
          variable: { type: 'string', description: 'Variable name to slice on' },
          file: { type: 'string', description: 'Optional: scope to a single file (ID, relative path, or path suffix) — strongly recommended for common names' },
          maxFiles: { type: 'number', description: 'Max files to return (default 50)' },
        },
        required: ['variable'],
      },
    },
    {
      name: 'start_investigation',
      description: 'Begin capturing an Investigation: from now on every call path traced, function watched, runtime call/return/exception observed, value injected, data-flow slice, and note is recorded into an ordered, replayable timeline linked to the current git commit. Use this at the start of a debugging session so the whole investigation can be saved and shared. Call stop_investigation to save it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable name, e.g. "negative amount bypasses validation"' },
        },
      },
    },
    {
      name: 'annotate_investigation',
      description: 'Add a note to the active investigation timeline — your hypothesis, a finding, or a conclusion. Notes appear inline in the replay so a teammate follows your reasoning. Requires an active investigation (start_investigation).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note / finding / hypothesis to record at this point in the timeline' },
        },
        required: ['text'],
      },
    },
    {
      name: 'stop_investigation',
      description: 'Finalize and save the active investigation. Returns a short shareable id; opening it on the Axiom canvas replays the entire investigation step by step (traces, values, perturbations, notes) against the captured git commit.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_investigations',
      description: 'List saved investigations for the current workspace (id, name, commit, event count, duration), plus the one currently recording if any.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_investigation',
      description: 'Get the full recorded timeline of a saved investigation by id (all captured events with their relative timestamps, the git commit, and the canvas snapshot). Use to inspect or replay a past investigation.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Investigation id from stop_investigation / list_investigations' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_function_body',
      description: 'Read the actual source code of a specific function, class, or method from the indexed symbol table. Use this after tracing a call path to inspect what each hop really does — no runtime required.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File ID (UUID), relative path, or path suffix (e.g. "services/payment.py")' },
          symbol: { type: 'string', description: 'Function/class/method name as it appears in the symbol table' },
        },
        required: ['file', 'symbol'],
      },
    },
    {
      name: 'get_call_path',
      description: 'Trace the function call path between two files (by file ID or relative path). Returns each hop (caller symbol → callee symbol) and automatically animates the path on the Axiom canvas so the user can follow the agent\'s debugging path in real-time.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting file ID (UUID) or relative path' },
          to:   { type: 'string', description: 'Target file ID (UUID) or relative path' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'list_infra_services',
      description: 'List the infra service registry: every external-infrastructure service Axiom can render (aws/rds, openai/api, stripe/api, generic/database, ...), grouped with its category and the edge kinds legal for that category. Call this before create_infra_node to pick a valid service id.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_infra',
      description: 'List all infra nodes (databases, queues, external APIs, platforms) in the workspace with their categories, providers, statuses, and connection edges.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['proposed', 'confirmed', 'dismissed'], description: 'Optional: filter by proposal status' },
        },
      },
    },
    {
      name: 'create_infra_node',
      description: 'Create an infra node on the canvas representing an external dependency (database, cache, queue, storage, LLM API, SaaS API, auth, platform, CDN, monitoring, email). Prefer passing a registry `service` id (see list_infra_services) so the node gets correct branding and edge semantics; pass only `category` for an unbranded generic node the user can assign later.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Registry service id, e.g. "postgresql/postgres", "aws/s3", "openai/api". Category/provider/branding derive from it.' },
          name: { type: 'string', description: 'Display name, e.g. "Primary DB", "Payments API". Defaults to the service name.' },
          category: { type: 'string', description: 'Only when no service is given: database|cache|queue|storage|search|llm|api|auth|platform|cdn|observability|email' },
          subtype: { type: 'string', description: 'Optional category subtype, e.g. sql|document|kv|vector for databases' },
          config: { type: 'object', description: 'Optional config values for the service\'s configFields (never put secrets here)' },
        },
      },
    },
    {
      name: 'update_infra_node',
      description: 'Update an infra node: rename, reskin to a different service (e.g. generic/database → aws/rds once the actual DB is known), change status (confirm/dismiss a proposal), or edit config.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Infra node ID (UUID)' },
          name: { type: 'string' },
          service: { type: 'string', description: 'New registry service id — re-derives category, provider, and branding' },
          status: { type: 'string', enum: ['proposed', 'confirmed', 'dismissed'] },
          config: { type: 'object' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_infra_node',
      description: 'Delete an infra node from the canvas. Its connection edges are removed automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Infra node ID (UUID)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'connect_infra',
      description: 'Connect a file or system to an infra node with a semantically typed edge. The edge kind must be legal for the node\'s category: database READS|WRITES|MIGRATES, cache READS|WRITES, queue PUBLISHES|CONSUMES, storage READS|WRITES, search QUERIES|INDEXES, llm/api CALLS (api also HANDLES_WEBHOOK), auth AUTHENTICATES_VIA, platform DEPLOYS_TO, cdn SERVES_VIA, observability REPORTS_TO, email SENDS_VIA.',
      inputSchema: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Source file ID/relative path, or system ID' },
          srcType: { type: 'string', enum: ['file', 'system'], description: 'What src refers to', default: 'file' },
          infraId: { type: 'string', description: 'Target infra node ID (UUID)' },
          kind: { type: 'string', description: 'Edge kind (see description for legal kinds per category)' },
          evidence: { type: 'string', description: 'Optional file:line justifying the connection, e.g. "src/db.ts:14"' },
        },
        required: ['src', 'infraId', 'kind'],
      },
    },
    {
      name: 'get_activity_hotspots',
      description: 'List the files with the most recent live edit activity, ranked by a time-decayed score (24h half-life) weighted by structural change (symbols added/removed/moved). This is where the codebase is changing RIGHT NOW — the highest-value places to look for fresh bugs, regressions, or in-flight work. Tracks live saves (human and agent), not git commits.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max files to return', default: 20 },
        },
      },
    },
    {
      name: 'list_sheets',
      description: 'List all Sheets (named, curated UML-style diagrams over the live code model) with their names, purposes, kinds, and revisions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_sheet',
      description: 'Read a Sheet as ASM text (Axiom Sheet Markup) — the agent-facing rendering: members as durable URIs (file://relpath, sys://name, infra://service), containment by indentation, notes inline, tombstones/ghosts as bracket tags. This is how you SEE a diagram.',
      inputSchema: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet ID or exact sheet name' },
        },
        required: ['sheet'],
      },
    },
    {
      name: 'create_sheet',
      description: 'Create a Sheet — a curated diagram telling one story about the codebase (e.g. "Payment flow"). Pass member refs (file relative paths, system names, or infra node names/ids); elements are live references, never copies. Use this to ANSWER architecture questions visually: build the sheet, then direct the user to it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sheet title, e.g. "Checkout flow"' },
          purpose: { type: 'string', description: 'One line: what story this sheet tells' },
          members: { type: 'array', items: { type: 'string' }, description: 'Refs: file relative paths, system names, infra names, or UUIDs' },
        },
        required: ['name'],
      },
    },
    {
      name: 'add_to_sheet',
      description: 'Add elements to an existing sheet by ref (file relative path, system name, infra name, or UUID).',
      inputSchema: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet ID or name' },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['sheet', 'members'],
      },
    },
    {
      name: 'annotate_sheet',
      description: 'Attach a note to a sheet, optionally pinned to a specific element (file/system/infra ref). Agent notes render amber on the canvas so the user sees who wrote what. Use for explanations, warnings ("this path bypasses validation"), and decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet ID or name (omit for a workspace-global note)' },
          target: { type: 'string', description: 'Optional element ref to pin to (file path / system name / infra name)' },
          body: { type: 'string', description: 'Markdown note body' },
        },
        required: ['body'],
      },
    },
    {
      name: 'plan_element',
      description: 'Add a PLANNED element to a sheet — a UML box for code that does not exist yet (visual spec-driven development). Declare the path where it should live and its member function signatures; Axiom reconciles automatically as the code gets built and the user watches members turn green on the canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet ID or name' },
          name: { type: 'string', description: 'Element name, e.g. "AuthService"' },
          kind: { type: 'string', enum: ['class', 'file', 'system'], default: 'class' },
          declaredPath: { type: 'string', description: 'Relative path where this should be created, e.g. "src/services/auth.ts"' },
          members: { type: 'array', items: { type: 'object', properties: { signature: { type: 'string' }, intent: { type: 'string' } }, required: ['signature'] }, description: 'Declared functions/methods' },
          notes: { type: 'string', description: 'One-line intent for the element' },
          shape: { type: 'string', enum: ['box', 'folder', 'cylinder', 'hexagon'], description: 'Semantic shape: box=class/file, folder=system/package, cylinder=data store, hexagon=service/API. Defaults by kind.' },
          color: { type: 'string', description: 'Accent hex from the drafting palette, e.g. "#5B8A9A"' },
        },
        required: ['sheet', 'name'],
      },
    },
    {
      name: 'get_build_spec',
      description: 'Render a sheet\'s planned (not yet built) elements as a build specification: target paths, member signature checklists ([x] = already realized), structural intent edges. Use this as your work order when the user asks you to BUILD what they designed on the canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          sheet: { type: 'string', description: 'Sheet ID or name' },
        },
        required: ['sheet'],
      },
    },
    {
      name: 'get_canvas_updates',
      description: 'Drain unread canvas messages from the user: notes composed on the Axiom canvas, with their selection refs and a semantic summary of canvas changes the user staged (moves, groupings, drawn edges). CALL THIS whenever a tool response carries the ⚑ unread-canvas-message trailer, and reply with reply_to_canvas.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'await_canvas',
      description: 'Canvas collaboration mode: block until the user sends a message from the canvas (or the window times out). Returns {messages} or {timedOut: true, keep_waiting: true} — when keep_waiting is true and you are still collaborating, call await_canvas again. Use when the user says they will drive from the canvas.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutSeconds: { type: 'number', description: 'Max wait, 5–45s', default: 40 },
        },
      },
    },
    {
      name: 'reply_to_canvas',
      description: 'Answer a canvas message. The reply renders on the canvas as an agent note threaded to the user\'s message (their note chip flips to "answered"). Always reply — the user is waiting on the canvas, not reading this chat.',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: { type: 'string', description: 'Canvas message ID (from get_canvas_updates / await_canvas)' },
          body: { type: 'string', description: 'Markdown reply' },
        },
        required: ['msgId', 'body'],
      },
    },
    {
      name: 'get_infra_for_files',
      description: 'For a set of files, list which infra nodes they touch and via which edge kinds — e.g. "which files write to the production DB?" in reverse.',
      inputSchema: {
        type: 'object',
        properties: {
          fileIds: { type: 'array', items: { type: 'string' }, description: 'File IDs (UUIDs) or relative paths' },
        },
        required: ['fileIds'],
      },
    },
  ],
}))

// ─── Tool execution ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params
  const args = rawArgs as Record<string, any> ?? {}

  try {
    const project = getActiveProject()
    let result: unknown

    switch (name) {
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
      case 'create_system': {
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
        const res = await fetch('http://localhost:7743/api/systems', {
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
        const res = await fetch(`http://localhost:7743/api/systems/${sysId}`, {
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
        const res = await fetch(`http://localhost:7743/api/systems/${sysId}?workspace=${project.workspaceId}`, {
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
          const res = await fetch(`http://localhost:7743/api/files/${fileId}/assign`, {
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
          const res = await fetch(`http://localhost:7743/api/files/${file.id}/assign`, {
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
          const res = await fetch(`http://localhost:7743/api/systems/${sys.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!res.ok) throw new Error(`Failed to reassign subsystem ${sys.id}: ${await res.text()}`)
        }
        
        // 3. Delete the source system
        const res = await fetch(`http://localhost:7743/api/systems/${sourceId}?workspace=${project.workspaceId}`, {
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
            
            const res = await fetch(`http://localhost:7743/api/systems/${u.systemId}`, {
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
        const res = await fetch('http://localhost:7743/api/runtime/watch', {
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
        const res = await fetch('http://localhost:7743/api/runtime/unwatch', {
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
        const res = await fetch('http://localhost:7743/api/runtime/inject', {
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
        const res = await fetch('http://localhost:7743/api/runtime/inject/cancel', {
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
          `http://localhost:7743/api/runtime/snapshot?workspace=${encodeURIComponent(project.workspaceId)}`
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
        const res = await fetch('http://localhost:7743/api/runtime/launch', {
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
        const res = await fetch('http://localhost:7743/api/runtime/stop', {
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
          `http://localhost:7743/api/runtime/target-log?target=${encodeURIComponent(targetId)}`
        )
        if (!res.ok) throw new Error(`target-log failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'start_investigation': {
        const name = (args.name as string) ?? ''
        const res = await fetch('http://localhost:7743/api/investigation/start', {
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
        const res = await fetch('http://localhost:7743/api/investigation/note', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId, text }),
        })
        if (!res.ok) throw new Error(`annotate_investigation failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `📝 ${text}`, 'info')
        break
      }

      case 'stop_investigation': {
        const res = await fetch('http://localhost:7743/api/investigation/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: project.workspaceId }),
        })
        if (!res.ok) throw new Error(`stop_investigation failed: ${await res.text()}`)
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent saved investigation ${(result as any).id}`, 'success')
        break
      }

      case 'list_investigations': {
        const res = await fetch(`http://localhost:7743/api/investigation/list?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`list_investigations failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_investigation': {
        const id = args.id as string
        const res = await fetch(`http://localhost:7743/api/investigation/${encodeURIComponent(id)}?workspace=${encodeURIComponent(project.workspaceId)}`)
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
        const res = await fetch(`http://localhost:7743/api/data-flow?${params.toString()}`)
        if (!res.ok) throw new Error(`data-flow failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_function_body': {
        const file = args.file as string
        const symbol = args.symbol as string
        await postAgentActivity(project.workspaceId, `Agent reading function body: ${symbol} in ${file}`, 'info')
        const res = await fetch(
          `http://localhost:7743/api/function-body?workspace=${encodeURIComponent(project.workspaceId)}&file=${encodeURIComponent(file)}&symbol=${encodeURIComponent(symbol)}`
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
          `http://localhost:7743/api/call-path?workspace=${encodeURIComponent(project.workspaceId)}&from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`
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
        const res = await fetch('http://localhost:7743/api/registry/services')
        if (!res.ok) throw new Error(`registry fetch failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'list_infra': {
        await postAgentActivity(project.workspaceId, 'Agent listed infra nodes', 'info')
        const res = await fetch(`http://localhost:7743/api/infra?workspace=${encodeURIComponent(project.workspaceId)}`)
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
        const res = await fetch('http://localhost:7743/api/infra', {
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
        const res = await fetch(`http://localhost:7743/api/infra/${encodeURIComponent(args.id as string)}`, {
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
          `http://localhost:7743/api/infra/${encodeURIComponent(args.id as string)}?workspace=${encodeURIComponent(project.workspaceId)}`,
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
        const res = await fetch('http://localhost:7743/api/infra/connect', {
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
          `http://localhost:7743/api/activity/hotspots?workspace=${encodeURIComponent(project.workspaceId)}&limit=${limit}`
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
        const res = await fetch(`http://localhost:7743/api/sheets?workspace=${encodeURIComponent(project.workspaceId)}`)
        if (!res.ok) throw new Error(`sheets list failed: ${await res.text()}`)
        result = await res.json()
        break
      }

      case 'get_sheet': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const res = await fetch(
          `http://localhost:7743/api/sheets/${encodeURIComponent(sheetId)}/asm?workspace=${encodeURIComponent(project.workspaceId)}`
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
        const res = await fetch('http://localhost:7743/api/sheets', {
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
        const res = await fetch(`http://localhost:7743/api/sheets/${encodeURIComponent(sheetId)}/elements`, {
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
        const res = await fetch('http://localhost:7743/api/annotations', {
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
        const res = await fetch(`http://localhost:7743/api/sheets/${encodeURIComponent(sheetId)}/planned`, {
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
        result = await res.json()
        await postAgentActivity(project.workspaceId, `Agent planned element "${args.name}"`, 'success')
        break
      }

      case 'get_build_spec': {
        const sheetId = await resolveSheetId(project.workspaceId, args.sheet as string)
        const res = await fetch(
          `http://localhost:7743/api/sheets/${encodeURIComponent(sheetId)}/buildspec?workspace=${encodeURIComponent(project.workspaceId)}`
        )
        if (!res.ok) throw new Error(`build spec failed: ${await res.text()}`)
        const data = await res.json() as { buildSpec: string }
        result = data.buildSpec
        break
      }

      // ── Canvas → agent channel (UML_UX_PLAN.md U-C) ────────────────────────
      case 'get_canvas_updates': {
        const res = await fetch(
          `http://localhost:7743/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=mcp`
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
            `http://localhost:7743/api/canvas/outbox?workspace=${encodeURIComponent(project.workspaceId)}&agent=mcp`
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
        const res = await fetch('http://localhost:7743/api/canvas/reply', {
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

    const trailer = await canvasTrailer(project.workspaceId, name)
    return {
      content: [{
        type: 'text',
        text: (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + trailer,
      }],
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
      isError: true,
    }
  }
})

// ─── Start ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    const project = getActiveProject()
    await postAgentActivity(project.workspaceId, 'Agent MCP server connected', 'success')
  } catch (err) {
    console.error('[axiom-mcp] startup notification failed:', err)
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[axiom-mcp] SQLite-over-HTTP MCP server started, ready for queries.')
}

main().catch(console.error)
