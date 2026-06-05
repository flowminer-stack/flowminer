"""Build the bundled demo event-log CSVs for TPC-H and BPIC 2019.

Run once to (re)materialise the CSVs the demo seeder loads from docs/examples:

    python backend/scripts/build_demo_datasets.py --tpch
    python backend/scripts/build_demo_datasets.py --bpic /path/to/BPI_Challenge_2019.xes

  * TPC-H — generated locally via DuckDB (no download). A header→lines join
    (orders ↔ aggregated lineitem on orderkey) run through build_event_log, so
    the demo project genuinely showcases the consolidation engine's output.
  * BPIC 2019 — a real sample, stream-parsed from the XES (the full log is
    1.6M events / 728 MB; we ship the first N traces, ~a couple MB). CC BY 4.0,
    Akzo Nobel — attribution is carried in the demo project description.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
_EXAMPLES = _BACKEND.parent / "docs" / "examples"

# TPC-H lifecycle dates -> activities (header-primary, one event per case).
_TPCH_EVENTS = [
    {"activity_name": "Order Placed", "timestamp_column": "o_orderdate"},
    {"activity_name": "Committed", "timestamp_column": "first_commit"},
    {"activity_name": "Shipped", "timestamp_column": "first_ship"},
    {"activity_name": "Received", "timestamp_column": "last_receipt"},
]


def build_tpch_demo(out_csv: Path, n_orders: int = 1500, sf: float = 0.01) -> None:
    import pandas as pd

    sys.path.insert(0, str(_BACKEND))
    from app.services.log_builder import build_event_log
    from tests.fixtures.tpch import generate_tpch

    tmp = Path(tempfile.mkdtemp())
    paths = generate_tpch(tmp, sf=sf)
    orders = pd.read_parquet(paths["orders"]).sort_values("o_orderkey").head(n_orders)
    keys = set(orders["o_orderkey"])
    lineitem = pd.read_parquet(paths["lineitem"])
    lineitem = lineitem[lineitem["l_orderkey"].isin(keys)]
    agg = lineitem.groupby("l_orderkey", as_index=False).agg(
        first_commit=("l_commitdate", "min"),
        first_ship=("l_shipdate", "min"),
        last_receipt=("l_receiptdate", "max"),
    )

    orders_path = tmp / "orders_sub.parquet"
    agg_path = tmp / "lines_agg.parquet"
    orders.to_parquet(orders_path, index=False)
    agg.to_parquet(agg_path, index=False)

    res = build_event_log(
        file_path=str(orders_path),
        case_id_column="o_orderkey",
        events=_TPCH_EVENTS,
        resource_column="o_clerk",
        additional_sources=[str(agg_path)],
        joins=[{"right_source": 0, "left_on": ["o_orderkey"],
                "right_on": ["l_orderkey"], "how": "left"}],
        output_path=str(out_csv),
    )
    print(f"✓ TPC-H demo: {res['total_cases']} cases / {res['total_events']} events -> {out_csv}")


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def build_bpic_demo(xes_path: Path, out_csv: Path, max_cases: int | None = None) -> None:
    """Stream-parse a BPIC XES into a CSV event log.

    Writes rows incrementally (memory-safe for the full 1.6M-event log) and is
    tolerant of a truncated file (a partial download): stops cleanly at the
    first parse error after the last whole trace. ``max_cases=None`` = full log.
    """
    import csv

    cases = 0
    events = 0
    fieldnames = ["case_id", "activity", "timestamp", "resource", "purchasing_document"]

    def _attrs(elem) -> dict:
        out = {}
        for child in elem:
            ln = _localname(child.tag)
            if ln in ("string", "date", "int", "float", "boolean"):
                out[child.get("key")] = child.get("value")
        return out

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        try:
            for _, elem in ET.iterparse(str(xes_path), events=("end",)):
                if _localname(elem.tag) != "trace":
                    continue
                tattrs = _attrs(elem)
                case_id = tattrs.get("concept:name")
                po_doc = tattrs.get("Purchasing Document") or tattrs.get("case Purchasing Document")
                for child in elem:
                    if _localname(child.tag) != "event":
                        continue
                    ev = _attrs(child)
                    ts, act = ev.get("time:timestamp"), ev.get("concept:name")
                    if not ts or not act:
                        continue
                    writer.writerow({
                        "case_id": case_id,
                        "activity": act,
                        "timestamp": ts,
                        "resource": ev.get("org:resource", ""),
                        "purchasing_document": po_doc or "",
                    })
                    events += 1
                elem.clear()
                cases += 1
                if max_cases is not None and cases >= max_cases:
                    break
        except ET.ParseError:
            print(f"  (stopped at truncated XES after {cases} complete traces)")

    if events == 0:
        print("ERROR: no traces parsed — is this a valid XES?", file=sys.stderr)
        sys.exit(1)
    print(f"✓ BPIC demo: {cases} cases / {events} events -> {out_csv} "
          f"({out_csv.stat().st_size // (1024*1024)} MB)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tpch", action="store_true", help="build the TPC-H demo CSV")
    ap.add_argument("--bpic", metavar="XES", help="build the BPIC demo CSV from this XES file")
    ap.add_argument("--max-cases", type=int, default=None,
                    help="cap the number of cases (default: full log)")
    args = ap.parse_args()

    if args.tpch:
        build_tpch_demo(_EXAMPLES / "tpch_order_to_cash.csv")
    if args.bpic:
        build_bpic_demo(Path(args.bpic), _EXAMPLES / "bpic2019_p2p.csv", max_cases=args.max_cases)
    if not args.tpch and not args.bpic:
        ap.error("pass --tpch and/or --bpic")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
