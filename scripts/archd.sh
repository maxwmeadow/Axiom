#!/usr/bin/env bash
# Go toolchain entry point for archd. Invoked via scripts/archd.mjs, which
# picks the right bash for the platform.
#
# Three things this exists to get right:
#
#  1. The repo root is derived from this script's own location, never
#     hardcoded. Hardcoding it meant `npm run build:archd` inside a git
#     worktree silently built the *main* checkout instead - the worktree
#     would appear to build fine while testing someone else's code.
#
#  2. It runs without `bash --login`. A login shell resets the working
#     directory to $HOME, which is what forced the hardcoded path in the
#     first place. PATH is set explicitly below, so the login profile has
#     nothing left to contribute.
#
#  3. The toolchain is located per-platform. On Windows that means MSYS2
#     specifically: TDM-GCC produces broken binaries on Win11 26200, so the
#     mingw64 toolchain is not interchangeable there. On macOS and Linux the
#     Go on PATH is used, and CGO is satisfied by the system clang/gcc -
#     Xcode Command Line Tools on macOS, build-essential on Linux.
set -euo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]] && SCRIPT_DIR="."
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/archd-go"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    export PATH="/mingw64/bin:/mingw64/lib/go/bin:$PATH"
    # Prefer MSYS2's own Go when it is installed, per the note above. CI
    # installs Go separately and only needs /mingw64/bin on PATH for CGO's gcc,
    # so pinning GOROOT unconditionally would point at a directory not present.
    if [[ -d /mingw64/lib/go ]]; then
      export GOROOT="/mingw64/lib/go"
    fi
    BIN="archd.exe"
    ;;
  *)
    # Go from PATH; GOROOT is whatever that toolchain reports, so leave it unset.
    BIN="archd"
    ;;
esac

export GOPATH="${GOPATH:-$HOME/go}"
export CGO_ENABLED=1

if ! command -v go >/dev/null 2>&1; then
  echo "archd: no 'go' on PATH. Install Go 1.22 or newer." >&2
  exit 1
fi

case "${1:-build}" in
  build)
    go build -o "$BIN" ./cmd/archd
    # A binary that cannot answer -h is not a successful build.
    "./$BIN" -h >/dev/null
    echo "Done - $ROOT/archd-go/$BIN"
    ;;
  test)
    shift
    go test ./... "$@"
    ;;
  vet)
    go vet ./...
    ;;
  dbquery)
    shift
    go run ./cmd/dbquery/main.go -db "${AXIOM_DB_PATH:-$HOME/.axiom/data/axiom.db}" "$@"
    ;;
  *)
    echo "usage: archd.sh [build|test|vet|dbquery]" >&2
    exit 2
    ;;
esac
