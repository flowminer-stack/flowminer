"""Log-join tests for the BPI Challenge 2019 real SAP P2P log.

Two layers:
  * ``test_reconstruct_and_join_synthetic`` — runs in the DEFAULT suite (no
    download). Builds a tiny BPIC-shaped frame, reconstructs the header/line
    split, and joins it through ``build_event_log``. Proves the reconstruction
    + join logic deterministically.
  * ``test_bpic2019_real_log_and_join`` — ``integration``; loads the real 1.6M-
    event XES with pm4py and runs the same pipeline. Skips if the file is absent
    (it is git-ignored — fetch with ``python backend/scripts/fetch_bpic.py``).
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from app.services.log_builder import build_event_log

from .event_log_assertions import assert_valid_event_log
from tests.fixtures.bpic import detect_header_column, reconstruct_po_tables

_BPIC_FILE = Path(__file__).resolve().parent.parent / "fixtures" / "bpic" / "BPI_Challenge_2019.xes"

# Reconstructed header/line tables -> three activities. line_start is on the
# line (primary); header_open/header_close ride in from the joined header.
_PO_EVENTS = [
    {"activity_name": "Line Window Start", "timestamp_column": "line_start"},
    {"activity_name": "PO Opened", "timestamp_column": "header_open"},
    {"activity_name": "PO Closed", "timestamp_column": "header_close"},
]


def _synthetic_bpic_df() -> pd.DataFrame:
    """A small flat PO-line log: 3 purchasing docs, 6 line cases, 18 events."""
    spec = {"PD-1000": ["00010", "00020"],
            "PD-2000": ["00010", "00020", "00030"],
            "PD-3000": ["00010"]}
    activities = ["Create Purchase Order Item", "Record Goods Receipt", "Record Invoice Receipt"]
    base = pd.Timestamp("2026-01-01T08:00:00Z")
    rows, i = [], 0
    for doc, items in spec.items():
        for item in items:
            for a, act in enumerate(activities):
                rows.append({
                    "case:concept:name": f"{doc}/{item}",
                    "concept:name": act,
                    "time:timestamp": base + pd.Timedelta(days=i, hours=a * 3),
                    "Purchasing Document": doc,
                })
            i += 1
    return pd.DataFrame(rows)


def test_detect_header_column_is_tolerant():
    assert detect_header_column(["case:concept:name", "Purchasing Document"]) == "Purchasing Document"
    assert detect_header_column(["case:Purchasing Document", "x"]) == "case:Purchasing Document"
    assert detect_header_column(["a", "b"]) is None


def test_reconstruct_and_join_synthetic(tmp_path):
    df = _synthetic_bpic_df()
    header_col = detect_header_column(df.columns)
    assert header_col == "Purchasing Document"

    tables = reconstruct_po_tables(
        df, case_col="case:concept:name", header_key_col=header_col,
        timestamp_col="time:timestamp",
    )
    # header must be unique on its key (the RIGHT side of the many-to-one join)
    assert tables["po_header"][header_col].is_unique
    assert len(tables["po_header"]) == 3      # 3 purchasing documents
    assert len(tables["po_lines"]) == 6       # 6 line cases

    lines_path = tmp_path / "po_lines.parquet"
    header_path = tmp_path / "po_header.parquet"
    tables["po_lines"].to_parquet(lines_path, index=False)
    tables["po_header"].to_parquet(header_path, index=False)

    out = tmp_path / "bpic_log.csv"
    result = build_event_log(
        file_path=str(lines_path),
        case_id_column="case:concept:name",
        events=_PO_EVENTS,
        additional_sources=[str(header_path)],
        joins=[{"right_source": 0, "left_on": [header_col], "right_on": [header_col], "how": "left"}],
        output_path=str(out),
    )

    assert result["total_cases"] == 6
    assert result["total_events"] == 18      # 6 lines x 3 events
    assert set(result["activities"]) == {"Line Window Start", "PO Opened", "PO Closed"}
    log = pd.read_csv(out)
    assert_valid_event_log(
        log, case_col="case_id", activity_col="activity", ts_col="timestamp",
        min_cases=6, min_activities=3,
    )


@pytest.mark.integration
def test_bpic2019_real_log_and_join(tmp_path):
    if not _BPIC_FILE.exists():
        pytest.skip(
            "BPIC 2019 not present; run `python backend/scripts/fetch_bpic.py` "
            "to enable this test."
        )
    pm4py = pytest.importorskip("pm4py")

    log = pm4py.read_xes(str(_BPIC_FILE))
    df = log if isinstance(log, pd.DataFrame) else pm4py.convert_to_dataframe(log)

    # Real-data sanity: it's a big, mineable log.
    assert_valid_event_log(
        df, case_col="case:concept:name", activity_col="concept:name",
        ts_col="time:timestamp", min_cases=1000, min_activities=10,
    )
    assert len(df) > 1_000_000

    header_col = detect_header_column(df.columns)
    if header_col is None:
        pytest.skip(f"no Purchasing Document column; have {list(df.columns)[:40]}")

    tables = reconstruct_po_tables(
        df, case_col="case:concept:name", header_key_col=header_col,
        timestamp_col="time:timestamp",
    )
    assert tables["po_header"][header_col].is_unique

    lines_path = tmp_path / "po_lines.parquet"
    header_path = tmp_path / "po_header.parquet"
    tables["po_lines"].to_parquet(lines_path, index=False)
    tables["po_header"].to_parquet(header_path, index=False)

    result = build_event_log(
        file_path=str(lines_path),
        case_id_column="case:concept:name",
        events=_PO_EVENTS,
        additional_sources=[str(header_path)],
        joins=[{"right_source": 0, "left_on": [header_col], "right_on": [header_col], "how": "left"}],
    )
    assert result["total_cases"] == tables["po_lines"]["case:concept:name"].nunique()
    assert "PO Opened" in result["activities"]
