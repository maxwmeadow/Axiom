"""Defensive value serialization for runtime events.

Rules (mirrors RUNTIME_LAYER_PLAN "Large object serialization" mitigations):
- max depth 2 for containers, max 10 items per container
- strings truncated at 256 chars
- bytes reported as a size placeholder, never decoded
- arbitrary objects are reported by type name only - their __repr__ is NOT
  called (an ORM model's repr can lazy-load from the database inside the
  target process; a broken __repr__ would raise inside our hook)
- circular references detected by id()
Every entry is {"type": <type name>, "value": <short string>} per the plan's
wire schema. This function must never raise.
"""

from __future__ import annotations

MAX_STR = 256
MAX_ITEMS = 10
MAX_DEPTH = 2

_SAFE_ATOMS = (int, float, bool, complex, type(None))


def safe_value(value, depth: int = 0, seen: set | None = None) -> dict:
    """Serialize one value to {"type": ..., "value": ...}. Never raises."""
    try:
        return _safe_value(value, depth, seen if seen is not None else set())
    except Exception:
        return {"type": "unknown", "value": "<unserializable>"}


def _truncate(s: str) -> str:
    if len(s) > MAX_STR:
        return s[: MAX_STR - 1] + "…"
    return s


def _safe_value(value, depth: int, seen: set) -> dict:
    tname = type(value).__name__

    if isinstance(value, _SAFE_ATOMS):
        return {"type": tname, "value": repr(value)}
    if isinstance(value, str):
        return {"type": "str", "value": _truncate(repr(value))}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": tname, "value": f"[binary {len(value)} bytes]"}

    if isinstance(value, (list, tuple, set, frozenset, dict)):
        vid = id(value)
        if vid in seen:
            return {"type": tname, "value": "<circular>"}
        if depth >= MAX_DEPTH:
            try:
                size = len(value)
            except Exception:
                size = "?"
            return {"type": tname, "value": f"<{tname} len={size}>"}
        seen.add(vid)
        try:
            if isinstance(value, dict):
                items = []
                for i, (k, v) in enumerate(value.items()):
                    if i >= MAX_ITEMS:
                        items.append(f"… +{len(value) - MAX_ITEMS} more")
                        break
                    kk = _safe_value(k, depth + 1, seen)["value"]
                    vv = _safe_value(v, depth + 1, seen)["value"]
                    items.append(f"{kk}: {vv}")
                return {"type": "dict", "value": _truncate("{" + ", ".join(items) + "}")}
            items = []
            for i, v in enumerate(value):
                if i >= MAX_ITEMS:
                    items.append(f"… +{len(value) - MAX_ITEMS} more")
                    break
                items.append(_safe_value(v, depth + 1, seen)["value"])
            open_c, close_c = ("[", "]") if isinstance(value, list) else ("(", ")")
            return {"type": tname, "value": _truncate(open_c + ", ".join(items) + close_c)}
        finally:
            seen.discard(vid)

    # Arbitrary object: type name only; repr is deliberately not called.
    return {"type": tname, "value": f"<{tname}>"}


_CO_VARARGS = 0x04
_CO_VARKEYWORDS = 0x08


def serialize_args(code, frame_locals: dict) -> dict:
    """Extract and serialize the named parameters of a code object from its
    frame locals, including *args / **kwargs. Never raises."""
    try:
        nargs = code.co_argcount + code.co_kwonlyargcount
        names = list(code.co_varnames[:nargs])
        # *args and **kwargs slots follow the named parameters in co_varnames.
        extra = nargs
        if code.co_flags & _CO_VARARGS:
            names.append(code.co_varnames[extra])
            extra += 1
        if code.co_flags & _CO_VARKEYWORDS:
            names.append(code.co_varnames[extra])
        out = {}
        for name in names:
            if name == "self" or name == "cls":
                continue
            if name in frame_locals:
                out[name] = safe_value(frame_locals[name])
        return out
    except Exception:
        return {}
