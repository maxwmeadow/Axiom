import fs from 'node:fs'
import os from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { detectEditors } from './fileAccess.ts'
import { resolveNodeCommand } from './platformPaths.ts'
import type { DeliveryHost, DeliveryRun } from '../src/shared/agentDelivery.ts'

export interface DeliveryLauncher { command: string; args: string[]; bundledNode?: boolean }
export interface DeliveryTarget extends DeliveryHost { launcher?: DeliveryLauncher }
const CLI_NAMES: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', 'copilot-cli': 'copilot' }
const NPM_ENTRIES: Record<string, string> = {
  'claude-code': '@anthropic-ai/claude-code/cli.js',
  codex: '@openai/codex/bin/codex.js',
  'copilot-cli': '@github/copilot/index.js',
}

function environmentPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path')
  return key ? env[key] ?? '' : ''
}

function executable(file: string): boolean {
  try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/** Resolve known CLIs, including native installs and npm's Windows JS entrypoints.
 * Never invoke a .cmd shim through a shell with a human-authored prompt. */
export function findDeliveryCli(hostId: string, env = process.env, platform = process.platform, home = os.homedir(), node = process.execPath): DeliveryLauncher | undefined {
  const name = CLI_NAMES[hostId]
  if (!name) return undefined
  const dirs = [...environmentPath(env).split(delimiter).filter(Boolean), join(home, '.local', 'bin'), join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const versions of [join(home, '.nvm', 'versions', 'node'), join(home, '.asdf', 'installs', 'nodejs')]) {
    try { dirs.push(...fs.readdirSync(versions).sort().reverse().map(version => join(versions, version, 'bin'))) } catch { /* manager not installed */ }
  }
  if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'))
  for (const dir of dirs) {
    const command = join(dir, platform === 'win32' ? `${name}.exe` : name)
    if (executable(command)) return { command, args: [] }
  }
  const entry = NPM_ENTRIES[hostId]
  const npmDirs = [...dirs.map(dir => join(dir, 'node_modules')), join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']
  for (const dir of npmDirs) {
    const script = join(dir, entry)
    if (fs.existsSync(script) && fs.statSync(script).isFile()) return { command: node, args: [script], bundledNode: true }
  }
  return undefined
}

/** All installed modalities remain visible, even when a host has no public chat API. */
export function deliveryTargets(hosts: { id: string; label: string }[], env = process.env, platform = process.platform, home = os.homedir()): DeliveryTarget[] {
  const editors = detectEditors(env, platform, home)
  const editorId: Record<string, string[]> = { copilot: ['vscode'], cursor: ['cursor'], windsurf: ['windsurf'], jetbrains: ['intellij', 'webstorm', 'pycharm', 'goland'], zed: ['zed'] }
  return hosts.map(({ id, label }) => {
    const host = { id, label }
    if (CLI_NAMES[host.id]) {
      const launcher = findDeliveryCli(host.id, env, platform, home)
      return { ...host, route: 'run', available: !!launcher, launcher, detail: launcher ? 'Start a new run in this project. Host permissions still apply.' : 'CLI executable not found. Install it or use copy handoff.' }
    }
    let launcher: DeliveryLauncher | undefined
    const editor = editors.find(item => editorId[host.id]?.includes(item.id))
    if (editor) launcher = { command: editor.command, args: [] }
    if (host.id === 'antigravity' && platform !== 'win32') {
      const command = [...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/local/bin'].map(dir => join(dir, 'antigravity')).find(executable)
      if (command) launcher = { command, args: [] }
    }
    if (host.id === 'claude-desktop' && platform === 'darwin') {
      const app = ['/Applications/Claude.app', join(home, 'Applications', 'Claude.app')].find(file => fs.existsSync(file))
      if (app) launcher = { command: '/usr/bin/open', args: ['-a', app] }
    }
    return { ...host, route: launcher ? 'open' : 'copy', available: true, launcher, detail: launcher ? 'Copy the handoff and open this host. Paste it into the chat you choose.' : 'Copy the handoff, then paste it into this host’s chat. No supported launcher was found.' }
  })
}

export function deliveryArguments(hostId: string, mcp: DeliveryLauncher, workspaceId: string, prompt: string): string[] {
  const server = { command: mcp.command, args: [...mcp.args, `--axiom-host=${hostId}`], env: { AXIOM_WORKSPACE_ID: workspaceId } }
  if (hostId === 'claude-code') return ['-p', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { axiom: server } }), '--allowedTools', 'mcp__axiom,Read,Glob,Grep,Edit,Write,Bash(npm run:*),Bash(npm test:*),Bash(npx tsc:*),Bash(go test:*),Bash(go vet:*),Bash(git status:*),Bash(git diff:*)']
  if (hostId === 'codex') return ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', `mcp_servers.axiom.command=${JSON.stringify(server.command)}`, '-c', `mcp_servers.axiom.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.axiom.env.AXIOM_WORKSPACE_ID=${JSON.stringify(workspaceId)}`, '-c', 'mcp_servers.axiom.enabled=true', '-']
  if (hostId === 'copilot-cli') return ['--prompt', prompt, '--additional-mcp-config', JSON.stringify({ mcpServers: { axiom: { ...server, tools: ['*'] } } }), '--allow-tool', 'axiom', '--allow-tool', 'write', '--allow-tool', 'shell(npm run:*)', '--allow-tool', 'shell(npm test:*)', '--allow-tool', 'shell(go test:*)', '--allow-tool', 'shell(go vet:*)', '--allow-tool', 'shell(git status:*)', '--allow-tool', 'shell(git diff:*)', '--no-ask-user']
  throw new Error('This host has no direct delivery route.')
}

export interface RunInput { workspaceId: string; messageId: string; hostId: string; rootPath: string; revision: string; launcher: DeliveryLauncher; args: string[]; prompt: string }

export function checkDeliveryMessage(message: { id?: string; workspaceId?: string; deliveryMode?: string; status?: string; leaseExpiresAt?: number }, workspaceId: string, messageId: string, now = Date.now()): void {
  if (message.id !== messageId || message.workspaceId !== workspaceId) throw new Error('This work order belongs to another project.')
  if (message.deliveryMode !== 'addressed' || !['queued', 'delivered'].includes(message.status ?? '')) throw new Error('This work order is closed or is not an addressed request.')
  if ((message.leaseExpiresAt ?? 0) > now) throw new Error('An agent already holds this request. Wait for its reply or stop that agent before handing it off again.')
}

/** Launch receipts are written before spawn. A retry after a crash never silently
 * executes the same request again. MCP claims still fence replies across hosts. */
export class DeliveryRunner {
  private live = new Map<string, { child: ChildProcess; run: DeliveryRun }>()
  private directory: string
  private spawnProcess: typeof spawn
  constructor(directory: string, spawnProcess: typeof spawn = spawn) {
    this.directory = directory
    this.spawnProcess = spawnProcess
  }

  private file(key: string): string { return join(this.directory, `${key}.json`) }
  private save(run: DeliveryRun): void {
    fs.writeFileSync(`${this.file(run.key)}.tmp`, JSON.stringify(run), { mode: 0o600 })
    fs.renameSync(`${this.file(run.key)}.tmp`, this.file(run.key))
  }
  list(workspaceId: string): DeliveryRun[] {
    if (!fs.existsSync(this.directory)) return []
    return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      try {
        const run = JSON.parse(fs.readFileSync(join(this.directory, name), 'utf8')) as DeliveryRun
        if (run.workspaceId !== workspaceId) return []
        if (['starting', 'running', 'stopping'].includes(run.state) && !this.live.has(run.key)) return [{ ...run, state: 'interrupted' as const, detail: 'Axiom restarted during this run. Check the agent and its output before handing off again.' }]
        return [run]
      } catch { return [] }
    })
  }
  start(input: RunInput): Promise<DeliveryRun> {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(JSON.stringify([input.workspaceId, input.messageId, input.revision])).digest('hex')
    const prior = this.list(input.workspaceId).find(run => run.key === key)
    if (prior && prior.state !== 'launch-failed') return Promise.resolve(prior)
    const rootPath = fs.realpathSync(input.rootPath)
    if ([...this.live.values()].some(({ run }) => fs.realpathSync(run.rootPath) === rootPath)) throw new Error('An Axiom-launched agent is already running in this project. Stop it or wait for its result first.')
    for (const previous of this.list(input.workspaceId)) {
      if (previous.state !== 'interrupted' || !previous.pid) continue
      try { process.kill(previous.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
      throw new Error('An earlier agent process may still be running after Axiom restarted. Stop that agent before launching another in this project.')
    }
    const run: DeliveryRun = { key, workspaceId: input.workspaceId, messageId: input.messageId, revision: input.revision, hostId: input.hostId, rootPath, state: 'starting', detail: 'Starting agent…', logPath: join(this.directory, `${key}.log`), startedAt: Date.now() }
    // Exclusive receipt also protects a second Electron process.
    if (!prior) {
      try { fs.writeFileSync(this.file(key), JSON.stringify(run), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This work order already has a launch receipt. Refresh before trying again.'); throw error }
    } else this.save(run)
    fs.writeFileSync(run.logPath, '', { mode: 0o600 })
    return new Promise(resolveRun => {
      let child: ChildProcess
      const fail = (error: Error) => { run.state = 'launch-failed'; run.detail = `Could not launch the agent: ${error.message}`; this.live.delete(key); this.save(run); resolveRun({ ...run }) }
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, AXIOM_WORKSPACE_ID: input.workspaceId, AXIOM_AGENT_HOST: input.hostId }
        // A GUI app's PATH may omit the directory of its resolved CLI or Node.
        const node = resolveNodeCommand()
        const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
        env[pathKey] = [dirname(input.launcher.command), ...(isAbsolute(node) ? [dirname(node)] : []), ...environmentPath(env).split(delimiter)].join(delimiter)
        if (input.launcher.bundledNode) env.ELECTRON_RUN_AS_NODE = '1'
        else delete env.ELECTRON_RUN_AS_NODE
        child = this.spawnProcess(input.launcher.command, [...input.launcher.args, ...input.args], { cwd: rootPath, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) { fail(error as Error); return }
      this.live.set(key, { child, run })
      let logged = 0
      const output = (chunk: Buffer) => {
        const part = chunk.subarray(0, Math.max(0, 1024 * 1024 - logged))
        if (part.length) { fs.appendFileSync(run.logPath, part); logged += part.length }
      }
      child.stdout?.on('data', output); child.stderr?.on('data', output)
      child.stdin?.on('error', () => { /* An early host exit is reported by close. */ })
      child.once('error', error => {
        if (run.state === 'starting') fail(error)
        else { run.state = 'failed'; run.detail = `Agent process failed: ${error.message}`; this.save(run) }
      })
      child.once('spawn', () => {
        run.pid = child.pid; run.state = 'running'; run.detail = 'Agent launched. Waiting for its claim and reply.'; this.save(run)
        child.stdin?.end(input.hostId === 'copilot-cli' ? undefined : input.prompt)
        resolveRun({ ...run })
      })
      child.once('close', (code, signal) => {
        this.live.delete(key)
        if (run.state === 'launch-failed') return
        if (run.state === 'stopping') {
          run.state = 'stopped'; run.detail = 'Agent process stopped. Edits already made are kept; this does not cancel the work order.'
        } else {
          run.state = code === 0 ? 'completed' : 'failed'
          run.detail = code === 0 ? 'Agent process finished. Its canvas reply determines whether the result is ready for review.' : `Agent exited ${signal ?? code}. Check its output; the work order remains in the inbox.`
        }
        this.save(run)
      })
    })
  }
  stop(workspaceId: string, key: string): void {
    const entry = this.live.get(key)
    if (!entry || entry.run.workspaceId !== workspaceId) throw new Error('This run is no longer controlled by Axiom. Check the agent separately.')
    if (entry.child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(entry.child.pid), '/T', '/F'], { shell: false, windowsHide: true })
        killer.on('error', () => entry.child.kill())
      } else process.kill(-entry.child.pid, 'SIGTERM')
    }
    entry.run.state = 'stopping'; entry.run.detail = 'Stop requested. Waiting for the agent process to exit.'; this.save(entry.run)
  }
  stopAll(): void { for (const [key, { run }] of this.live) { try { this.stop(run.workspaceId, key) } catch { /* already exited */ } } }
}
