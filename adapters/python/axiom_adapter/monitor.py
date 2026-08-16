"""sys.monitoring (PEP 669) integration - streaming mode.

Watched functions are matched by (absolute file path, symbol name, line range)
against each code object's co_filename / co_name / co_firstlineno. Name AND
line-range containment must both hold, which survives decorator wrapping and
disambiguates nested defs; if the index is stale (file edited since last parse)
a name-only fallback still matches.

The hot path relies on sys.monitoring's per-location DISABLE: the PY_START
callback returns DISABLE for every non-watched code object, so after warm-up
unwatched code runs at native speed. When the watch set changes,
restart_events() re-arms everything.

Rate limiting: a watch exceeding MAX_CALLS_PER_SEC is disabled adapter-side
and a single 'rate_limit' event is emitted (plan: "Event flooding" mitigation).
"""

from __future__ import annotations

import contextvars
import os
import sys
import threading
import time
import uuid

from .serialize import safe_value, serialize_args

MAX_CALLS_PER_SEC = 100

# Stack of active watched calls in the current execution context:
# tuple of (watch_id, trace_id, start_perf_ns). contextvars propagate across
# `await` boundaries, giving async-correct parent/child trace linkage.
_call_stack: contextvars.ContextVar[tuple] = contextvars.ContextVar(
    "axiom_call_stack", default=()
)

# Set by an injection wrapper (inject.py) for the duration of the perturbed
# call - stamps every event in the perturbed subtree with the injection id so
# the canvas can color downstream paths green/red.
_active_inject: contextvars.ContextVar[str] = contextvars.ContextVar(
    "axiom_active_inject", default=""
)


