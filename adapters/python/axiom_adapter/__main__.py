"""Launcher: run a Python program with the Axiom adapter pre-loaded.

    python -m axiom_adapter run app.py [args...]
    python -m axiom_adapter run -m mypackage.server [args...]

The target runs in THIS process (via runpy) with sys.argv rewritten, so it
behaves exactly as if launched directly — no subprocess, no code changes.
"""

from __future__ import annotations

import runpy
import sys

USAGE = (
    "usage: python -m axiom_adapter run <script.py> [args...]\n"
    "       python -m axiom_adapter run -m <module> [args...]"
)


def main() -> None:
    argv = sys.argv[1:]
    if len(argv) < 2 or argv[0] != "run":
        print(USAGE, file=sys.stderr)
        sys.exit(2)
    argv = argv[1:]

    import axiom_adapter
    axiom_adapter.init()

    if argv[0] == "-m":
        if len(argv) < 2:
            print(USAGE, file=sys.stderr)
            sys.exit(2)
        module, rest = argv[1], argv[2:]
        sys.argv = [module] + rest
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    else:
        script, rest = argv[0], argv[1:]
        sys.argv = [script] + rest
        runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
