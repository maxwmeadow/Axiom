"""Value injection (perturbation) - the proxy-wrapper pattern.

Instead of mutating frame locals from a monitoring callback (impossible pre-
PEP 667), the target function OBJECT is temporarily replaced with a wrapper
that overrides one named parameter, calls the original, and (for one-shot
injections) unwraps itself after the first call.

Aliasing: `from validators import validate_amount` gives the importing module
its own reference, so rebinding only the defining module would miss most real
call sites. Every module attribute in sys.modules that IS the original
function object is rebound (and restored afterwards); methods are rebound on
their class.

Safety (plan §Safe Perturbation, revised):
- values must be JSON primitives or flat list/dict of primitives - anything
  else is refused at arm time with an inject_error event
- the parameter must exist in the function signature (checked at arm time)
- one-shot by default; the wrapper restores all bindings before invoking the
  original so recursion or concurrent calls see the injection at most once
- the wrapper never raises on adapter bugs - worst case it calls through

Correlation: while the injected call runs, a contextvar carries the injection
id; the Monitor stamps it onto call/return/exception events so the canvas can
color the downstream path green (clean return) or red (exception).
"""

from __future__ import annotations

import functools
import inspect
import os
import sys
import threading
import time

from .monitor import _active_inject, _norm
from .serialize import safe_value

_ALLOWED_ATOMS = (int, float, str, bool, type(None))
_MAX_STR_VALUE = 10_000


def _validate_value(v) -> bool:
    """Only shallow, plain data may be injected."""
    if isinstance(v, str):
        return len(v) <= _MAX_STR_VALUE
    if isinstance(v, _ALLOWED_ATOMS):
        return True
    if isinstance(v, list):
        return all(isinstance(x, _ALLOWED_ATOMS) and _validate_value(x) for x in v)
    if isinstance(v, dict):
        return all(
            isinstance(k, str) and isinstance(x, _ALLOWED_ATOMS) and _validate_value(x)
            for k, x in v.items()
        )
    return False


def _unwrap_code(obj):
    """The code object behind a function/method/decorated callable, or None."""
    try:
        if isinstance(obj, (staticmethod, classmethod)):
            obj = obj.__func__
        fn = inspect.unwrap(obj)
        return getattr(fn, "__code__", None)
    except Exception:
        return None


def _loaded_modules() -> list:
    """Snapshot sys.modules defensively - another thread importing during
    list() can raise 'dictionary changed size during iteration'."""
    for _ in range(3):
        try:
            return list(sys.modules.values())
        except RuntimeError:
            continue
    return []


def _module_vars(mod) -> dict:
    for _ in range(3):
        try:
            return dict(vars(mod))
        except RuntimeError:
            continue
        except TypeError:
            return {}
    return {}


def _find_target(abs_path: str, symbol: str, line_start: int, line_end: int):
    """Locate the function object defined at (file, symbol, line range).
    Returns the attribute as stored (possibly a staticmethod/classmethod
    descriptor) or None. Searches module globals first, then class bodies
    within modules defined in that file."""
    want = _norm(abs_path)
    for mod in _loaded_modules():
        try:
            mod_file = getattr(mod, "__file__", None)
            if not mod_file or _norm(mod_file) != want:
                continue
            candidates = list(_module_vars(mod).items())
            for _, obj in list(candidates):
                if isinstance(obj, type):
                    candidates.extend(_module_vars(obj).items())
            for _, obj in candidates:
                code = _unwrap_code(obj)
                if code is None or code.co_name != symbol:
                    continue
                if line_start <= code.co_firstlineno <= max(line_end, line_start):
                    return obj
        except Exception:
            continue
    return None


def _rebind_everywhere(original, replacement) -> list:
    """Replace every reference to `original` reachable as a module attribute
    or class attribute (in any loaded module). Returns [(owner, name), ...]
    for restoration."""
    bound = []
    for mod in _loaded_modules():
        mod_vars = _module_vars(mod)
        for name, val in mod_vars.items():
            if val is original:
                try:
                    setattr(mod, name, replacement)
                    bound.append((mod, name))
                except Exception:
                    pass
            elif isinstance(val, type):
                for aname, aval in _module_vars(val).items():
                    if aval is original:
                        try:
                            setattr(val, aname, replacement)
                            bound.append((val, aname))
                        except Exception:
                            pass
    return bound


