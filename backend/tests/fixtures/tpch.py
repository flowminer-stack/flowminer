"""TPC-H relational data generator (via DuckDB) for the log-join tests.

TPC-H is the canonical header->lines schema FlowMiner's join engine is built for:
``orders`` (unique ``o_orderkey``) ↔ ``lineitem`` (N rows per order, three date
columns per line). DuckDB's bundled ``tpch`` extension generates it at any scale
factor locally — no accounts, no network beyond the one-time extension install —
so it doubles as a CI join test (small SF) and a perf rig (SF10/SF100).

The orientation matters for ``_join_table``'s ``validate="many_to_one"`` guard:
``lineitem`` is the N-side and must be the PRIMARY/LEFT table; ``orders`` has a
unique key and is the RIGHT (``additional_sources``). See ``tpch_join_args``.
"""

from __future__ import annotations

from pathlib import Path

# Lifecycle date columns -> process activities. o_orderdate rides in from the
# joined orders header; the three l_*date columns are on the lineitem primary.
TPCH_EVENTS = [
    {"activity_name": "Order Placed", "timestamp_column": "o_orderdate"},
    {"activity_name": "Committed", "timestamp_column": "l_commitdate"},
    {"activity_name": "Shipped", "timestamp_column": "l_shipdate"},
    {"activity_name": "Received", "timestamp_column": "l_receiptdate"},
]


def generate_tpch(
    out_dir: str | Path,
    *,
    sf: float = 0.01,
    tables: tuple[str, ...] = ("orders", "lineitem", "customer"),
) -> dict[str, str]:
    """Generate TPC-H at scale factor ``sf`` and export each table to parquet.

    Returns ``name -> parquet path``. Imports duckdb lazily so the module is
    import-safe when duckdb is absent. Raises duckdb's error if the ``tpch``
    extension can't be installed (e.g. offline first run) — callers in tests
    should skip on that.

    Scale: sf=0.01 -> ~15k orders / ~60k lineitem (CI); sf=1 -> 1.5M / 6M;
    sf=10 -> 15M / 60M (perf).
    """
    import duckdb

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    try:
        con.execute("INSTALL tpch; LOAD tpch;")
        con.execute(f"CALL dbgen(sf={float(sf)});")
        paths: dict[str, str] = {}
        for t in tables:
            p = out / f"{t}.parquet"
            con.execute(f"COPY {t} TO '{p}' (FORMAT parquet);")
            paths[t] = str(p)
        return paths
    finally:
        con.close()


def tpch_join_args(paths: dict[str, str], output_path: str | None = None) -> dict:
    """build_event_log kwargs for the canonical lineitem-primary + orders join.

    lineitem (N-side) is the primary ``file_path``; orders (unique o_orderkey)
    is the RIGHT ``additional_sources`` so the join passes ``many_to_one``.
    Produces one case per order (``l_orderkey``) and four activities per line.
    """
    return {
        "file_path": paths["lineitem"],
        "case_id_column": "l_orderkey",
        "events": TPCH_EVENTS,
        "resource_column": "l_shipmode",
        "additional_sources": [paths["orders"]],
        "joins": [{
            "right_source": 0,
            "left_on": ["l_orderkey"],
            "right_on": ["o_orderkey"],
            "how": "left",
        }],
        "output_path": output_path,
    }
