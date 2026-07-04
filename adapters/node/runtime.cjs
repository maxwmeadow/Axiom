'use strict'
// Main-thread runtime for the Axiom Node adapter.
//
// Installed as globalThis.__axiom by the bootstrap. The AST-instrumented code
// calls enter/ret/error/exit on it. This module owns:
//   - the TCP connection to archd (same NDJSON protocol as the Python adapter)
//   - the watch registry (keyed by file+symbol, matched by line range)
//   - AsyncLocalStorage trace propagation across await/callbacks
//   - the serializer (depth/length limited, never invokes user getters deeply)
//   - the per-watch rate limiter (>100 calls/sec auto-disables)
//   - value injection (one-shot parameter override, warn-and-confirm on archd)
//
// enter() must be fast when a function is unwatched: a single Map lookup, then
// return the shared INACTIVE context. ret/error/exit short-circuit on it.

const net = require('net')
const os = require('os')
const path = require('path')
const { AsyncLocalStorage } = require('async_hooks')

const MAX_STR = 256
const MAX_ITEMS = 10
const MAX_DEPTH = 2
const MAX_CALLS_PER_SEC = 100
const QUEUE_MAX = 1000
const RECONNECT_MS = 5000
const HEARTBEAT_MS = 5000

const INACTIVE = Object.freeze({ active: false, o: null })