def _norm(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _parse_watch(w: dict) -> "_Watch":
    return _Watch(
        id=w["id"],
        abs_path=w.get("absPath") or w.get("relPath", ""),
        symbol=w["symbol"],
        line_start=int(w.get("lineStart", 0)),
        line_end=int(w.get("lineEnd", 0)),
    )


class _Watch:
    __slots__ = (
        "id", "abs_path", "symbol", "line_start", "line_end",
        "disabled", "win_start", "win_count",
    )

    def __init__(self, id: str, abs_path: str, symbol: str, line_start: int, line_end: int):
        self.id = id
        self.abs_path = _norm(abs_path)
        self.symbol = symbol
        self.line_start = line_start
        self.line_end = line_end
        self.disabled = False
        self.win_start = 0.0
        self.win_count = 0


class Monitor:
    """Owns the sys.monitoring tool registration and the watch table."""

    def __init__(self):
        self.emit = None  # set by init(): callable(event_dict)
        self._lock = threading.Lock()
        # Copy-on-write: mutation paths build NEW dicts and swap the
        # references atomically (a single store, safe under CPython), so the
        # hot-path callbacks read self._files without taking any lock.
        self._watches: dict[str, _Watch] = {}
        self._files: dict[str, list[_Watch]] = {}  # normalized path → watches
        self._tool_id: int | None = None
        self._events_on = False

    # ── watch table (called from the client reader thread) ──────────────────

    def set_watches(self, watches: list[dict]) -> None:
        with self._lock:
            self._rebuild_locked([_parse_watch(w) for w in watches])
            self._sync_events_locked()

    def add_watch(self, w: dict) -> None:
        new = _parse_watch(w)
        with self._lock:
            kept = [
                x for x in self._watches.values()
                if not (x.abs_path == new.abs_path and x.symbol == new.symbol)
            ]
            self._rebuild_locked(kept + [new])
            self._sync_events_locked()

    def remove_watch(self, watch_id: str) -> None:
        with self._lock:
            kept = [x for x in self._watches.values() if x.id != watch_id]
            self._rebuild_locked(kept)
            self._sync_events_locked()

    def _rebuild_locked(self, watches: list[_Watch]) -> None:
        new_watches: dict[str, _Watch] = {}
        new_files: dict[str, list[_Watch]] = {}
        for w in watches:
            new_watches[w.id] = w
            new_files.setdefault(w.abs_path, []).append(w)
        self._watches = new_watches
        self._files = new_files

    # ── sys.monitoring plumbing ──────────────────────────────────────────────

    def _acquire_tool_locked(self) -> bool:
        if self._tool_id is not None:
            return True
        mon = sys.monitoring
        # Never take DEBUGGER_ID - the user's IDE debugger keeps working.
        for tid in (mon.OPTIMIZER_ID, mon.PROFILER_ID, mon.COVERAGE_ID):
            try:
                mon.use_tool_id(tid, "axiom")
                self._tool_id = tid
                break
            except ValueError:
                continue
        if self._tool_id is None:
            print("[axiom] no free sys.monitoring tool id - watches disabled", file=sys.stderr)
            return False
        mon.register_callback(self._tool_id, mon.events.PY_START, self._on_start)
        mon.register_callback(self._tool_id, mon.events.PY_RETURN, self._on_return)
        mon.register_callback(self._tool_id, mon.events.PY_UNWIND, self._on_unwind)
        return True

    def _sync_events_locked(self) -> None:
        mon = sys.monitoring
        want = bool(self._files)
        if want and not self._acquire_tool_locked():
            return
        if self._tool_id is None:
            return
        if want:
            mon.set_events(
                self._tool_id,
                mon.events.PY_START | mon.events.PY_RETURN | mon.events.PY_UNWIND,
            )
            # Re-arm locations previously returned DISABLE so new watches fire.
            mon.restart_events()
            self._events_on = True
        elif self._events_on:
            mon.set_events(self._tool_id, 0)
            self._events_on = False

    # ── matching ─────────────────────────────────────────────────────────────

    def _match(self, code) -> _Watch | None:
        files = self._files  # snapshot the reference; table swaps are atomic
        bucket = files.get(_norm(code.co_filename))
        if not bucket:
            return None
        name = code.co_name
        line = code.co_firstlineno
        fallback = None
        for w in bucket:
            if w.symbol != name:
                continue
            if w.line_start <= line <= max(w.line_end, w.line_start):
                return w
            fallback = w  # stale index: right name, drifted lines
        return fallback

    # ── callbacks (hot path) ─────────────────────────────────────────────────

    def _on_start(self, code, instruction_offset):
        w = self._match(code)
        if w is None or w.disabled:
            return sys.monitoring.DISABLE
        emit = self.emit
        if emit is None:
            return sys.monitoring.DISABLE

        # Sliding-window rate limiter.
        now = time.monotonic()
        if now - w.win_start >= 1.0:
            w.win_start = now
            w.win_count = 0
        w.win_count += 1
        if w.win_count > MAX_CALLS_PER_SEC:
            w.disabled = True
            emit({
                "kind": "rate_limit",
                "watchId": w.id,
                "ts": int(time.time() * 1000),
                "message": f"exceeded {MAX_CALLS_PER_SEC} calls/sec - watch auto-disabled",
            })
            return sys.monitoring.DISABLE

        trace_id = uuid.uuid4().hex[:12]
        stack = _call_stack.get()
        parent_id = stack[-1][1] if stack else ""
        # Cap the stack: abandoned generators/coroutines leave entries behind
        # (their PY_RETURN never fires); don't let them grow the tuple forever.
        if len(stack) >= 64:
            stack = stack[-32:]
        _call_stack.set(stack + ((w.id, trace_id, time.perf_counter_ns()),))

        try:
            frame = sys._getframe(1)
            args = serialize_args(code, frame.f_locals)
        except Exception:
            args = {}

        emit({
            "kind": "call",
            "watchId": w.id,
            "traceId": trace_id,
            "parentTraceId": parent_id,
            "injectId": _active_inject.get(),
            "threadId": str(threading.get_ident()),
            "ts": int(time.time() * 1000),
            "args": args,
        })
        return None

    def _on_return(self, code, instruction_offset, retval):
        w = self._match(code)
        if w is None or w.disabled:
            return sys.monitoring.DISABLE
        emit = self.emit
        if emit is None:
            return sys.monitoring.DISABLE

        trace_id, duration_ms = self._pop_call(w)
        emit({
            "kind": "return",
            "watchId": w.id,
            "traceId": trace_id,
            "injectId": _active_inject.get(),
            "threadId": str(threading.get_ident()),
            "ts": int(time.time() * 1000),
            "returnValue": safe_value(retval),
            "durationMs": duration_ms,
        })
        return None

    def _on_unwind(self, code, instruction_offset, exception):
        # PY_UNWIND cannot be per-location disabled; filter fast and return.
        w = self._match(code)
        if w is None or w.disabled or self.emit is None:
            return
        trace_id, duration_ms = self._pop_call(w)
        try:
            message = str(exception)
        except Exception:
            message = "<unprintable exception>"
        self.emit({
            "kind": "exception",
            "watchId": w.id,
            "traceId": trace_id,
            "injectId": _active_inject.get(),
            "threadId": str(threading.get_ident()),
            "ts": int(time.time() * 1000),
            "excType": type(exception).__name__,
            "message": message[:512],
        })

    def _pop_call(self, w: _Watch) -> tuple[str, float]:
        """Pop this watch's most recent entry from the context call stack;
        returns (traceId, durationMs). Searches from the top so a suspended
        generator/coroutine entry sitting mid-stack (its return fires out of
        LIFO order) still resolves to the right trace. For generators the
        duration includes suspended time - it is wall time, not CPU time."""
        stack = _call_stack.get()
        for i in range(len(stack) - 1, -1, -1):
            if stack[i][0] == w.id:
                _, trace_id, start_ns = stack[i]
                _call_stack.set(stack[:i] + stack[i + 1:])
                return trace_id, (time.perf_counter_ns() - start_ns) / 1e6
        return "", 0.0
