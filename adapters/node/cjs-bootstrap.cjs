'use strict'
// CJS bootstrap — loaded via NODE_OPTIONS="--require .../cjs-bootstrap.cjs".
//
// Installs the main-thread runtime and patches Module.prototype._compile so
// every CommonJS file inside the user's workspace is AST-instrumented before
// V8 compiles it. node_modules and files outside the workspace are left alone.
// Never throws: a transform failure falls back to the original source.

const Module = require('module')
const runtime = require('./runtime.cjs')
const { transform } = require('./transform.cjs')

runtime.install() // installs the real runtime on the main thread, a no-op stub in workers

const root = runtime.workspaceRoot()
const origCompile = Module.prototype._compile

Module.prototype._compile = function (content, filename) {
  try {
    if (
      typeof content === 'string' &&
      (filename.endsWith('.js') || filename.endsWith('.cjs')) &&
      runtime.pathInWorkspace(filename, root)
    ) {
      const result = transform(content, { filename, sourceType: 'script' })
      if (result && result.code) {
        content = result.code +
          '\n//# sourceMappingURL=data:application/json;base64,' +
          Buffer.from(JSON.stringify(result.map)).toString('base64')
      }
    }
  } catch (err) {
    // Instrumentation must never break the target app.
    try { process.stderr.write(`[axiom] instrument ${filename} failed: ${err}\n`) } catch (_) {}
  }
  return origCompile.call(this, content, filename)
}
