#!/usr/bin/env node
// Cross-platform entry point for the archd Go toolchain scripts.
//
// scripts/archd.sh does the real work. What is not portable is choosing the
// shell that runs it: Windows needs MSYS2's bash specifically, because the Go
// and GCC toolchains archd builds against live inside that environment and
// TDM-GCC is not a substitute. macOS and Linux just need the system bash.
//
// Keeping that choice here means package.json stays free of absolute paths,
// so the same `npm run` commands work on every platform.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function resolveBash() {
  if (process.platform !== 'win32') return 'bash'

  const candidates = [process.env.AXIOM_MSYS2_BASH, 'C:\\msys64\\usr\\bin\\bash.exe'].filter(Boolean)
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    console.error(
      'archd: MSYS2 bash not found.\n' +
      'Install MSYS2 to C:\\msys64, or point AXIOM_MSYS2_BASH at its usr/bin/bash.exe.'
    )
    process.exit(1)
  }
  return found
}

// MSYS2 bash needs its own usr/bin (uname, etc.) on PATH. Invoked from a
// plain PowerShell/cmd process, the inherited PATH is pure Windows-style and
// has no MSYS2 entries at all, so bare bash.exe cannot find the core utilities
// scripts/archd.sh calls to detect the platform.
const bash = resolveBash()
const env = { ...process.env }
if (process.platform === 'win32') {
  const msysRoot = bash.replace(/[\\/]usr[\\/]bin[\\/]bash\.exe$/i, '')
  env.PATH = `${msysRoot}\\usr\\bin;${env.PATH ?? ''}`
}

// Invoked relative to the repo root so the path stays valid inside MSYS2,
// which does not understand a Windows-style absolute path here.
const { status } = spawnSync(bash, ['scripts/archd.sh', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
})
process.exit(status ?? 1)
