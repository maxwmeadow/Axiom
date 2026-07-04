"""Axiom auto-bootstrap.

CPython's site module imports `sitecustomize` automatically at interpreter
startup. When Axiom launches a target app (or the user opts in by putting this
directory on PYTHONPATH), the presence of AXIOM_RUNTIME_PORT activates the
adapter. Without that variable this module does nothing, so leaving the
directory on PYTHONPATH permanently is harmless.

If the user's environment has its own sitecustomize elsewhere on sys.path,
ours shadows it (Python imports only the first). We chain-load the next one
found so existing setups keep working.
"""

import os
import sys


def _bootstrap() -> None:
    if os.environ.get("AXIOM_RUNTIME_PORT") or os.environ.get("AXIOM_WORKSPACE_ID"):
        try:
            import axiom_adapter
            axiom_adapter.init()
        except Exception:
            pass


def _chain_next_sitecustomize() -> None:
    """Execute the next sitecustomize.py on sys.path (shadowed by this one)."""
    try:
        here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
        for entry in sys.path:
            if not entry:
                continue
            try:
                if os.path.normcase(os.path.abspath(entry)) == here:
                    continue
                candidate = os.path.join(entry, "sitecustomize.py")
                if os.path.isfile(candidate):
                    import runpy
                    result = runpy.run_path(candidate, run_name="sitecustomize")
                    # Expose the chained module's names on THIS module —
                    # code doing `import sitecustomize; sitecustomize.x`
                    # gets our module object, so merge theirs in.
                    for k, v in result.items():
                        if not k.startswith("__"):
                            globals()[k] = v
                    return
            except Exception:
                continue
    except Exception:
        pass


_bootstrap()
_chain_next_sitecustomize()
