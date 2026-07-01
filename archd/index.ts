/**
 * archd — Axiom's local background daemon
 *
 * Owns the ASM graph, watches the filesystem, serves the WebSocket hub
 * for the canvas, and serves the GQP HTTP API for AI agents.
 *
 * Communication with the Electron main process happens over IPC via stdin/stdout
 * when running as a child process, or standalone when invoked directly.
 */

import path from 'path'
import os from 'os'
import fs from 'fs'
import { GraphStore } from './graph-store'
import { FsWatcher } from './fs-watcher'
import { WsHub } from './ws-server'
import { startAgentApi, pushMutationIntent } from './agent-api'
import type { ProjectConfig, WsMessage, MutationIntent } from '../src/shared/types'

const DATA_DIR = path.join(os.homedir(), '.axiom', 'data')

interface DaemonState {
  store: GraphStore
  watcher?: FsWatcher
  wsHub: WsHub
  currentProject?: ProjectConfig
}

let state: DaemonState | null = null
// Agent API and WsHub are singletons across project switches
let wsHub: WsHub | null = null
let agentApiClose: (() => void) | null = null

async function startProject(config: ProjectConfig): Promise<void> {
  // Stop old watcher and close old store
  if (state) {
    state.watcher?.stop()
    state.store.close()
  }

  const projectDataDir = path.join(DATA_DIR, config.id)
  const store = new GraphStore(projectDataDir)

  // WsHub is started once and reused
  if (!wsHub) {
    wsHub = new WsHub(7744)
    // Forward every broadcast to Electron main process (which relays to renderer via IPC)
    wsHub.on('message', (msg) => sendToMain(msg))
  }

  // Agent API is started once and reused; getter always resolves to current project's store
  if (!agentApiClose) {
    const api = startAgentApi(() => {
      if (!state) throw new Error('[archd] No active project — open a project first')
      return state.store
    }, wsHub, 7743)
    agentApiClose = api.close
  }

  // Save project config
  const configPath = path.join(projectDataDir, 'project.json')
  fs.writeFileSync(configPath, JSON.stringify({ ...config, indexedAt: undefined }, null, 2))

  const watcher = new FsWatcher(config.rootPath, store, config.ignoredPaths)

  watcher.on('progress', (progress) => {
    // WsHub.broadcast() emits 'message' which forwards to Electron IPC automatically
    wsHub!.broadcast({ type: 'indexing:progress', payload: progress })
  })

  watcher.on('ready', (stats: { totalFiles: number; totalNodes: number }) => {
    // Send the canvas snapshot (excludes symbols for performance)
    const snapshot = store.getCanvasSnapshot()
    wsHub!.broadcast({ type: 'graph:snapshot', payload: snapshot })
    wsHub!.broadcast({ type: 'indexing:complete', payload: { totalNodes: stats.totalNodes } })
    // Signal that raw index is complete and an AI agent can now map the architecture
    wsHub!.broadcast({
      type: 'indexing:agent_ready',
      payload: {
        totalFiles: stats.totalFiles,
        totalNodes: stats.totalNodes,
        mcpEndpoint: 'http://localhost:7743',
      }
    })
    console.log(`[archd] Index ready: ${stats.totalNodes} nodes across ${stats.totalFiles} files`)
  })

  watcher.on('patch', (patch) => {
    wsHub!.broadcast({ type: 'graph:patch', payload: patch })
  })

  state = { store, watcher, wsHub: wsHub!, currentProject: config }

  console.log(`[archd] Starting index of ${config.rootPath}`)
  await watcher.start()
}

function sendToMain(msg: WsMessage): void {
  if (process.send) {
    process.send(msg)
  }
}

// ─── IPC from Electron main process ────────────────────────────────────────

process.on('message', async (msg: any) => {
  if (msg.type === 'open:project') {
    await startProject(msg.payload as ProjectConfig)
  } else if (msg.type === 'mutation:intent') {
    const intent = msg.payload as MutationIntent
    if (state) {
      state.store.logMutation(intent)
      pushMutationIntent(intent)
    }
  } else if (msg.type === 'node:position') {
    if (state) {
      const { id, x, y } = msg.payload as { id: string; x: number; y: number }
      state.store.updateNodePosition(id, x, y)
    }
  } else if (msg.type === 'graph:query') {
    // Direct query from main process
    if (state) {
      const snapshot = state.store.getSnapshot()
      sendToMain({ type: 'graph:snapshot', payload: snapshot })
    }
  }
})

// ─── Standalone mode (for development / testing) ───────────────────────────

if (!process.send) {
  const testPath = process.argv[2] ?? process.cwd()
  const projectId = Buffer.from(testPath).toString('base64').slice(0, 16)
  startProject({
    id: projectId,
    name: path.basename(testPath),
    rootPath: testPath,
    ignoredPaths: [],
    languageOverrides: {},
    layoutPreferences: { zoom: 1, panX: 0, panY: 0 },
    openedAt: Date.now(),
  })
}

// Graceful shutdown
process.on('SIGTERM', () => {
  state?.watcher?.stop()
  state?.store?.close()
  wsHub?.close()
  agentApiClose?.()
  process.exit(0)
})
