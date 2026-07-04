// ESM bootstrap — loaded via NODE_OPTIONS="--import .../esm-bootstrap.mjs".
//
// Two responsibilities:
//   1. Install the main-thread runtime (globalThis.__axiom) so instrumented
//      ESM code has its hooks available when it executes.
//   2. Register the ESM loader (esm-loader.mjs) which runs in a worker thread
//      and rewrites the SOURCE of workspace modules. The loader shares no state
//      with the main thread — it only returns instrumented text; the injected
//      hooks resolve against globalThis.__axiom here on the main thread.
import { register } from 'node:module'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
require('./runtime.cjs').install()

register('./esm-loader.mjs', {
  parentURL: import.meta.url,
  data: {
    workspaceRoot: process.env.AXIOM_WORKSPACE_ROOT || process.cwd(),
    transformPath: fileURLToPath(new URL('./transform.cjs', import.meta.url)),
  },
})

// Silence unused import lint (pathToFileURL kept for potential future use).
void pathToFileURL