class Injector:
    """Owns active injections. All methods are called from the client reader
    thread; the wrappers run on application threads."""

    def __init__(self):
        self.emit = None  # set by init()
        self._lock = threading.Lock()
        self._active: dict[str, dict] = {}  # injectId → {original, bound, spec}

    def _emit(self, event: dict) -> None:
        emit = self.emit
        if emit is not None:
            try:
                emit(event)
            except Exception:
                pass

    def _error(self, inject_id: str, message: str) -> None:
        self._emit({
            "kind": "inject_error",
            "injectId": inject_id,
            "ts": int(time.time() * 1000),
            "message": message,
        })

    def arm(self, spec: dict) -> None:
        try:
            self._arm(spec)
        except Exception as exc:
            self._error(spec.get("id", "?"), f"arm failed: {exc!r}")

    def _arm(self, spec: dict) -> None:
        inject_id = spec["id"]
        symbol = spec["symbol"]
        param = spec["paramName"]
        value = spec.get("value")

        if not _validate_value(value):
            self._error(inject_id, f"value of type {type(value).__name__} refused - "
                        "only primitives or flat list/dict of primitives can be injected")
            return

        original = _find_target(
            spec.get("absPath") or spec.get("relPath", ""),
            symbol,
            int(spec.get("lineStart", 0)),
            int(spec.get("lineEnd", 0)),
        )
        if original is None:
            self._error(inject_id, f"function {symbol!r} not found in loaded modules - "
                        "is the module imported yet?")
            return

        # staticmethod/classmethod descriptors: call through the underlying
        # function and re-wrap the replacement in the same descriptor so
        # attribute binding semantics are preserved.
        desc_type = type(original) if isinstance(original, (staticmethod, classmethod)) else None
        call_target = original.__func__ if desc_type is not None else original

        try:
            sig = inspect.signature(inspect.unwrap(call_target))
        except Exception as exc:
            self._error(inject_id, f"cannot inspect signature of {symbol!r}: {exc!r}")
            return
        if param not in sig.parameters:
            self._error(inject_id, f"parameter {param!r} not found on {symbol!r} "
                        f"(has: {', '.join(sig.parameters)})")
            return

        once = bool(spec.get("once", True))
        injector = self

        def consume() -> bool:
            """True exactly when this call should be perturbed. One-shot
            injections restore all bindings before the perturbed call runs, so
            recursion or concurrent calls see the injection at most once."""
            with injector._lock:
                entry = injector._active.get(inject_id)
                if entry is None or entry["consumed"]:
                    return False
                if once:
                    entry["consumed"] = True
                    injector._restore_locked(inject_id)
                return True

        def perturb(args, kwargs):
            ba = sig.bind(*args, **kwargs)
            ba.apply_defaults()
            original_value = ba.arguments.get(param)
            ba.arguments[param] = value
            injector._emit({
                "kind": "inject_fired",
                "injectId": inject_id,
                "ts": int(time.time() * 1000),
                "original": safe_value(original_value),
                "injected": safe_value(value),
            })
            if once:
                injector._emit({
                    "kind": "inject_removed",
                    "injectId": inject_id,
                    "ts": int(time.time() * 1000),
                })
            return ba.args, ba.kwargs

        # The wrapper flavor must match the target: for async/generator
        # functions the body executes lazily, so the correlation contextvar
        # has to be set inside the coroutine/generator, not around its
        # construction.
        if inspect.iscoroutinefunction(call_target):
            @functools.wraps(call_target)
            async def wrapper(*args, **kwargs):
                if not consume():
                    return await call_target(*args, **kwargs)
                try:
                    new_args, new_kwargs = perturb(args, kwargs)
                except Exception as exc:
                    injector._error(inject_id, f"could not bind arguments: {exc!r}")
                    return await call_target(*args, **kwargs)
                token = _active_inject.set(inject_id)
                try:
                    return await call_target(*new_args, **new_kwargs)
                finally:
                    _active_inject.reset(token)
        elif inspect.isgeneratorfunction(call_target):
            @functools.wraps(call_target)
            def wrapper(*args, **kwargs):
                if not consume():
                    yield from call_target(*args, **kwargs)
                    return
                try:
                    new_args, new_kwargs = perturb(args, kwargs)
                except Exception as exc:
                    injector._error(inject_id, f"could not bind arguments: {exc!r}")
                    yield from call_target(*args, **kwargs)
                    return
                token = _active_inject.set(inject_id)
                try:
                    yield from call_target(*new_args, **new_kwargs)
                finally:
                    _active_inject.reset(token)
        else:
            @functools.wraps(call_target)
            def wrapper(*args, **kwargs):
                if not consume():
                    return call_target(*args, **kwargs)
                try:
                    new_args, new_kwargs = perturb(args, kwargs)
                except Exception as exc:
                    injector._error(inject_id, f"could not bind arguments: {exc!r}")
                    return call_target(*args, **kwargs)
                token = _active_inject.set(inject_id)
                try:
                    return call_target(*new_args, **new_kwargs)
                finally:
                    _active_inject.reset(token)

        replacement = desc_type(wrapper) if desc_type is not None else wrapper
        bound = _rebind_everywhere(original, replacement)
        if not bound:
            self._error(inject_id, f"found {symbol!r} but could not rebind any reference")
            return

        with self._lock:
            self._active[inject_id] = {
                "original": original,
                "bound": bound,
                "consumed": False,
            }
        self._emit({
            "kind": "inject_armed",
            "injectId": inject_id,
            "ts": int(time.time() * 1000),
        })

    def remove(self, inject_id: str) -> None:
        with self._lock:
            entry = self._active.get(inject_id)
            already_fired = entry is not None and entry["consumed"]
            self._restore_locked(inject_id)
        # inject_removed was already emitted by the wrapper for a fired one-shot
        if entry is not None and not already_fired:
            self._emit({
                "kind": "inject_removed",
                "injectId": inject_id,
                "ts": int(time.time() * 1000),
            })

    def _restore_locked(self, inject_id: str) -> None:
        entry = self._active.pop(inject_id, None)
        if entry is None:
            return
        for owner, name in entry["bound"]:
            try:
                setattr(owner, name, entry["original"])
            except Exception:
                pass
