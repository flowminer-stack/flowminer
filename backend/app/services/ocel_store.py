"""
Process-wide in-memory OCEL store and OCEL file-reading helpers.

This module owns the SINGLE module-level OCEL store singleton that the OCPM
router, the demo seeder, and the event-logs router all share. It must be
imported (never re-instantiated) so that the demo warm-up and later queries
see the same parsed OCEL objects. Splitting this out of ``app.api.ocel``
keeps shared state in the services layer rather than inside a router module.
"""

import logging
import os
import threading as _threading
from uuid import UUID

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# In-memory store: ocel_id -> pm4py OCEL object
# Bounded to avoid unbounded memory growth (OCEL objects can be large).
# ---------------------------------------------------------------------------
class _BoundedOcelStore:
    """Simple LRU-ish bounded store for OCEL objects (maxsize=50)."""
    def __init__(self, maxsize: int = 50):
        self._data: dict = {}
        self._maxsize = maxsize

    def __setitem__(self, key, value):
        if len(self._data) >= self._maxsize:
            # Remove oldest 20% of entries
            keys_to_remove = list(self._data.keys())[:max(1, self._maxsize // 5)]
            for k in keys_to_remove:
                del self._data[k]
        self._data[key] = value

    def get(self, key, default=None):
        return self._data.get(key, default)

    def __contains__(self, key):
        return key in self._data

    def clear(self):
        """Drop all cached OCEL objects. Used by the demo reset so a purge
        cycle doesn't leave stale (now-deleted) ocel_id entries behind."""
        self._data.clear()

    def __len__(self):
        return len(self._data)


_ocel_store = _BoundedOcelStore(maxsize=50)


# Per-ocel_id locks so that when multiple threadpool requests miss the
# in-memory store at the same time (the panel-loading thundering herd
# on the first OCPM page visit) only ONE thread re-parses the file from
# disk; the rest wait and reuse the resulting OCEL object.
_ocel_load_locks: dict[str, _threading.Lock] = {}
_ocel_load_locks_guard = _threading.Lock()


def _get_ocel_load_lock(ocel_id: str) -> _threading.Lock:
    with _ocel_load_locks_guard:
        lock = _ocel_load_locks.get(ocel_id)
        if lock is None:
            lock = _threading.Lock()
            _ocel_load_locks[ocel_id] = lock
        return lock

# Allowed OCEL file extensions and the pm4py reader to use
_OCEL_EXTENSIONS = {".jsonocel", ".xmlocel", ".sqlite", ".json", ".xml"}


def _read_ocel(file_path: str):
    """
    Read an OCEL file from disk using the appropriate pm4py reader based on
    its extension.  Raises ValueError for unsupported extensions or files
    that no available reader can parse.

    Reader selection is deliberately defensive about the pm4py API surface,
    which has drifted across releases (e.g. ``read_ocel2`` / ``read_ocel2_json``
    only exist on 2.7+, while the legacy ``read_ocel_json`` is the OCEL 1.0
    reader and *raises* on OCEL 2.0 input). We resolve each candidate via
    ``getattr`` so a missing/renamed function is simply skipped instead of
    raising ``AttributeError`` and bubbling up as a hard "OCEL not found" —
    which is exactly how a pm4py downgrade silently broke OCEL reading before.
    We try OCEL 2.0 readers first (the format the product ships), then fall
    back to the format-specific OCEL 1.0 readers, then the generic reader.
    """
    import pm4py

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _OCEL_EXTENSIONS:
        raise ValueError(
            f"Unsupported OCEL file extension: {ext}. "
            f"Supported: {', '.join(sorted(_OCEL_EXTENSIONS))}"
        )

    # Ordered list of candidate reader names by extension. OCEL 2.0 first
    # (what we ship), then OCEL 1.0 / generic fallbacks. Names that don't
    # exist on the installed pm4py are skipped via getattr below.
    if ext == ".sqlite":
        candidates = ["read_ocel2_sqlite", "read_ocel2", "read_ocel_sqlite", "read_ocel"]
    elif ext in (".xml", ".xmlocel"):
        candidates = ["read_ocel2_xml", "read_ocel2", "read_ocel_xml", "read_ocel"]
    else:  # .json / .jsonocel
        candidates = ["read_ocel2_json", "read_ocel2", "read_ocel_json", "read_ocel"]

    last_err: Exception | None = None
    for name in candidates:
        reader = getattr(pm4py, name, None)
        if reader is None:
            continue
        try:
            ocel_obj = reader(file_path)
        except Exception as e:  # wrong-format reader for this file — try next
            last_err = e
            logger.debug("pm4py.%s failed for %s: %s", name, os.path.basename(file_path), e)
            continue
        # Some readers return None on a format mismatch instead of raising.
        if ocel_obj is not None:
            return ocel_obj
        logger.debug("pm4py.%s returned None for %s", name, os.path.basename(file_path))

    raise ValueError(
        f"Could not read OCEL file '{os.path.basename(file_path)}': "
        "no available pm4py reader could parse it (the file may be corrupted, "
        "in an unsupported format, or pm4py may be too old for OCEL 2.0). "
        f"Last error: {last_err}"
    )


def _ocel_counts(ocel) -> tuple[int, int]:
    """Return (event_count, object_count) for an OCEL object.

    Uses O(1) attribute reads (``ocel.events`` / ``ocel.objects`` are already
    materialised DataFrames on the OCEL object) instead of the previous approach
    of calling ``ocel.get_extended_table()`` (builds a full denormalised
    events×objects join) and ``pm4py.ocel_objects_summary()`` (runs a groupby
    aggregation) just to get row counts.
    """
    try:
        event_count = len(ocel.events)
    except Exception:
        event_count = 0

    try:
        object_count = len(ocel.objects)
    except Exception:
        object_count = 0

    return event_count, object_count


# Ownership map for OCELs created via ``convert_log_to_ocel`` (synthetic
# UUIDs that don't correspond to an EventLog row). Populated in the
# convert endpoint and consulted from ``_assert_ocel_access``.
_ocel_owners: dict[str, UUID] = {}


def write_ocel_to_disk(ocel, output_path: str) -> str:
    """Persist a pm4py OCEL object to ``output_path`` as OCEL 2.0 JSON.

    Mirrors the writer-resolution used in the OPerA path (``write_ocel2_json``
    first, fall back to the legacy ``write_ocel_json``) so a downgraded pm4py
    still produces a readable file. Returns ``output_path`` for chaining.
    """
    import pm4py

    writer = getattr(pm4py, "write_ocel2_json", None) or getattr(pm4py, "write_ocel_json", None)
    if writer is None:  # pragma: no cover - pinned pm4py always has these
        raise ValueError("Installed pm4py exposes no OCEL JSON writer")
    writer(ocel, output_path)
    return output_path
