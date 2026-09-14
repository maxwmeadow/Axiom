#!/usr/bin/env node
// Bundles the MCP server into a standalone script for packaged builds.
//
// Agents launch this file themselves, as `node <path>`, outside Electron and
// outside the app's node_modules - which live inside app.asar and cannot be
// required from a plain Node process. So dependencies are inlined rather than
// externalized. The server only needs the MCP SDK and Node builtins, so the
// bundle stays small and has no native modules.
//
// The output is .mjs on purpose: packaged Resources has no package.json, so a
// .js file would be read as CommonJS and the ESM bundle would fail to parse.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const result = await build({
  entryPoints: [join(ROOT, 'mcp', 'axiom-mcp.ts')],
  outfile: join(ROOT, 'out', 'mcp', 'axiom-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Keep the banner: bundled ESM loses require(), which some transitive CJS
  // dependency may still reach for.
  banner: {
    js: [
      "import { createRequire as __axiomCreateRequire } from 'node:module'",
      'const require = __axiomCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  logLevel: 'info',
})

if (result.errors.length > 0) process.exit(1)
console.log('Done - ' + join(ROOT, 'out', 'mcp', 'axiom-mcp.mjs'))
