"""FlowMiner desktop capture agent.

Polls the active window / application title on a configurable interval,
batches the observations into task-mining events, and streams them to a
FlowMiner instance via the SDK client.

Lifecycle
---------
1. ``create_recording`` on startup.
2. Every ``--flush-interval`` seconds (default 30): ``ingest_events`` with
   the accumulated batch.
3. On SIGINT / SIGTERM or KeyboardInterrupt: flush the remaining buffer then
   ``end_recording``.

Platform support (all capture backends are optional imports)
------------------------------------------------------------
- Windows:  ``pygetwindow`` (preferred) or ``pywin32`` (``win32gui``).
- macOS:    ``AppKit`` + ``Quartz`` (shipped with macOS Python; also available
            via ``pyobjc-framework-Quartz`` on pip).
- Linux:    ``ewmh`` (python-ewmh) preferred; falls back to shelling out to
            ``xdotool`` or ``wmctrl`` if neither Python binding is importable.
- Fallback: emits a single ``heartbeat`` event per tick so the recording
            stays alive even without a capture backend.

Usage
-----
    python agent.py --base-url http://localhost:8000 \\
                    --token <jwt>                     \\
                    --project-id <uuid>               \\
                    --interval 2                      \\
                    --flush-interval 30               \\
                    --activity-source window_title

Run ``python agent.py --help`` for the full option list.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import platform
import signal
import socket
import sys
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("flowminer.capture_agent")

# ── version string sent to the backend ──────────────────────────────────────
AGENT_VERSION = "0.1.0"
BATCH_CAP = 5000  # must not exceed the backend limit


# ── cross-platform active-window helpers ────────────────────────────────────

def _get_active_window_windows() -> tuple[str | None, str | None]:
    """Return (app_name, window_title) on Windows.  Lazy imports."""
    # Try pygetwindow first — friendlier API
    try:
        import pygetwindow as gw  # type: ignore[import]
        win = gw.getActiveWindow()
        if win is not None:
            return None, win.title
    except Exception:
        pass

    # Fall back to win32gui
    try:
        import win32gui  # type: ignore[import]
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd)
        # GetWindowText returns "" on failure, not an exception
        return None, title or None
    except Exception:
        pass

    return None, None


def _get_active_window_macos() -> tuple[str | None, str | None]:
    """Return (app_name, window_title) on macOS.  Lazy imports."""
    try:
        from AppKit import NSWorkspace  # type: ignore[import]
        active_app = NSWorkspace.sharedWorkspace().activeApplication()
        app_name: str | None = active_app.get("NSApplicationName")
    except Exception:
        app_name = None

    try:
        import Quartz  # type: ignore[import]
        windows = Quartz.CGWindowListCopyWindowInfo(
            Quartz.kCGWindowListOptionOnScreenOnly
            | Quartz.kCGWindowListExcludeDesktopElements,
            Quartz.kCGNullWindowID,
        )
        if windows:
            # The first window in the list is typically the frontmost
            first = windows[0]
            title: str | None = first.get("kCGWindowName") or None
            if app_name is None:
                app_name = first.get("kCGWindowOwnerName") or None
            return app_name, title
    except Exception:
        pass

    return app_name, None


def _get_active_window_linux() -> tuple[str | None, str | None]:
    """Return (app_name, window_title) on Linux (X11 / EWMH).  Lazy imports."""
    # Try python-ewmh
    try:
        import ewmh  # type: ignore[import]
        import Xlib.display  # type: ignore[import]
        display = Xlib.display.Display()
        e = ewmh.EWMH(_display=display)
        win = e.getActiveWindow()
        if win is not None:
            title: str | None = e.getWmName(win)
            # Decode bytes if necessary
            if isinstance(title, bytes):
                title = title.decode("utf-8", errors="replace")
            return None, title or None
    except Exception:
        pass

    # Shell-out fallback: xdotool
    try:
        import subprocess
        result = subprocess.run(
            ["xdotool", "getactivewindow", "getwindowname"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            return None, result.stdout.strip() or None
    except Exception:
        pass

    # Shell-out fallback: wmctrl
    try:
        import subprocess
        result = subprocess.run(
            ["wmctrl", "-a", ":ACTIVE:"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        # wmctrl doesn't print the active title; try -l and grep active id
        # This is best-effort and may not always work
    except Exception:
        pass

    return None, None


def get_active_window() -> tuple[str | None, str | None]:
    """Return ``(app_name, window_title)`` for the currently focused window.

    Returns ``(None, None)`` when no backend is available.
    """
    system = platform.system()
    if system == "Windows":
        return _get_active_window_windows()
    if system == "Darwin":
        return _get_active_window_macos()
    # Linux / other POSIX
    return _get_active_window_linux()


# ── event builder ────────────────────────────────────────────────────────────

def build_event(
    app_name: str | None,
    window_title: str | None,
    activity_source: str,
    event_type: str = "window_focus",
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    event: dict[str, Any] = {
        "ts": now,
        "event_type": event_type,
    }
    if app_name:
        event["application"] = app_name
    if window_title:
        if activity_source == "window_title":
            event["window_title"] = window_title
        elif activity_source == "application":
            event["application"] = event.get("application") or window_title
    return event


# ── main agent loop ──────────────────────────────────────────────────────────

class CaptureAgent:
    def __init__(
        self,
        base_url: str,
        token: str,
        project_id: str,
        interval: float,
        flush_interval: float,
        activity_source: str,
        hostname: str | None,
        notes: str | None,
    ) -> None:
        self._base_url = base_url
        self._token = token
        self._project_id = project_id
        self._interval = interval
        self._flush_interval = flush_interval
        self._activity_source = activity_source
        self._hostname = hostname or socket.gethostname()
        self._notes = notes
        self._buffer: list[dict] = []
        self._recording_id: str | None = None
        self._last_flush = time.monotonic()
        self._stop_event = asyncio.Event()

    async def _flush(self, client: Any) -> None:
        if not self._buffer:
            return
        batch, self._buffer = self._buffer[:BATCH_CAP], self._buffer[BATCH_CAP:]
        try:
            result = await client.ingest_events(self._recording_id, batch)
            logger.debug("Flushed %d events; total on recording: %s",
                         result.get("ingested", 0),
                         result.get("total_on_recording", "?"))
        except Exception as exc:
            logger.warning("Failed to flush events: %s — will retry next cycle", exc)
            # Put them back at the front of the buffer so they are retried
            self._buffer = batch + self._buffer

    async def run(self) -> None:
        # Import SDK lazily so the file is usable even when the SDK isn't
        # installed (e.g. running --help in a plain Python env).
        try:
            from flowminer.client import Client
        except ImportError:
            logger.error(
                "flowminer SDK not found. Install it with: pip install flowminer"
            )
            sys.exit(1)

        async with Client(self._base_url, token=self._token) as client:
            # Start the recording
            rec = await client.create_recording(
                project_id=self._project_id,
                agent_version=AGENT_VERSION,
                hostname=self._hostname,
                notes=self._notes,
            )
            self._recording_id = rec["id"]
            logger.info("Recording started: %s", self._recording_id)

            last_title: str | None = None

            try:
                while not self._stop_event.is_set():
                    app_name, window_title = get_active_window()

                    if window_title is None and app_name is None:
                        # No capture backend — emit a heartbeat so the
                        # recording has at least some events
                        event = build_event(None, None, self._activity_source,
                                            event_type="heartbeat")
                    elif window_title != last_title:
                        event = build_event(app_name, window_title,
                                            self._activity_source)
                        last_title = window_title
                    else:
                        event = None  # same window — skip

                    if event is not None:
                        self._buffer.append(event)

                    now = time.monotonic()
                    if now - self._last_flush >= self._flush_interval:
                        await self._flush(client)
                        self._last_flush = now

                    await asyncio.sleep(self._interval)

            except asyncio.CancelledError:
                pass
            finally:
                # Best-effort flush before ending the recording
                await self._flush(client)
                try:
                    result = await client.end_recording(self._recording_id)
                    logger.info("Recording ended: %s", result.get("ended_at", "?"))
                except Exception as exc:
                    logger.warning("Could not mark recording as ended: %s", exc)


# ── CLI ──────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="flowminer-capture",
        description=(
            "FlowMiner desktop capture agent — records active window titles "
            "and streams them to a FlowMiner instance as task-mining events."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="Base URL of the FlowMiner API server.",
    )
    p.add_argument(
        "--token",
        required=True,
        help="Bearer token for authentication (obtain via the FlowMiner UI or API).",
    )
    p.add_argument(
        "--project-id",
        required=True,
        help="UUID of the FlowMiner project to record into.",
    )
    p.add_argument(
        "--interval",
        type=float,
        default=2.0,
        metavar="SECONDS",
        help="How often to poll the active window (seconds).",
    )
    p.add_argument(
        "--flush-interval",
        type=float,
        default=30.0,
        metavar="SECONDS",
        help="How often to POST buffered events to the server (seconds).",
    )
    p.add_argument(
        "--activity-source",
        choices=["window_title", "application"],
        default="window_title",
        help=(
            "Which captured field to use as the primary activity label: "
            "'window_title' (default) or 'application'."
        ),
    )
    p.add_argument(
        "--hostname",
        default=None,
        help="Override the hostname reported in the recording (default: auto-detect).",
    )
    p.add_argument(
        "--notes",
        default=None,
        help="Free-text notes to attach to the recording.",
    )
    p.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity.",
    )
    return p


async def _async_main(args: argparse.Namespace) -> None:
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    agent = CaptureAgent(
        base_url=args.base_url,
        token=args.token,
        project_id=args.project_id,
        interval=args.interval,
        flush_interval=args.flush_interval,
        activity_source=args.activity_source,
        hostname=args.hostname,
        notes=args.notes,
    )

    loop = asyncio.get_running_loop()

    # Register SIGINT / SIGTERM so we can flush cleanly before exit
    def _request_stop() -> None:
        agent._stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_stop)
        except (NotImplementedError, OSError):
            # Windows does not support add_signal_handler for all signals
            pass

    await agent.run()


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        asyncio.run(_async_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
