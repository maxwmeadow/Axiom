/**
 * MCP tool consolidation.
 *
 * Axiom exposed 59 tools, whose schemas cost roughly 9,600 tokens on EVERY
 * request an agent makes, before it has read a line of code. That is both a
 * context tax and a selection problem: a model choosing between
 * `get_neighbors`, `get_family`, `get_node` and `get_systems_with_files` is
 * choosing between four spellings of one question.
 *
 * The rule applied here:
 *
 *   MERGE when the question is identical and only the selector varies.
 *   SPLIT when the question genuinely differs.
 *
 * So the twelve graph reads become one `get_architecture` with a `scope`,
 * while `search_symbols` and `get_call_path` stay separate - different
 * questions, different mental models, and each schema stays small. A single
 * polymorphic mega-tool would trade a token saving for a worse one, since a
 * giant discriminated union costs more schema than the tools it replaced.
 *
 * Nothing is removed. Every legacy tool still executes; it is simply no longer
 * advertised, so it costs no context. This module is the adapter layer: it
 * rewrites a consolidated call into the legacy call that already works.
 */

export interface RoutedCall {
  tool: string
  args: Record<string, any>
}

/** Reads: one question ("describe this part of the graph"), many selectors. */
const ARCHITECTURE_SCOPES: Record<string, string> = {
  overview: 'get_systems_overview',
  unclassified: 'get_unclassified_files',
  system_files: 'get_system_files',
  systems: 'get_systems_with_files',
  files: 'get_raw_files',
  node: 'get_node',
  neighbors: 'get_neighbors',
  family: 'get_family',
  cross_dependencies: 'get_cross_system_dependencies',
  dependency_graph: 'get_call_graph',
  infra: 'list_infra',
  infra_for_files: 'get_infra_for_files',
  infra_catalog: 'list_infra_services',
  hotspots: 'get_activity_hotspots',
}

/** Architecture curation. Agents keep the map true; that is the product. */
const SYSTEM_OPS: Record<string, string> = {
  propose: 'propose_architecture',
  create: 'create_system',
  update: 'update_system',
  delete: 'delete_system',
  assign: 'assign_files_to_system',
  merge: 'merge_systems',
  bulk: 'update_systems_bulk',
}

const INFRA_OPS: Record<string, string> = {
  create: 'create_infra_node',
  update: 'update_infra_node',
  delete: 'delete_infra_node',
  connect: 'connect_infra',
}

const SHEET_OPS: Record<string, string> = {
  list: 'list_sheets',
  get: 'get_sheet',
  create: 'create_sheet',
  add: 'add_to_sheet',
  annotate: 'annotate_sheet',
}

const RUNTIME_OPS: Record<string, string> = {
  watch: 'watch_function',
  unwatch: 'unwatch_function',
  inject: 'inject_value',
  cancel_inject: 'cancel_injection',
  snapshot: 'get_runtime_snapshot',
  launch: 'launch_target',
  stop: 'stop_target',
  log: 'get_target_log',
}

const INVESTIGATION_OPS: Record<string, string> = {
  start: 'start_investigation',
  note: 'annotate_investigation',
  stop: 'stop_investigation',
  list: 'list_investigations',
  get: 'get_investigation',
}

function opError(tool: string, op: unknown, table: Record<string, string>): Error {
  return new Error(
    `${tool}: unknown op "${String(op)}". Expected one of: ${Object.keys(table).join(', ')}`,
  )
}

