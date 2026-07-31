/**
 * Agent action classification.
 *
 * Every MCP tool call is logged from one wrapper around the dispatch switch,
 * so a tool added later is captured without anyone remembering to instrument
 * it. This module decides three things about a call:
 *
 *   kind    — how the canvas should react (a read is an attention signal, a
 *             trace animates a path, a write animates the map changing)
 *   targets — which canvas nodes it touched, so the right part lights up
 *   summary — one human line for the visual log
 *
 * It is pure and has no imports, so it can be tested directly.
 */

export type ActionKind = 'read' | 'trace' | 'write' | 'plan' | 'debug' | 'narrate'

const TRACE_TOOLS = new Set([
  'get_call_path', 'get_call_graph', 'get_call_graph_for_files', 'get_data_flow',
])

const WRITE_TOOLS = new Set([
  'create_system', 'update_system', 'delete_system', 'assign_files_to_system',
  'merge_systems', 'update_systems_bulk', 'edit_systems',
  'create_infra_node', 'update_infra_node', 'delete_infra_node', 'connect_infra',
  'edit_infra',
  'create_sheet', 'add_to_sheet', 'annotate_sheet', 'edit_sheet',
])

const PLAN_TOOLS = new Set([
  'plan_element', 'get_plan_status', 'get_build_spec', 'get_build_plan',
  'get_canvas_updates', 'await_canvas', 'reply_to_canvas', 'review-canvas',
  'start_review', 'get_inbox', 'claim_build_plan', 'propose_change',
])

const DEBUG_TOOLS = new Set([
  'watch_function', 'unwatch_function', 'inject_value', 'cancel_injection',
  'get_runtime_snapshot', 'launch_target', 'stop_target', 'get_target_log',
  'debug_runtime',
  'start_investigation', 'annotate_investigation', 'stop_investigation',
  'list_investigations', 'get_investigation', 'investigation',
])

const NARRATE_TOOLS = new Set(['start_work', 'note_work', 'finish_work', 'update_work'])

/** Reads are the default: a tool that does not declare otherwise only looks. */
export function actionKind(tool: string): ActionKind {
  if (TRACE_TOOLS.has(tool)) return 'trace'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (PLAN_TOOLS.has(tool)) return 'plan'
  if (DEBUG_TOOLS.has(tool)) return 'debug'
  if (NARRATE_TOOLS.has(tool)) return 'narrate'
  return 'read'
}

/** Argument keys that carry a canvas node identity, in priority order. */
const ID_KEYS = [
  // Consolidated surface: get_architecture and friends take a generic id/ids.
  // Missing these is why a read once lit nothing on the canvas.
  'id', 'ids',
  'fileId', 'fileIds', 'systemId', 'systemIds', 'nodeId', 'nodeIds',
  'infraId', 'targetId', 'sourceId', 'from', 'to', 'src', 'dst',
  'focusSystemIds', 'focusFileIds',
]

function pushIds(into: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value) into.add(value)
  else if (Array.isArray(value)) for (const entry of value) pushIds(into, entry)
}

/**
 * The canvas nodes an action touched.
 *
 * Arguments are the honest source: they are what the agent asked about. The
 * result is also mined for call-path hops, because the interesting part of a
 * trace is the path it found, not the two endpoints it was given.
 */
export function actionTargets(
  tool: string,
  args: Record<string, unknown>,
  result?: unknown,
): string[] {
  const targets = new Set<string>()
  for (const key of ID_KEYS) {
    if (key in args) pushIds(targets, args[key])
  }

  // A traced path is only worth animating if we know every hop it went through.
  const steps = (result as { steps?: unknown[] } | undefined)?.steps
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const hop = step as Record<string, unknown>
      pushIds(targets, hop.callerFile)
      pushIds(targets, hop.calleeFile)
    }
  }
  const fileIds = (result as { fileIds?: unknown } | undefined)?.fileIds
  if (fileIds) pushIds(targets, fileIds)

  return [...targets]
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * One line for the visual log, written the way you would describe it out loud.
 * Falls back to the tool name rather than inventing detail it does not have.
 */
export function actionSummary(tool: string, args: Record<string, unknown>): string {
  const subject = firstString(args, ['name', 'goal', 'symbol', 'variable', 'query', 'text', 'summary'])
  switch (tool) {
    case 'get_call_path':
      return `Traced ${firstString(args, ['from'])} → ${firstString(args, ['to'])}`
    case 'get_data_flow':
      return `Followed data flow of ${subject}`
    case 'search_symbols':
      return `Searched symbols for "${subject}"`
    case 'create_system':
      return `Created system ${subject}`
    case 'update_system':
      return `Updated system ${subject || firstString(args, ['systemId'])}`
    case 'delete_system':
      return `Deleted a system`
    case 'merge_systems':
      return `Merged systems into ${subject}`
    case 'assign_files_to_system':
      return `Reassigned files to ${subject || firstString(args, ['systemId'])}`
    case 'update_systems_bulk':
      return `Bulk-updated systems`
    case 'plan_element':
      return `Planned ${subject}`
    case 'start_work':
      return `Started work: ${subject}`
    case 'note_work':
    case 'finish_work':
      return subject
    case 'watch_function':
      return `Watching ${subject}`
    case 'inject_value':
      return `Injected a value into ${subject}`
    default:
      return tool.replace(/_/g, ' ')
  }
}
