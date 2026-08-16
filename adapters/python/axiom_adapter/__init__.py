"""Axiom Python runtime adapter.

Streams function call/return/exception events from a running Python app to the
Axiom daemon (archd) over a local TCP socket, using sys.monitoring (PEP 669)
for near-zero overhead. Loaded one of three ways, all without modifying the
target codebase:

1. Launched by Axiom (``launch_target`` MCP tool) - archd injects PYTHONPATH +
   AXIOM_RUNTIME_PORT / AXIOM_WORKSPACE_ID and sitecustomize auto-initializes.
2. ``python -m axiom_adapter run app.py`` - explicit launcher.
3. PYTHONPATH opt-in - user points PYTHONPATH at this directory once; the
   adapter activates whenever AXIOM_RUNTIME_PORT is present in the environment.

Requires Python 3.12+. On older interpreters init() is a silent no-op (one
warning line on stderr) - the target app is never broken by the adapter.
"""

from __future__ import annotations

import os
import sys

__version__ = "0.1.0"

_state: dict = {"client": None, "monitor": None}


def init() -> bool:
    """Initialize the adapter. Idempotent, never raises."""
    if _state["client"] is not None:
        return True
    try:
        if sys.version_info < (3, 12):
            print(
                f"[axiom] Python {sys.version_info.major}.{sys.version_info.minor} "
                "is not supported (need 3.12+ for sys.monitoring) - adapter disabled",
                file=sys.stderr,
            )
            return False

        from .client import AxiomClient
        from .inject import Injector
        from .monitor import Monitor

        port = int(os.environ.get("AXIOM_RUNTIME_PORT", "7745"))
        workspace_id = os.environ.get("AXIOM_WORKSPACE_ID", "")

        monitor = Monitor()
        injector = Injector()
        client = AxiomClient(port=port, workspace_id=workspace_id, monitor=monitor, injector=injector)
        monitor.emit = client.enqueue_event
        injector.emit = client.enqueue_event
        client.start()

        _state["client"] = client
        _state["monitor"] = monitor
        _state["injector"] = injector
        return True
    except Exception as exc:  # never break the target app
        try:
            print(f"[axiom] adapter init failed: {exc!r} - disabled", file=sys.stderr)
        except Exception:
            pass
        return False