class AxiomRuntime {
  constructor(port, workspaceId) {
    this.port = port
    this.workspaceId = workspaceId
    this.als = new AsyncLocalStorage()
    this.sock = null
    this.connected = false
    this.paused = false
    this.queue = []
    this.dropped = 0
    // Watches keyed by normalized-file → array of {id, symbol, lineStart, lineEnd, ...}
    this.watchesByFile = new Map()
    // Injections keyed by normalized-file → array of {id, symbol, lineStart, lineEnd, paramName, value, once, consumed}
    this.injectsByFile = new Map()
    this._connect()
    this._heartbeat = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS)
    if (this._heartbeat.unref) this._heartbeat.unref()
  }

  // ── instrumentation hooks (hot path) ────────────────────────────────────────

  enter(file, name, line, argsArr, paramNames) {
    const watch = this._matchWatch(file, name, line)
    const inject = this._matchInject(file, name, line)
    if (!watch && !inject) return INACTIVE

    const now = Date.now()
    let override = null
    if (inject && !inject.consumed) {
      override = this._applyInject(inject, paramNames, argsArr)
    }

    if (!watch) {
      // Injection with no watch: still perturb, but no call/return stream.
      return { active: false, o: override }
    }

    // Rate limiter (sliding 1s window).
    if (now - watch._winStart >= 1000) {
      watch._winStart = now
      watch._winCount = 0
    }
    watch._winCount++
    if (watch._winCount > MAX_CALLS_PER_SEC) {
      if (!watch._rateLimited) {
        watch._rateLimited = true
        this._emit({
          kind: 'rate_limit',
          watchId: watch.id,
          ts: now,
          message: `exceeded ${MAX_CALLS_PER_SEC} calls/sec — watch auto-disabled`,
        })
      }
      return override ? { active: false, o: override } : INACTIVE
    }

    const parent = this.als.getStore()
    const traceId = randId()
    const args = {}
    for (let i = 0; i < paramNames.length; i++) {
      args[paramNames[i]] = safeValue(argsArr[i])
    }
    const injectId = parent && parent.injectId ? parent.injectId : (override ? inject.id : '')
    this.als.enterWith({ traceId, injectId })

    this._emit({
      kind: 'call',
      watchId: watch.id,
      traceId,
      parentTraceId: parent ? parent.traceId : '',
      injectId,
      threadId: 'main',
      ts: now,
      args,
    })
    // prevStore is restored in exit() so a callee doesn't leave its traceId as
    // the caller's "current" context (which would mis-parent later siblings).
    return { active: true, watchId: watch.id, traceId, injectId, o: override, prevStore: parent, returned: false, errored: false }
  }

  ret(ctx, value) {
    if (ctx && ctx.active && !ctx.returned && !ctx.errored) {
      ctx.returned = true
      this._emit({
        kind: 'return',
        watchId: ctx.watchId,
        traceId: ctx.traceId,
        injectId: ctx.injectId,
        threadId: 'main',
        ts: Date.now(),
        returnValue: safeValue(value),
      })
    }
    return value
  }

  error(ctx, err) {
    if (ctx && ctx.active && !ctx.errored) {
      ctx.errored = true
      this._emit({
        kind: 'exception',
        watchId: ctx.watchId,
        traceId: ctx.traceId,
        injectId: ctx.injectId,
        threadId: 'main',
        ts: Date.now(),
        excType: (err && err.name) || 'Error',
        message: String((err && err.message) != null ? err.message : err).slice(0, 512),
      })
    }
  }

  exit(ctx) {
    if (!ctx || !ctx.active) return
    // Function fell off the end without an explicit return and didn't throw:
    // emit a return-undefined so the canvas closes the call.
    if (!ctx.returned && !ctx.errored) {
      ctx.returned = true
      this._emit({
        kind: 'return',
        watchId: ctx.watchId,
        traceId: ctx.traceId,
        injectId: ctx.injectId,
        threadId: 'main',
        ts: Date.now(),
        returnValue: safeValue(undefined),
      })
    }
    // Restore the caller's trace context (see enter()).
    this.als.enterWith(ctx.prevStore)
  }

  // ── watch / inject matching ─────────────────────────────────────────────────

  _matchWatch(file, name, line) {
    const bucket = this.watchesByFile.get(normFile(file))
    if (!bucket) return null
    const named = bucket.filter((w) => w.symbol === name)
    for (const w of named) {
      if (w.lineStart <= line && line <= Math.max(w.lineEnd, w.lineStart)) return w
    }
    // Name-only fallback tolerates a stale index, but only when unambiguous —
    // never hijack a different same-named function in the same file.
    return named.length === 1 ? named[0] : null
  }

  _matchInject(file, name, line) {
    const bucket = this.injectsByFile.get(normFile(file))
    if (!bucket) return null
    const named = bucket.filter((i) => !i.consumed && i.symbol === name)
    for (const inj of named) {
      if (inj.lineStart <= line && line <= Math.max(inj.lineEnd, inj.lineStart)) return inj
    }
    return named.length === 1 ? named[0] : null
  }

  _applyInject(inject, paramNames, argsArr) {
    if (!paramNames.includes(inject.paramName)) {
      this._emit({
        kind: 'inject_error',
        injectId: inject.id,
        ts: Date.now(),
        message: `parameter '${inject.paramName}' not found (has: ${paramNames.join(', ')})`,
      })
      inject.consumed = true
      this._removeInject(inject)
      return null
    }
    const idx = paramNames.indexOf(inject.paramName)
    const original = argsArr[idx]
    if (inject.once) {
      inject.consumed = true
      this._removeInject(inject)
    }
    this._emit({
      kind: 'inject_fired',
      injectId: inject.id,
      ts: Date.now(),
      original: safeValue(original),
      injected: safeValue(inject.value),
    })
    if (inject.once) {
      this._emit({ kind: 'inject_removed', injectId: inject.id, ts: Date.now() })
    }
    return { [inject.paramName]: inject.value }
  }

  // ── commands from archd ─────────────────────────────────────────────────────

  setWatches(watches) {
    this.watchesByFile = new Map()
    for (const w of watches || []) this._addWatch(w)
  }

  addWatch(w) {
    this._addWatch(w)
  }

  removeWatch(watchId) {
    for (const [file, bucket] of this.watchesByFile) {
      const next = bucket.filter((w) => w.id !== watchId)
      if (next.length) this.watchesByFile.set(file, next)
      else this.watchesByFile.delete(file)
    }
  }

  _addWatch(w) {
    const file = normFile(w.absPath || w.relPath || '')
    const rec = {
      id: w.id,
      symbol: w.symbol,
      lineStart: w.lineStart | 0,
      lineEnd: w.lineEnd | 0,
      _winStart: 0,
      _winCount: 0,
      _rateLimited: false,
    }
    const bucket = this.watchesByFile.get(file) || []
    const filtered = bucket.filter((x) => x.symbol !== rec.symbol)
    filtered.push(rec)
    this.watchesByFile.set(file, filtered)
  }

  arm(inject) {
    const file = normFile(inject.absPath || inject.relPath || '')
    const rec = {
      id: inject.id,
      symbol: inject.symbol,
      lineStart: inject.lineStart | 0,
      lineEnd: inject.lineEnd | 0,
      paramName: inject.paramName,
      value: inject.value,
      once: inject.once !== false,
      consumed: false,
    }
    const bucket = this.injectsByFile.get(file) || []
    bucket.push(rec)
    this.injectsByFile.set(file, bucket)
    this._emit({ kind: 'inject_armed', injectId: inject.id, ts: Date.now() })
  }

  removeInjectById(injectId) {
    for (const [file, bucket] of this.injectsByFile) {
      const next = bucket.filter((i) => i.id !== injectId)
      if (next.length) this.injectsByFile.set(file, next)
      else this.injectsByFile.delete(file)
    }
  }

  _removeInject(inject) {
    this.removeInjectById(inject.id)
  }

  // ── TCP transport ───────────────────────────────────────────────────────────

  _connect() {
    const sock = net.connect(this.port, '127.0.0.1')
    sock.setNoDelay(true)
    if (sock.unref) sock.unref() // never keep the target process alive for us
    this.sock = sock
    let buf = ''

    sock.on('connect', () => {
      this.connected = true
      this._write({
        type: 'hello',
        language: 'javascript',
        pid: process.pid,
        workspaceId: this.workspaceId,
        cwd: process.cwd(),
        runtimeVersion: `node ${process.version}`,
      })
      this._flush()
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) this._dispatch(line)
      }
    })
    // 'error' and 'close' both fire on failure — guard so only one reconnect
    // is scheduled (otherwise attempts double every cycle → fd exhaustion).
    let dropped = false
    const drop = () => {
      if (dropped) return
      dropped = true
      this.connected = false
      this.paused = false
      if (this.sock === sock) this.sock = null
      this.setWatches([])
      setTimeout(() => this._connect(), RECONNECT_MS).unref?.()
    }
    sock.on('error', drop)
    sock.on('close', drop)
    sock.on('drain', () => {
      this.paused = false
      this._flush()
    })
  }

  _dispatch(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    try {
      switch (msg.type) {
        case 'hello_ack': this.setWatches(msg.watches); break
        case 'watch': this.addWatch(msg.watch); break
        case 'unwatch': this.removeWatch(msg.watchId); break
        case 'inject': this.arm(msg.inject); break
        case 'uninject': this.removeInjectById(msg.injectId); break
      }
    } catch { /* never let a command crash the target */ }
  }

  _emit(event) {
    if (this.queue.length >= QUEUE_MAX) { this.dropped++; return }
    this.queue.push({ type: 'event', event })
    if (this.connected) this._flush()
  }

  _sendHeartbeat() {
    if (this.connected) this._write({ type: 'heartbeat' })
  }

  _flush() {
    if (!this.connected || !this.sock || this.paused) return
    const q = this.queue
    this.queue = []
    for (let i = 0; i < q.length; i++) {
      if (!this._write(q[i])) {
        // Socket buffer full — requeue the rest and wait for 'drain' so we
        // never buffer unbounded strings in the target process.
        this.paused = true
        this.queue = q.slice(i + 1).concat(this.queue)
        return
      }
    }
  }

  // Returns false when the socket applied backpressure (or failed).
  _write(obj) {
    if (!this.sock) return false
    try {
      return this.sock.write(JSON.stringify(obj) + '\n')
    } catch {
      return false
    }
  }
}

