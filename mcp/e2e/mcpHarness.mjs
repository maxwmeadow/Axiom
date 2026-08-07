import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real MCP server, over real stdio, against a real archd.
 *
 * Unit tests prove the routing TABLE is right. They cannot prove a routed call
 * actually works: if a consolidated tool hands a legacy handler an argument
 * under the wrong name, the table still looks correct and the tool is broken.
 * That is the failure this harness exists to catch.
 *
 * Everything is isolated. archd runs on spare ports against a throwaway data
 * directory, and the MCP is pointed at a temporary active-project file, so a
 * developer's real workspace is never opened, written to, or read.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ARCHD_EXE = join(ROOT, 'archd-go', 'archd.exe')
const MCP_ENTRY = join(ROOT, 'mcp', 'axiom-mcp.ts')

// Deliberately not archd's defaults: a running Axiom must not be disturbed,
// and must not silently serve these requests either.
const API_PORT = 7853
const WS_PORT = 7854
const RUNTIME_PORT = 7855
const API_BASE = `http://127.0.0.1:${API_PORT}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A tiny two-system fixture: enough for clustering to find a boundary. */
function writeFixture(dir) {
  mkdirSync(join(dir, 'storage'), { recursive: true })
  mkdirSync(join(dir, 'api'), { recursive: true })
  writeFileSync(join(dir, 'storage', 'record.py'),
    'class Record:\n    def __init__(self, id):\n        self.id = id\n')
  writeFileSync(join(dir, 'storage', 'task_store.py'),
    'from record import Record\n\nclass TaskStore:\n    def add(self, record):\n        return Record(record)\n\n    def get(self, id):\n        return id\n')
  writeFileSync(join(dir, 'storage', 'index.py'),
    'from task_store import TaskStore\n\ndef build_index(store):\n    return store.get(1)\n')
  writeFileSync(join(dir, 'api', 'serializers.py'),
    'def to_json(obj):\n    return str(obj)\n')
  writeFileSync(join(dir, 'api', 'handlers.py'),
    'from serializers import to_json\n\ndef handle_get(request):\n    return to_json(request)\n')
  writeFileSync(join(dir, 'api', 'routes.py'),
    'from handlers import handle_get\n\ndef register(app):\n    return handle_get(app)\n')
}

async function waitForApi(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      // Any routed response proves the listener is up; 404 is fine.
      await fetch(`${API_BASE}/api/registry/services`)
      return
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`archd did not start on ${API_BASE} within ${timeoutMs}ms`)
}

/** One JSON-RPC conversation with the MCP server over stdio. */
class McpClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      this.buffer += chunk
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        const resolver = this.pending.get(message.id)
        if (resolver) {
          this.pending.delete(message.id)
          resolver(message)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { this.stderr += chunk })
  }

  request(method, params, timeoutMs = 25000) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out after ${timeoutMs}ms\nstderr:\n${this.stderr}`)),
        timeoutMs,
      )
      this.pending.set(id, message => { clearTimeout(timer); resolve(message) })
    })
  }

  /** Calls a tool and returns its parsed payload plus whether it errored. */
  async callTool(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args })
    const text = response?.result?.content?.[0]?.text ?? ''
    let payload = text
    try { payload = JSON.parse(text) } catch { /* some tools return prose */ }
    return { isError: !!response?.result?.isError, text, payload }
  }

  close() {
    try { this.child.stdin.end() } catch { /* already gone */ }
    try { this.child.kill() } catch { /* already gone */ }
  }
}

/**
 * Boots archd + MCP against a throwaway workspace and hands back a client.
 * Always pair with the returned `stop()`.
 */
export async function startHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'axiom-mcp-data-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'axiom-mcp-project-'))
  writeFixture(projectDir)

  const archd = spawn(ARCHD_EXE, [
    '-data', dataDir,
    '-api-port', String(API_PORT),
    '-ws-port', String(WS_PORT),
    '-runtime-port', String(RUNTIME_PORT),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  let archdLog = ''
  archd.stdout.setEncoding('utf8')
  archd.stderr.setEncoding('utf8')
  archd.stdout.on('data', chunk => { archdLog += chunk })
  archd.stderr.on('data', chunk => { archdLog += chunk })

  const cleanup = () => {
    try { archd.kill() } catch { /* already gone */ }
    for (const dir of [dataDir, projectDir]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
    }
  }

  try {
    await waitForApi()

    const workspaceId = 'harness-' + Date.now().toString(36)
    const created = await fetch(`${API_BASE}/api/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId, name: 'harness', rootPath: projectDir, ignoredPaths: [],
      }),
    })
    if (!created.ok) throw new Error(`workspace registration failed: ${await created.text()}`)

    // Indexing is asynchronous; wait for the graph rather than guessing.
    const deadline = Date.now() + 25000
    let snapshot = null
    while (Date.now() < deadline) {
      const res = await fetch(`${API_BASE}/api/snapshot/${workspaceId}`)
      if (res.ok) {
        snapshot = await res.json()
        if ((snapshot.files?.length ?? 0) >= 6) break
      }
      await sleep(250)
    }
    if (!snapshot || (snapshot.files?.length ?? 0) < 6) {
      throw new Error(`fixture never finished indexing.\narchd log:\n${archdLog}`)
    }

    const activeProjectPath = join(dataDir, 'active_project.json')
    writeFileSync(activeProjectPath, JSON.stringify({
      workspaceId, rootPath: projectDir, name: 'harness',
    }))

    const mcp = spawn(process.execPath, [MCP_ENTRY], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AXIOM_API_URL: API_BASE,
        AXIOM_ACTIVE_PROJECT: activeProjectPath,
      },
    })
    const client = new McpClient(mcp)

    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'axiom-harness', version: '1.0.0' },
    })

    return {
      client,
      snapshot,
      workspaceId,
      projectDir,
      archdLog: () => archdLog,
      stop: () => { client.close(); cleanup() },
    }
  } catch (err) {
    cleanup()
    throw err
  }
}
