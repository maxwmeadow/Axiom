// ESM loader hook — runs in a dedicated worker thread (Node v22).
//
// It has an isolated heap and cannot touch the main thread's runtime, so it
// does exactly one thing: rewrite the source of workspace .js/.mjs modules and
// hand the instrumented text back. The injected hooks (globalThis.__axiom.*)
// resolve on the MAIN thread when the module actually executes.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { relative, isAbsolute, sep } from 'node:path'

let transform = null
let workspaceRoot = process.cwd()

export async function initialize(data) {
  data = data || {}
  workspaceRoot = data.workspaceRoot || process.cwd()
  if (!data.transformPath) return // misconfigured — degrade to no instrumentation
  const require = createRequire(import.meta.url)
  transform = require(data.transformPath).transform
}

function inWorkspace(filePath) {
  try {
    const rel = relative(workspaceRoot, filePath)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('node_modules')
  } catch {
    return false
  }
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  try {
    if (
      transform &&
      (context.format === 'module' || context.format === 'commonjs') &&
      url.startsWith('file:') &&
      // .ts/.mts arrive as transpiled JS when a transpiler loader (tsx,
      // ts-node/esm) sits earlier in the nextLoad chain; raw TS fails acorn
      // parse and falls through. Node's native type stripping reports format
      // 'module-typescript', which the format check above already excludes.
      (url.endsWith('.js') || url.endsWith('.mjs') ||
       url.endsWith('.ts') || url.endsWith('.mts'))
    ) {
      const filePath = fileURLToPath(url)
      if (inWorkspace(filePath) && result.source != null) {
        const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
        const out = transform(src, { filename: filePath, sourceType: 'module' })
        if (out && out.code) {
          return {
            format: result.format,
            shortCircuit: true,
            source: out.code +
              '\n//# sourceMappingURL=data:application/json;base64,' +
              Buffer.from(JSON.stringify(out.map)).toString('base64'),
          }
        }
      }
    }
  } catch {
    // fall through to the original source
  }
  return result
}
