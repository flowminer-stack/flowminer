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
    its extension.  Raises ValueError for unsupported extensions.
    """
    import pm4py

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _OCEL_EXTENSIONS:
        raise ValueError(
            f"Unsupported OCEL file extension: {ext}. "
            f"Supported: {', '.join(sorted(_OCEL_EXTENSIONS))}"
        )

    # Try the OCEL 2.0 reader first; fall back to format-specific OCEL 1.0
    # readers for .json/.xml so legacy files work too.
    try:
        return pm4py.read_ocel2(file_path)
    except Exception as ocel2_err:
        logger.debug("read_ocel2 failed (%s), trying format-specific reader", ocel2_err)

    if ext in (".json", ".jsonocel"):
        return pm4py.read_ocel_json(file_path)
    if ext in (".xml", ".xmlocel"):
        return pm4py.read_ocel_xml(file_path)

    # SQLite only supported via read_ocel2; if that failed above, re-raise
    raise ValueError(
        f"Could not read OCEL file '{os.path.basename(file_path)}': "
        "file may be corrupted or in an unsupported format."
    )


def _ocel_counts(ocel) -> tuple[int, int]:
    """Return (event_count, object_count) for an OCEL object."""
    import pm4py

    try:
        event_count = len(ocel.get_extended_table())
    except Exception:
        try:
            event_count = len(ocel.events)
        except Exception:
            event_count = 0

    try:
        summary = pm4py.ocel_objects_summary(ocel)
        object_count = len(summary)
    except Exception:
        try:
            object_count = len(ocel.objects)
        except Exception:
            object_count = 0

    return event_count, object_count


# Ownership map for OCELs created via ``convert_log_to_ocel`` (synthetic
# UUIDs that don't correspond to an EventLog row). Populated in the
# convert endpoint and consulted from ``_assert_ocel_access``.
_ocel_owners: dict[str, UUID] = {}
