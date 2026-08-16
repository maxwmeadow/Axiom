"""TCP client - connects to archd's runtime adapter server.

Newline-delimited JSON over a localhost socket, stdlib only (no pip
dependencies inside the user's process). Three daemon threads:

- run loop: connect (with retry), then acts as the sender - drains the event
  queue, emitting a heartbeat when idle
- reader: dispatches watch/unwatch commands from archd
- (monitoring callbacks run on the app's own threads and only enqueue)

The event queue is bounded; when full, events are dropped rather than ever
blocking the target application. If archd goes away, monitoring is switched
off and the client reconnects in the background; archd re-sends the active
watch list in hello_ack.
"""

from __future__ import annotations

import json
import os
import queue
import socket
import sys
import threading
import time

RECONNECT_DELAY = 5.0
HEARTBEAT_IDLE = 5.0
QUEUE_MAX = 1000


class AxiomClient:
    def __init__(self, port: int, workspace_id: str, monitor, injector=None):
        self.port = port
        self.workspace_id = workspace_id
        self.monitor = monitor
        self.injector = injector
        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        self._sock: socket.socket | None = None
        self._dropped = 0
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="axiom-adapter", daemon=True).start()

    # Called from sys.monitoring callbacks - must be fast and never raise.
    def enqueue_event(self, event: dict) -> None:
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self._dropped += 1
        except Exception:
            pass

    # ── connection lifecycle ─────────────────────────────────────────────────

    def _run(self) -> None:
        while True:
            try:
                self._connect_and_pump()
            except Exception:
                pass
            finally:
                self._teardown()
            time.sleep(RECONNECT_DELAY)

    def _connect_and_pump(self) -> None:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        sock.settimeout(None)
        self._sock = sock
        self._send({
            "type": "hello",
            "language": "python",
            "pid": os.getpid(),
            "workspaceId": self.workspace_id,
            "cwd": os.getcwd(),
            "runtimeVersion": f"cpython {sys.version.split()[0]}",
        })
        threading.Thread(
            target=self._reader, args=(sock,), name="axiom-adapter-rx", daemon=True
        ).start()

        # Sender loop: forward events; heartbeat when idle.
        while self._sock is sock:
            try:
                event = self._queue.get(timeout=HEARTBEAT_IDLE)
            except queue.Empty:
                self._send({"type": "heartbeat"})
                continue
            self._send({"type": "event", "event": event})

    def _teardown(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        # archd is unreachable: stop paying for monitoring until reconnect.
        try:
            self.monitor.set_watches([])
        except Exception:
            pass

    def _send(self, obj: dict) -> None:
        sock = self._sock
        if sock is None:
            raise ConnectionError("not connected")
        data = json.dumps(obj, separators=(",", ":")).encode("utf-8") + b"\n"
        try:
            sock.sendall(data)
        except Exception:
            self._sock = None
            raise

    # ── inbound commands ─────────────────────────────────────────────────────

    def _reader(self, sock: socket.socket) -> None:
        try:
            with sock.makefile("r", encoding="utf-8") as f:
                for line in f:
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    self._dispatch(msg)
        except Exception:
            pass
        finally:
            if self._sock is sock:
                self._sock = None
            try:
                sock.close()
            except Exception:
                pass

    def _dispatch(self, msg: dict) -> None:
        try:
            mtype = msg.get("type")
            if mtype == "hello_ack":
                self.monitor.set_watches(msg.get("watches") or [])
            elif mtype == "watch":
                self.monitor.add_watch(msg["watch"])
            elif mtype == "unwatch":
                self.monitor.remove_watch(msg["watchId"])
            elif mtype == "inject" and self.injector is not None:
                self.injector.arm(msg["inject"])
            elif mtype == "uninject" and self.injector is not None:
                self.injector.remove(msg["injectId"])
            # unknown types are ignored
        except Exception:
            pass
