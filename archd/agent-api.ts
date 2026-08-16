import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import crypto from 'crypto'
import type { GraphStore } from './graph-store'
import type { WsHub } from './ws-server'
import type {
  GqpQueryRequest,
  GqpTraceRequest,
  MutationIntent,
  AgentActivity,
  AsmNode,
  AsmDependency,
  Layer,
} from '../src/shared/types'

// Rough token estimator (4 chars ≈ 1 token)
function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4)
}

// SSE clients waiting for mutation intents
const mutationSubscribers = new Set<(intent: MutationIntent) => void>()

export function pushMutationIntent(intent: MutationIntent): void {
  for (const sub of mutationSubscribers) sub(intent)
}

export function createAgentApi(getStore: () => GraphStore, hub: WsHub) {
  const app = new Hono()

  // ─── CORS ──────────────────────────────────────────────────────────────
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type')
    if (c.req.method === 'OPTIONS') return c.text('', 200)
    return next()
  })

  // ─── Health ────────────────────────────────────────────────────────────
  app.get('/health', (c) => {
    const store = getStore()
    const stats = store.getStats()
    return c.json({ status: 'ok', ...stats, wsClients: hub.connectionCount })
  })

  // ─── GET /nodes/:id ────────────────────────────────────────────────────
  app.get('/nodes/:id', (c) => {
    const store = getStore()
    const node = store.getNode(c.req.param('id'))
    if (!node) return c.json({ error: 'not found' }, 404)
    return c.json(node)
  })

  // ─── GET /nodes/:id/neighbors ─────────────────────────────────────────
  app.get('/nodes/:id/neighbors', (c) => {
    const store = getStore()
    const depth = parseInt(c.req.query('depth') ?? '2', 10)
    const result = store.getNeighbors(c.req.param('id'), depth)
    const tokens = estimateTokens(result)
    notifyAgentActivity(hub, 'get_neighbors', c.req.param('id'), result.nodes.map(n => n.id), tokens)
    return c.json({ ...result, estimatedTokens: tokens })
  })

  // ─── GET /nodes/:id/ancestors ─────────────────────────────────────────
  app.get('/nodes/:id/ancestors', (c) => {
    const store = getStore()
    const nodeId = c.req.param('id')
    const node = store.getNode(nodeId)
    if (!node) return c.json({ error: 'not found' }, 404)

    const ancestors: AsmNode[] = []
    let current = node
    while (current.parentId) {
      const parent = store.getNode(current.parentId)
      if (!parent) break
      ancestors.push(parent)
      current = parent
    }
    return c.json({ nodes: ancestors })
  })

  // ─── GET /nodes/:id/descendants ───────────────────────────────────────
  app.get('/nodes/:id/descendants', (c) => {
    const store = getStore()
    const nodeId = c.req.param('id')
    const descendants: AsmNode[] = []
    const queue = [nodeId]
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = store.getNodesByParent(current)
      descendants.push(...children)
      queue.push(...children.map(n => n.id))
    }
    return c.json({ nodes: descendants })
  })

  // ─── GET /paths ────────────────────────────────────────────────────────
  app.get('/paths', (c) => {
    const store = getStore()
    const from = c.req.query('from')
    const to = c.req.query('to')
    if (!from || !to) return c.json({ error: 'from and to are required' }, 400)

    // BFS pathfinding
    const paths: string[][] = []
    const visited = new Set<string>()
    const queue: string[][] = [[from]]

    while (queue.length > 0 && paths.length < 5) {
      const path = queue.shift()!
      const current = path[path.length - 1]
      if (current === to) { paths.push(path); continue }
      if (visited.has(current)) continue
      visited.add(current)
      const deps = store.getDependenciesForNode(current)
      for (const d of deps) {
        const next = d.src === current ? d.dst : d.src
        if (!visited.has(next)) queue.push([...path, next])
      }
    }

    return c.json({ paths, pathCount: paths.length })
  })

  // ─── GET /subgraph ────────────────────────────────────────────────────
  app.get('/subgraph', (c) => {
    const store = getStore()
    const layer = c.req.query('layer')
    const scope = c.req.query('scope')
    let nodes = layer ? store.getNodesByLayer(layer) : store.getAllNodes()
    if (scope) nodes = nodes.filter(n => n.parentId === scope || n.id === scope)
    return c.json({ nodes, nodeCount: nodes.length })
  })

  // ─── POST /query ──────────────────────────────────────────────────────
  app.post('/query', async (c) => {
    const store = getStore()
    const body = await c.req.json<GqpQueryRequest>()
    const { focus, hops = 2, layers, dependency_types, exclude = [], return: fields } = body

    // Find focus node by id or label
    let focusNode = store.getNode(focus)
    if (!focusNode) {
      const results = store.searchNodes(focus, 1)
      focusNode = results[0] ?? null
    }
    if (!focusNode) return c.json({ error: 'focus node not found' }, 404)

    const { nodes, dependencies } = store.getNeighbors(focusNode.id, hops)

    // Apply filters
    let filteredNodes = nodes
    if (layers?.length) filteredNodes = filteredNodes.filter(n => layers.includes(n.layer))
    if (exclude.length) {
      filteredNodes = filteredNodes.filter(n =>
        !exclude.some(pat => n.label.match(pat.replace('*', '.*')))
      )
    }

    let filteredDeps = dependencies
    if (dependency_types?.length) filteredDeps = filteredDeps.filter(d => dependency_types.includes(d.type))

    // Field projection
    let result: unknown = { nodes: filteredNodes, dependencies: filteredDeps }
    if (fields?.length) {
      result = {
        nodes: filteredNodes.map(n => Object.fromEntries(fields.map(f => [f, (n as any)[f]]))),
        dependencies: filteredDeps,
      }
    }

    const tokens = estimateTokens(result)
    notifyAgentActivity(hub, 'query_graph', focus, filteredNodes.map(n => n.id), tokens)

    return c.json({ ...(result as object), estimatedTokens: tokens })
  })

  // ─── POST /trace ──────────────────────────────────────────────────────
  app.post('/trace', async (c) => {
    const store = getStore()
    const body = await c.req.json<GqpTraceRequest>()
    const { entry_point, follow = ['CALLS', 'IMPORTS'], max_depth = 10 } = body

    let startNode = store.getNode(entry_point)
    if (!startNode) {
      const results = store.searchNodes(entry_point, 1)
      startNode = results[0] ?? null
    }
    if (!startNode) return c.json({ error: 'entry point not found' }, 404)

    // DFS trace following specified dependency types
    const path: string[] = [startNode.id]
    const visited = new Set([startNode.id])
    const dfs = (nodeId: string, depth: number) => {
      if (depth >= max_depth) return
      const deps = store.getDependenciesForNode(nodeId)
      for (const d of deps) {
        if (!follow.includes(d.type)) continue
        const next = d.src === nodeId ? d.dst : d.src
        if (!visited.has(next)) {
          visited.add(next)
          path.push(next)
          dfs(next, depth + 1)
        }
      }
    }
    dfs(startNode.id, 0)

    const traceNodes = path.map(id => store.getNode(id)).filter(Boolean) as AsmNode[]
    notifyAgentActivity(hub, 'trace_path', entry_point, path, estimateTokens(path))

    // Notify canvas to animate the trace
    hub.broadcast({ type: 'graph:patch', payload: {
      addedNodes: [],
      removedNodeIds: [],
      updatedNodes: traceNodes.map(n => ({ ...n, agentTouched: true })),
      addedDependencies: [],
      removedDependencyIds: [],
    }})

    return c.json({ path, nodes: traceNodes, depth: path.length })
  })

  // ─── POST /graph/patch ────────────────────────────────────────────────
  app.post('/graph/patch', async (c) => {
    const store = getStore()
    const patch = await c.req.json()
    if (patch.addedNodes) store.upsertNodes(patch.addedNodes)
    if (patch.addedDependencies) store.upsertDependencies(patch.addedDependencies)
    if (patch.removedNodeIds) patch.removedNodeIds.forEach((id: string) => store.deleteNode(id))
    store.updateChildCounts()
    hub.broadcast({ type: 'graph:patch', payload: patch })
    store.logEvent('agent:patch', patch, 'agent')
    return c.json({ ok: true })
  })

  // ─── GET /mutations (SSE stream) ──────────────────────────────────────
  app.get('/mutations', (c) => {
    return streamSSE(c, async (stream) => {
      const send = (intent: MutationIntent) => {
        stream.writeSSE({ data: JSON.stringify(intent), event: 'mutation' })
      }
      mutationSubscribers.add(send)
      // Keep alive
      const ping = setInterval(() => stream.writeSSE({ data: '', event: 'ping' }), 15000)
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          mutationSubscribers.delete(send)
          clearInterval(ping)
          resolve()
        })
      })
    })
  })

  // ─── GET /search ──────────────────────────────────────────────────────
  app.get('/search', (c) => {
    const store = getStore()
    const q = c.req.query('q') ?? ''
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const results = store.searchNodes(q, limit)
    return c.json({ results, count: results.length })
  })

  // ─── GET /raw-files - agent-facing file list for semantic mapping ──────
  // Returns all indexed files with language, symbol count, and current parentage.
  // Use this as input for create_system + assign_file_to_system.
  app.get('/raw-files', (c) => {
    const store = getStore()
    const files = store.getRawFiles()
    const tokens = estimateTokens(files)
    notifyAgentActivity(hub, 'get_raw_files', 'all', [], tokens)
    return c.json({ files, total: files.length, estimatedTokens: tokens })
  })

  // ─── GET /call-graph - file-level call graph for agent analysis ───────
  // Returns CALLS/IMPORTS edges aggregated by file pair with call counts.
  app.get('/call-graph', (c) => {
    const store = getStore()
    const graph = store.getCallGraph()
    const tokens = estimateTokens(graph)
    notifyAgentActivity(hub, 'get_call_graph', 'all', [], tokens)
    return c.json({ dependencies: graph, total: graph.length, estimatedTokens: tokens })
  })

  // ─── GET /systems/cluster - get descendants of a system matching by name ──
  app.get('/systems/cluster', (c) => {
    const store = getStore()
    const nameQuery = c.req.query('name')
    if (!nameQuery) return c.json({ error: 'name query parameter is required' }, 400)

    const allNodes = store.getAllNodes()
    const queryLower = nameQuery.toLowerCase()
    const matchedSystem = allNodes.find(n =>
      (n.type === 'service' || n.type === 'module') &&
      n.label.toLowerCase().includes(queryLower)
    )

    if (!matchedSystem) {
      return c.json({ error: `No system or module found matching: "${nameQuery}"` }, 404)
    }

    const descendants: AsmNode[] = []
    const queue = [matchedSystem.id]
    const visited = new Set<string>([matchedSystem.id])

    while (queue.length > 0) {
      const currentId = queue.shift()!
      const children = allNodes.filter(n => n.parentId === currentId)
      for (const child of children) {
        if (!visited.has(child.id)) {
          visited.add(child.id)
          descendants.push(child)
          queue.push(child.id)
        }
      }
    }

    const files = descendants.filter(n => n.type === 'file')
    const symbols = descendants.filter(n => n.type === 'symbol')

    const result = {
      system: matchedSystem,
      files,
      symbols,
      fileCount: files.length,
      symbolCount: symbols.length,
    }

    const tokens = estimateTokens(result)
    notifyAgentActivity(hub, 'get_cluster', nameQuery, [matchedSystem.id, ...descendants.map(n => n.id)], tokens)

    return c.json({ ...result, estimatedTokens: tokens })
  })

  // ─── POST /systems - create an agent-authored system node ─────────────
  // Body: { name: string, description?: string, color?: string, layer?: 'SERVICE'|'MODULE' }
  // Returns the created node's ID.
  app.post('/systems', async (c) => {
    const store = getStore()
    const body = await c.req.json() as {
      name: string
      description?: string
      color?: string
      layer?: Layer
      parentId?: string
    }
    if (!body.name) return c.json({ error: 'name is required' }, 400)

    const id = `sys_${crypto.randomBytes(6).toString('hex')}`
    const layer: Layer = body.layer ?? 'SERVICE'
    const depth = layer === 'SERVICE' ? 0 : 1

    const node: AsmNode = {
      id,
      type: layer === 'SERVICE' ? 'service' : 'module',
      layer,
      label: body.name,
      childCount: 0,
      parentId: body.parentId,
      semanticDepth: depth,
      agentAuthored: true,
      position: { x: 0, y: 0 },
      metadata: {
        description: body.description ?? '',
        color: body.color ?? '',
        agentCreated: true,
      },
    }

    store.createSystemNode(node)
    store.updateChildCounts()

    // Broadcast patch so canvas updates live
    hub.broadcast({ type: 'graph:patch', payload: {
      addedNodes: [node],
      removedNodeIds: [],
      updatedNodes: [],
      addedDependencies: [],
      removedDependencyIds: [],
    }})

    notifyAgentActivity(hub, 'create_system', body.name, [id], 50)
    return c.json({ id, node })
  })

  // ─── POST /systems/:id/assign - assign file(s) to a system ───────────
  // Body: { fileIds?: string[], filePaths?: string[], confidence?: number }
  // Sets parentId on the specified file nodes and updates the canvas.
  app.post('/systems/:id/assign', async (c) => {
    const store = getStore()
    const systemId = c.req.param('id')
    const system = store.getNode(systemId)
    if (!system) return c.json({ error: 'system not found' }, 404)

    const body = await c.req.json() as {
      fileIds?: string[]
      filePaths?: string[]
      confidence?: number
    }

    const updatedNodes: AsmNode[] = []
    const allNodes = store.getAllNodes()

    const targetIds = new Set<string>(body.fileIds ?? [])
    if (body.filePaths) {
      for (const fp of body.filePaths) {
        const match = allNodes.find(n => n.filePath === fp)
        if (match) targetIds.add(match.id)
      }
    }

    for (const nodeId of targetIds) {
      store.updateNodeParent(nodeId, systemId)
      const updated = store.getNode(nodeId)
      if (updated) updatedNodes.push(updated)
    }

    store.updateChildCounts()

    // Broadcast updates
    hub.broadcast({ type: 'graph:patch', payload: {
      addedNodes: [],
      removedNodeIds: [],
      updatedNodes,
      addedDependencies: [],
      removedDependencyIds: [],
    }})

    notifyAgentActivity(hub, 'assign_file_to_system', systemId, [...targetIds], 80)
    return c.json({ assigned: updatedNodes.length, systemId, updatedNodes })
  })

  // ─── POST /systems/connection - create semantic dependency between systems ──
  // Body: { fromId, toId, type?, label? }
  app.post('/systems/connection', async (c) => {
    const store = getStore()
    const body = await c.req.json() as {
      fromId: string
      toId: string
      type?: string
      label?: string
    }
    if (!body.fromId || !body.toId) return c.json({ error: 'fromId and toId required' }, 400)

    const dependencyId = `agentdep_${crypto.randomBytes(6).toString('hex')}`
    const dependency: AsmDependency = {
      id: dependencyId,
      src: body.fromId,
      dst: body.toId,
      type: (body.type as any) ?? 'DEPENDS_ON',
      weight: 1,
      active: true,
      label: body.label,
      agentAuthored: true,
    }

    store.upsertDependency(dependency)
    hub.broadcast({ type: 'graph:patch', payload: {
      addedNodes: [],
      removedNodeIds: [],
      updatedNodes: [],
      addedDependencies: [dependency],
      removedDependencyIds: [],
    }})

    notifyAgentActivity(hub, 'create_connection', `${body.fromId}→${body.toId}`, [body.fromId, body.toId], 30)
    return c.json({ dependencyId, dependency })
  })

  return app
}

function notifyAgentActivity(hub: WsHub, tool: string, focus: string, nodeIds: string[], tokens: number) {
  hub.broadcast({
    type: 'agent:activity',
    payload: {
      touchedNodeIds: nodeIds,
      query: focus,
      tool,
      timestamp: Date.now(),
      tokenCount: tokens,
    } satisfies AgentActivity,
  })
}

export function startAgentApi(getStore: () => GraphStore, hub: WsHub, port = 7743): { close: () => void } {
  const app = createAgentApi(getStore, hub)
  const server = serve({ fetch: app.fetch, port })
  console.log(`[archd] GQP agent API listening on http://localhost:${port}`)
  return { close: () => server.close() }
}
