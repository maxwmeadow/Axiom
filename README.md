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

- Claude Code
- Codex
- Cursor
- GitHub Copilot
- Windsurf
- Antigravity

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

The current repository development scripts are Windows-first and expect:

- Node.js and npm
- Git
- MSYS2 installed at `C:\msys64`
- The MSYS2 MinGW64 Go 1.22 toolchain
- The MSYS2 MinGW64 GCC toolchain for CGO and SQLite

Electron packaging targets also exist for macOS and Linux, but the checked-in archd build script currently assumes the Windows/MSYS2 environment above.

### Install and run

```powershell
git clone https://github.com/maxwmeadow/Axiom.git
cd Axiom
npm install
npm run dev
```

`npm run dev` runs `predev`, which builds `archd-go/archd.exe` before starting Electron through electron-vite.

To build the daemon directly:

```powershell
npm run build:archd
```

To create a production renderer build or packaged application:

```powershell
npm run build
npm run package
```

## Tests

```powershell
# Renderer, MCP unit, and Electron unit tests
npm run test:renderer

# Go daemon tests
npm run test:archd

# MCP end-to-end tests
npm run test:mcp

# Electron and Playwright end-to-end tests
npm run test:e2e
```

Go commands can also be run directly from `archd-go` when the required Go and CGO toolchain is already configured:

```powershell
cd archd-go
go test ./...
```

## Useful development commands

```powershell
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
