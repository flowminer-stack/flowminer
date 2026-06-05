"""Helpers for the BPI Challenge 2019 real SAP P2P log.

BPIC 2019 (~1.6M events, real Akzo Nobel procurement, CC BY 4.0) is a *flat*
event log whose case is a purchase-order line item; the header (Purchasing
Document) lives in a case attribute shared across that PO's line cases. To
exercise FlowMiner's header→lines join on real data we reconstruct the
EKKO/EKPO split: a unique-per-document header table + a per-line table that
share the Purchasing Document key.

The reconstruction is pure pandas (no pm4py), so it is unit-tested on a small
synthetic BPIC-shaped frame in CI without the 728 MB download.
"""

from __future__ import annotations

import pandas as pd

# Case-attribute column carrying the PO header id, across pm4py XES naming
# variants ("case:Purchasing Document", "Purchasing Document", …). Detection is
# tolerant because BPIC exports differ slightly in attribute naming.
_HEADER_HINTS = ("purchasing document", "purchasingdocument", "purchase document")


def detect_header_column(columns) -> str | None:
    """Find the Purchasing-Document (header key) column, tolerant of XES naming."""
    for col in columns:
        norm = str(col).lower().replace("case:", "").strip()
        if norm in _HEADER_HINTS or ("purchas" in norm and "document" in norm):
            return col
    return None


def reconstruct_po_tables(
    df: pd.DataFrame,
    *,
    case_col: str,
    header_key_col: str,
    timestamp_col: str,
) -> dict[str, pd.DataFrame]:
    """Split a flat PO-line event log into header + line tables sharing a key.

    Returns ``{"po_lines", "po_header"}``:
      * ``po_lines``  — one row per line case (the N-side): case id, header key,
        line_start/line_end timestamps.
      * ``po_header`` — one row per Purchasing Document (unique, the RIGHT side):
        header key, header_open/header_close timestamps, line count.

    Joining ``po_lines`` (primary) to ``po_header`` (additional) on
    ``header_key_col`` is then a clean many-to-one — the real EKKO/EKPO shape.
    """
    ts = pd.to_datetime(df[timestamp_col], errors="coerce", utc=True)
    work = df[[case_col, header_key_col]].copy()
    work["_ts"] = ts

    po_lines = (
        work.groupby(case_col, as_index=False)
        .agg(
            **{
                header_key_col: (header_key_col, "first"),
                "line_start": ("_ts", "min"),
                "line_end": ("_ts", "max"),
            }
        )
    )

    po_header = (
        work.groupby(header_key_col, as_index=False)
        .agg(
            header_open=("_ts", "min"),
            header_close=("_ts", "max"),
            n_lines=(case_col, "nunique"),
        )
    )

    return {"po_lines": po_lines, "po_header": po_header}