// ─── serialization (never throws, bounded) ────────────────────────────────────

function safeValue(v, depth) {
  depth = depth || 0
  try {
    return _safe(v, depth, new WeakSet())
  } catch {
    return { type: 'unknown', value: '<unserializable>' }
  }
}

function _safe(v, depth, seen) {
  const t = typeof v
  if (v === null) return { type: 'null', value: 'null' }
  if (v === undefined) return { type: 'undefined', value: 'undefined' }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return { type: t, value: String(v) }
  if (t === 'string') return { type: 'string', value: trunc(JSON.stringify(v)) }
  if (t === 'symbol') return { type: 'symbol', value: String(v) }
  if (t === 'function') return { type: 'function', value: `[Function: ${v.name || 'anonymous'}]` }
  if (typeof Promise !== 'undefined' && v instanceof Promise) return { type: 'Promise', value: '[Promise]' }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    const n = v.byteLength != null ? v.byteLength : (v.length || 0)
    return { type: v.constructor ? v.constructor.name : 'Buffer', value: `[binary ${n} bytes]` }
  }
  if (t === 'object') {
    if (seen.has(v)) return { type: 'object', value: '<circular>' }
    // Built-ins keep their data on internal slots, so Object.keys() is empty —
    // format them explicitly instead of emitting `Date {}`.
    if (v instanceof Date) return { type: 'Date', value: isNaN(v) ? 'Invalid Date' : v.toISOString() }
    if (v instanceof RegExp) return { type: 'RegExp', value: String(v) }
    if (v instanceof Error) return { type: v.name || 'Error', value: trunc(`${v.name}: ${v.message}`) }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      const parts = []
      let i = 0
      for (const [k, val] of v) {
        if (i++ >= MAX_ITEMS) { parts.push(`… +${v.size - MAX_ITEMS} more`); break }
        parts.push(`${_safe(k, depth + 1, seen).value} => ${_safe(val, depth + 1, seen).value}`)
      }
      return { type: 'Map', value: trunc(`Map(${v.size}) {` + parts.join(', ') + '}') }
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      const parts = []
      let i = 0
      for (const val of v) {
        if (i++ >= MAX_ITEMS) { parts.push(`… +${v.size - MAX_ITEMS} more`); break }
        parts.push(_safe(val, depth + 1, seen).value)
      }
      return { type: 'Set', value: trunc(`Set(${v.size}) {` + parts.join(', ') + '}') }
    }
    const cname = (v.constructor && v.constructor.name) || 'Object'
    if (depth >= MAX_DEPTH) {
      if (Array.isArray(v)) return { type: 'Array', value: `[Array len=${v.length}]` }
      return { type: cname, value: `<${cname}>` }
    }
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        const items = []
        for (let i = 0; i < v.length && i < MAX_ITEMS; i++) items.push(_safe(v[i], depth + 1, seen).value)
        if (v.length > MAX_ITEMS) items.push(`… +${v.length - MAX_ITEMS} more`)
        return { type: 'Array', value: trunc('[' + items.join(', ') + ']') }
      }
      const keys = Object.keys(v)
      const parts = []
      for (let i = 0; i < keys.length && i < MAX_ITEMS; i++) {
        const k = keys[i]
        let val
        try { val = _safe(v[k], depth + 1, seen).value } catch { val = '<getter threw>' }
        parts.push(`${k}: ${val}`)
      }
      if (keys.length > MAX_ITEMS) parts.push(`… +${keys.length - MAX_ITEMS} more`)
      const prefix = cname !== 'Object' ? cname + ' ' : ''
      return { type: cname, value: trunc(prefix + '{' + parts.join(', ') + '}') }
    } finally {
      seen.delete(v)
    }
  }
  return { type: t, value: trunc(String(v)) }
}