/** Drops undefined keys so a legacy handler sees the shape it expects. */
function compact(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Rewrites a consolidated call into the legacy call that implements it.
 * Returns null when the name is not consolidated, so the caller falls through
 * to the existing handler unchanged.
 */
export function routeTool(name: string, args: Record<string, any>): RoutedCall | null {
  switch (name) {
    case 'get_architecture': {
      const scope = (args.scope as string) ?? 'overview'
      const tool = ARCHITECTURE_SCOPES[scope]
      if (!tool) throw opError('get_architecture', scope, ARCHITECTURE_SCOPES)
      // One `id`/`ids` pair on the surface, spread onto whatever each legacy
      // read happens to call it. The agent should not have to know.
      return {
        tool,
        args: compact({
          systemId: args.id,
          id: args.id,
          systemIds: args.ids,
          fileIds: args.ids,
          depth: args.depth,
          descendantDepth: args.depth,
          limit: args.limit,
          minWeight: args.minWeight,
          status: args.status,
        }),
      }
    }

    case 'get_symbols': {
      // Asking for one symbol's body is a different legacy endpoint from
      // listing the symbols in a set of files, but it is the same question.
      if (args.file && args.symbol) {
        return { tool: 'get_function_body', args: compact({ file: args.file, symbol: args.symbol }) }
      }
      return { tool: 'get_symbols_for_files', args: compact({ fileIds: args.fileIds }) }
    }

    case 'trace_calls': {
      if (Array.isArray(args.fileIds) && args.fileIds.length > 0) {
        return {
          tool: 'get_call_graph_for_files',
          args: compact({ fileIds: args.fileIds, direction: args.direction, depth: args.depth }),
        }
      }
      return { tool: 'get_call_path', args: compact({ from: args.from, to: args.to }) }
    }

    case 'edit_systems': {
      const tool = SYSTEM_OPS[args.op as string]
      if (!tool) throw opError('edit_systems', args.op, SYSTEM_OPS)
      const { op, ...rest } = args
      return { tool, args: compact(rest) }
    }

    case 'edit_infra': {
      const tool = INFRA_OPS[args.op as string]
      if (!tool) throw opError('edit_infra', args.op, INFRA_OPS)
      const { op, ...rest } = args
      return { tool, args: compact(rest) }
    }

    case 'edit_sheet': {
      const tool = SHEET_OPS[args.op as string]
      if (!tool) throw opError('edit_sheet', args.op, SHEET_OPS)
      const { op, ...rest } = args
      return { tool, args: compact(rest) }
    }

    case 'get_inbox': {
      // Polling and blocking are the same request with a different patience.
      if (typeof args.waitSeconds === 'number' && args.waitSeconds > 0) {
        return { tool: 'await_canvas', args: { timeoutSeconds: args.waitSeconds } }
      }
      return { tool: 'get_canvas_updates', args: {} }
    }

    case 'get_build_plan': {
      if (args.id) return { tool: 'get_plan_status', args: { id: args.id } }
      return { tool: 'get_build_spec', args: compact({ sheet: args.sheet }) }
    }

    case 'update_work': {
      // Finishing is the last note plus a close, so one tool covers both and
      // an agent cannot forget which lifecycle call it is on.
      if (args.done) {
        return { tool: 'finish_work', args: { summary: args.summary ?? args.note ?? '' } }
      }
      return { tool: 'note_work', args: { text: args.note ?? args.summary ?? '' } }
    }

    case 'debug_runtime': {
      const tool = RUNTIME_OPS[args.op as string]
      if (!tool) throw opError('debug_runtime', args.op, RUNTIME_OPS)
      const { op, ...rest } = args
      return { tool, args: compact(rest) }
    }

    case 'investigation': {
      const tool = INVESTIGATION_OPS[args.op as string]
      if (!tool) throw opError('investigation', args.op, INVESTIGATION_OPS)
      const { op, ...rest } = args
      return { tool, args: compact(rest) }
    }

    default:
      return null
  }
}

/** Every legacy tool a consolidated tool can reach - used to assert coverage. */
export function coveredLegacyTools(): string[] {
  return [
    ...Object.values(ARCHITECTURE_SCOPES),
    ...Object.values(SYSTEM_OPS),
    ...Object.values(INFRA_OPS),
    ...Object.values(SHEET_OPS),
    ...Object.values(RUNTIME_OPS),
    ...Object.values(INVESTIGATION_OPS),
    'get_function_body', 'get_symbols_for_files',
    'get_call_path', 'get_call_graph_for_files',
    'await_canvas', 'get_canvas_updates',
    'get_build_spec', 'get_plan_status',
    'note_work', 'finish_work',
  ]
}

/**
 * Tools that remain their own thing.
 *
 * Each asks a question no other tool asks, so merging them would only grow a
 * discriminated union without removing a decision.
 */
export const STANDALONE_TOOLS = [
  'search_symbols',
  'get_data_flow',
  'plan_element',
  'reply_to_canvas',
  'start_work',
] as const

/** Consolidated tools that only appear when the debug profile is enabled. */
export const DEBUG_TOOLS = ['debug_runtime'] as const
