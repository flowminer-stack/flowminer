"""Tests for the event-log XES export builder (data portability).

Covers the pure conversion path behind ``GET /event-logs/{id}/export/xes``:
``_build_xes_file`` must turn an arbitrarily-named flat log into valid IEEE
XES that pm4py can read back, preserve the resource under ``org:resource``,
and fail loudly when the mapped columns aren't present.
"""

import os
import tempfile

import pandas as pd
import pytest

from app.api.event_logs import _build_xes_file


def _write_csv(rows: dict) -> str:
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    pd.DataFrame(rows).to_csv(path, index=False)
    return path


def test_build_xes_roundtrips_through_pm4py():
    """A CSV with non-standard column names exports to XES that pm4py reads
    back with the right number of events, and carries org:resource through."""
    import pm4py

    csv = _write_csv(
        {
            "Case": ["A", "A", "B"],
            "Act": ["start", "end", "start"],
            "When": [
                "2024-01-01T10:00:00",
                "2024-01-01T11:00:00",
                "2024-01-02T09:00:00",
            ],
            "Who": ["alice", "bob", "alice"],
        }
    )
    xes = None
    try:
        xes = _build_xes_file(csv, "Case", "Act", "When", "Who")
        assert os.path.getsize(xes) > 0

        content = open(xes, encoding="utf-8").read()
        # Resource mapped to the XES standard key.
        assert "org:resource" in content

        log = pm4py.read_xes(xes)
        total_events = len(log) if hasattr(log, "__len__") else len(log.index)
        assert total_events == 3
    finally:
        os.remove(csv)
        if xes and os.path.exists(xes):
            os.remove(xes)


def test_build_xes_without_resource_is_fine():
    """Resource is optional — passing None must not blow up."""
    csv = _write_csv(
        {
            "Case": ["A", "B"],
            "Act": ["x", "y"],
            "When": ["2024-01-01T10:00:00", "2024-01-02T09:00:00"],
        }
    )
    xes = None
    try:
        xes = _build_xes_file(csv, "Case", "Act", "When", None)
        assert os.path.getsize(xes) > 0
    finally:
        os.remove(csv)
        if xes and os.path.exists(xes):
            os.remove(xes)


def test_build_xes_missing_column_raises():
    """A mapping pointing at a column the file doesn't have fails clearly,
    rather than producing a corrupt/empty export."""
    csv = _write_csv(
        {
            "Case": ["A"],
            "Act": ["x"],
            "When": ["2024-01-01T10:00:00"],
        }
    )
    try:
        with pytest.raises(ValueError, match="not present"):
            _build_xes_file(csv, "Case", "Act", "NoSuchTimestamp", None)
    finally:
        os.remove(csv)
