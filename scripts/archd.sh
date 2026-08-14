#!/usr/bin/env bash
# Go toolchain entry point for archd, run through MSYS2 bash.
#
# Two things this exists to get right:
#
#  1. The repo root is derived from this script's own location, never
#     hardcoded. Hardcoding it meant `npm run build:archd` inside a git
#     worktree silently built the *main* checkout instead — the worktree
#     would appear to build fine while testing someone else's code.
#
#  2. It runs without `bash --login`. A login shell resets the working
#     directory to $HOME, which is what forced the hardcoded path in the
#     first place. PATH is set explicitly below, so the login profile has
#     nothing left to contribute.
#
# MSYS2 specifically: TDM-GCC produces broken binaries on Win11 26200, so
# the mingw64 toolchain is not interchangeable here.
set -euo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]] && SCRIPT_DIR="."
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/archd-go"

export PATH="/mingw64/bin:/mingw64/lib/go/bin:$PATH"
export GOROOT="/mingw64/lib/go"
export GOPATH="${GOPATH:-$HOME/go}"
export CGO_ENABLED=1

case "${1:-build}" in
  build)
    go build -o archd.exe ./cmd/archd
    # A binary that cannot answer -h is not a successful build.
    ./archd.exe -h >/dev/null
    echo "Done — $ROOT/archd-go/archd.exe"
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