function trunc(str) {
  if (str.length > MAX_STR) return str.slice(0, MAX_STR - 1) + '…'
  return str
}

function normFile(p) {
  if (!p) return ''
  let out = p.replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

function randId() {
  return Math.random().toString(16).slice(2, 14)
}

// ─── bootstrap entry ──────────────────────────────────────────────────────────

// Worker threads inherit the --require/--import preload and will execute
// instrumented workspace code, but only the main thread runs the real runtime
// (one session per process). Off the main thread we install a NO-OP so the
// injected hooks resolve harmlessly instead of throwing on undefined __axiom.
const NOOP_RUNTIME = {
  enter() { return INACTIVE },
  ret(_ctx, v) { return v },
  error() {},
  exit() {},
  setWatches() {}, addWatch() {}, removeWatch() {},
  arm() {}, removeInjectById() {},
}

let installed = false
function install() {
  if (installed || globalThis.__axiom) return globalThis.__axiom
  installed = true
  let isMain = true
  try { isMain = require('worker_threads').isMainThread } catch (_) {}

  const rt = isMain
    ? new AxiomRuntime(
        parseInt(process.env.AXIOM_RUNTIME_PORT || '7745', 10),
        process.env.AXIOM_WORKSPACE_ID || '',
      )
    : NOOP_RUNTIME
  Object.defineProperty(globalThis, '__axiom', { value: rt, enumerable: false, configurable: true })
  return rt
}

module.exports = { install, AxiomRuntime, safeValue, normFile }
// Expose helpers for the bootstrap's workspace-file filter.
module.exports.workspaceRoot = function () {
  return process.env.AXIOM_WORKSPACE_ROOT || process.cwd()
}
module.exports.pathInWorkspace = function (file, root) {
  try {
    const rel = path.relative(root, file)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules')
  } catch {
    return false
  }
}
