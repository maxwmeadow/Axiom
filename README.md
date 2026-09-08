# Axiom

Axiom is a local-first architecture workbench for understanding and shaping codebases with AI agents. It indexes source code into a structured graph, displays that graph on an interactive canvas, and exposes the same architecture to coding agents through MCP.

Humans and agents work against the same model: an agent can propose systems and file placement, while the user reviews, rearranges, resizes, renests, approves, or sends branches back before the proposal becomes canonical.

> Axiom is currently under active development. Expect product and setup details to change.

## What it does

- Indexes supported source files and extracts structural relationships.
- Organizes files into nested semantic systems rather than treating folders as architecture.
- Provides an interactive canvas with selection, movement, resize, nesting, collision handling, semantic zoom, and tidy layout.
- Lets connected agents inspect and propose architecture through MCP.
- Presents architecture proposals on the same canvas behavior used by the live workbench.
- Keeps readable project documentation searchable in a separate Documents panel.
- Stores workspace and architecture state locally in SQLite.

## Project workflow

1. Open a codebase in Axiom.
2. Review which folders and files belong in the index.
3. Add Axiom to a supported agent harness from the setup card.
4. Restart that agent so it loads the MCP server and mapping workflow.
5. Run the harness-specific mapping command shown by Axiom.
6. Review the proposed systems, nesting, and file placement.
7. Approve the proposal to make it the live canvas state.

The currently supported installers are:

- Claude (Claude Code CLI and Claude Desktop)
- GitHub Copilot (VS Code extension and Copilot CLI)
- Codex
- Cursor
- Windsurf
- Antigravity
- JetBrains IDEs (IntelliJ, WebStorm, PyCharm, and siblings)
- Zed

The mapping command is harness-dependent. For example, Codex uses `$axiom-map`, Claude Code uses `/axiom-map`, and Antigravity uses its installed `axiom-map` skill. The setup screen always shows the correct instruction for the selected harness.

## File policy

Architecture indexing currently supports:

- TypeScript and JavaScript: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`
- Python: `.py`
- Go: `.go`
- Rust: `.rs`
- C#: `.cs`
- C/C++ headers and sources: `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx`
- Ruby: `.rb`
- Java: `.java`

Readable documentation is indexed separately from the architecture canvas:

- `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`

Binary media, PDFs, images, generated output, dependencies, and unknown formats are skipped. PDFs will remain unsupported until Axiom has a real text-extraction pipeline.

## Architecture

Axiom has three main runtime pieces:

- `src/renderer` - React and React Flow desktop interface.
- `archd-go` - Go daemon responsible for indexing, parsing, persistence, HTTP APIs, and WebSocket updates.
- `mcp` - MCP server that translates agent requests into operations against the local daemon.

The Electron main process starts the desktop application and bundled daemon. By default, archd exposes its local HTTP API on port `7743` and WebSocket updates on port `7744`. Application data is stored beneath `~/.axiom`, with the primary database under `~/.axiom/data`.

More detailed references are available in [ARCHITECTURE.md](ARCHITECTURE.md), [CANVAS_BEHAVIOR_CONTRACT.md](CANVAS_BEHAVIOR_CONTRACT.md), and [MCP_SURFACE.md](MCP_SURFACE.md).

## Development setup

### Prerequisites

Every platform needs:

- Node.js - the version in [`.nvmrc`](.nvmrc). A version manager (`fnm`, `nvm`) will pick it up automatically.
- Go 1.22 or newer.
- Git.
- A C toolchain. `archd` uses CGO (`mattn/go-sqlite3`, `go-tree-sitter`) and the
  renderer depends on `better-sqlite3`, so both halves compile native code.

Then, per platform:

- **macOS** - Xcode Command Line Tools (`xcode-select --install`) supply the
  clang that CGO and node-gyp need. Go via `brew install go`.
- **Linux** - `build-essential` (or your distribution's equivalent) and Go.
- **Windows** - MSYS2 installed at `C:\msys64`, providing the MinGW64 Go 1.22
  and GCC toolchains. This one is not interchangeable: TDM-GCC produces broken
  binaries on Win11 26200. If MSYS2 lives elsewhere, point `AXIOM_MSYS2_BASH`
  at its `usr/bin/bash.exe`.

### Install and run

```bash
git clone https://github.com/maxwmeadow/Axiom.git
cd Axiom
npm install
npm run dev
```

`npm run dev` runs `predev`, which builds the `archd` daemon before starting
Electron through electron-vite. The daemon is named `archd.exe` on Windows and
`archd` elsewhere; the build scripts and the Electron main process both follow
the host, so the same commands work everywhere.

To build the daemon directly:

```bash
npm run build:archd
```

## Tests

```bash
# Renderer, MCP unit, and Electron unit tests
npm run test:renderer

# Go daemon tests
npm run test:archd

# MCP end-to-end tests
npm run test:mcp

# Electron and Playwright end-to-end tests
npm run test:e2e
```

Go commands can also be run directly from `archd-go` when the required Go and
CGO toolchain is already configured:

```bash
cd archd-go
go test ./...
```

## Packaging

```bash
npm run package
```

Artifacts land in `release/`. `prepackage` rebuilds the daemon first, and
electron-builder copies it into the application bundle through `extraResources`
so the packaged app can spawn it from `process.resourcesPath`.

A build only ever targets the host it runs on: neither the CGO daemon nor
`better-sqlite3` cross-compiles cleanly. Builds for every platform are produced
by [`.github/workflows/release.yml`](.github/workflows/release.yml), which
packages on Linux, Windows, and both Intel and Apple Silicon macOS runners.

## Useful development commands

```bash
npm run dev          # Build archd and launch Electron in development mode
npm run build        # Build Electron main, preload, and renderer bundles
npm run build:archd  # Build and smoke-test the Go daemon
npm run test:renderer
npm run test:archd
npm run test:mcp
npm run test:e2e
npm run package      # Build distributable application packages
```

When changing Go code, rebuild the bundled daemon with `npm run build:archd` before testing the desktop application.

### Troubleshooting

**`Cannot read properties of undefined (reading 'whenReady')` on `npm run dev`.**
Something in the environment has set `ELECTRON_RUN_AS_NODE=1`, which makes
Electron start as a plain Node process, leaving the `electron` module without
its APIs. VS Code's extension host sets it, so terminals and coding agents
launched from an extension can inherit it. Launch with `env -u
ELECTRON_RUN_AS_NODE npm run dev`, or use a terminal outside the editor.
