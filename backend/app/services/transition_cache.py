"""
Cached transition data — eliminates repeated sort+copy+shift patterns.

The sort_values().copy() + groupby().shift(-1) pattern appears 30+ times
across the codebase. Each occurrence creates a full DataFrame copy plus
temporary columns — ~1.3x the log size per call. On a single request
that touches discovery + bottleneck + competitive endpoints, this adds
up to 8x the original DataFrame in temporary memory.

This module computes the transition data ONCE via Rust (zero-copy,
streaming) and caches it per DataFrame identity. All callers share
the same numpy arrays without any DataFrame copies.

Usage:
    from app.services.transition_cache import get_transitions

    t = get_transitions(df)
    # t.duration_secs[i] = seconds from event i to next event in same case
    # t.next_activity[i] = activity label of next event (None for last)
    # t.is_last[i] = True for last event in each case
    # t.sorted_idx = sort permutation array
"""

import logging
import weakref
from dataclasses import dataclass

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"

try:
    import flowminer_accel as _rs
    _RUST_OK = True
except ImportError:
    _rs = None
    _RUST_OK = False


@dataclass(frozen=True, slots=True)
class TransitionData:
    """Precomputed per-event transition arrays (original row order)."""
    sorted_idx: np.ndarray      # int32 — sort permutation
    next_act_code: np.ndarray   # int32 — next activity code (-1 = last)
    next_ts_ns: np.ndarray      # int64 — next timestamp ns (0 = last)
    duration_secs: np.ndarray   # float64 — seconds to next event (0 = last)
    is_last: np.ndarray         # bool — True for last event in case
    act_labels: list            # activity label list (code → label)


# LRU-style cache keyed by DataFrame id. We keep at most 4 entries
# (typical: 1 main log + maybe 1-2 filtered views + 1 OCEL flatten).
_cache: dict[int, TransitionData] = {}
_MAX_CACHE = 4


def get_transitions(df: pd.DataFrame) -> TransitionData | None:
    """Get cached transition data for a DataFrame.

    Returns None if Rust is unavailable (callers fall back to pandas).
    The result is cached by DataFrame identity (id()) so repeated calls
    within the same request are free.
    """
    if not _RUST_OK or df.empty:
        return None

    key = id(df)
    if key in _cache:
        return _cache[key]

    # Encode
    case_cat = df[CASE_COL].astype("category")
    act_cat = df[ACTIVITY_COL].astype("category")
    raw_ts = df[TIMESTAMP_COL].astype(np.int64).values
    dtype_str = str(df[TIMESTAMP_COL].dtype)
    if "us" in dtype_str:
        raw_ts = raw_ts * 1000
    elif "ms" in dtype_str:
        raw_ts = raw_ts * 1_000_000

    case_codes = case_cat.cat.codes.values.astype(np.int32)
    act_codes = act_cat.cat.codes.values.astype(np.int32)

    result = _rs.compute_transitions(case_codes, act_codes, raw_ts)

    td = TransitionData(
        sorted_idx=np.asarray(result["sorted_idx"]),
        next_act_code=np.asarray(result["next_act_code"]),
        next_ts_ns=np.asarray(result["next_ts_ns"]),
        duration_secs=np.asarray(result["duration_ns"]).astype(np.float64) / 1_000_000_000.0,
        is_last=np.asarray(result["is_last"]),
        act_labels=act_cat.cat.categories.tolist(),
    )

    # Evict oldest if cache full
    if len(_cache) >= _MAX_CACHE:
        oldest = next(iter(_cache))
        del _cache[oldest]
    _cache[key] = td

    return td


def invalidate(df: pd.DataFrame) -> None:
    """Remove a DataFrame's cached transitions (e.g. after mutation)."""
    _cache.pop(id(df), None)


def clear_cache() -> None:
    """Clear all cached transitions."""
    _cache.clear()
