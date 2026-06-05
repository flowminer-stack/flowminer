"""Synthetic Purchase-to-Pay (P2P) relational data generator.

Why this exists
---------------
FlowMiner's log-join engine (``app.services.log_builder.build_event_log`` ->
``_assemble_wide_table`` -> ``app.services.etl_executor._join_table``) is the
"automatic consolidation" feature: it joins several *relational* source tables
(a header + its line items + a history/receipts table that share a key) into one
wide table, then unpivots the timestamp columns into an event log. Testing it
properly therefore needs genuine **multi-table** input, not a pre-flattened
event log.

This module emits exactly that, in the EKKO/EKPO/EKBE shape the shipped
``sap_p2p`` recipe joins on ``EBELN`` (here: ``order_id``):

  * ``orders``        — header, ONE row per order (EKKO): created/approved dates
  * ``order_lines``   — line items, N rows per order (EKPO): delivery dates
  * ``order_history`` — receipts, M rows per order (EKBE): GR/IR postings

It is fully deterministic given ``seed`` (all structure/timestamps come from a
seeded numpy Generator), so tests can assert exact case/event counts. ``faker``
is used only for cosmetic vendor names when installed; nothing asserted depends
on it, so the generator works with or without it.

Two consumers:
  * the connector tests (``tests/connectors/test_log_join_p2p.py``), via the
    ``join_ready`` helper which pre-aggregates the line/history tables to one
    row per order so they satisfy ``_join_table``'s ``validate="many_to_one"``
    guard (the real pipeline must do the same);
  * a DB seeder — run ``python -m tests.fixtures.generate_p2p_data --out DIR``
    (or call ``write_tables``) to drop CSVs that load into a Postgres/Odoo
    test container for the ``database``/``odoo`` connectors.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

try:  # cosmetic only — vendor names. Absence must not change any assertion.
    from faker import Faker

    _FAKER_AVAILABLE = True
except Exception:  # pragma: no cover - faker is a declared test dep
    _FAKER_AVAILABLE = False

# A fixed epoch so timestamps never depend on the wall clock (determinism).
_EPOCH = pd.Timestamp("2025-06-01T08:00:00")

TABLE_NAMES = ("orders", "order_lines", "order_history")
JOIN_READY_NAMES = ("orders", "lines_summary", "receipts")


def generate_tables(
    n_orders: int = 200,
    *,
    avg_lines: float = 3.0,
    rework_rate: float = 0.1,
    two_way_fraction: float = 0.3,
    seed: int = 42,
) -> dict[str, pd.DataFrame]:
    """Build the three normalized P2P tables in memory.

    Args:
        n_orders: number of purchase orders (== number of process cases).
        avg_lines: mean line items per order (Poisson; always >= 1).
        rework_rate: fraction of orders that get a duplicate goods receipt
            (a rework loop — useful for variant/conformance testing).
        two_way_fraction: fraction of orders with a 2-way match (goods receipt
            only, no invoice receipt); the rest are 3-way (GR + IR).
        seed: RNG seed; identical inputs -> byte-identical tables.

    Returns:
        ``{"orders": df, "order_lines": df, "order_history": df}`` where the
        three frames share an ``order_id`` key. ``order_lines`` and
        ``order_history`` have multiple rows per ``order_id`` (so a naive join
        against them is correctly rejected by the many-to-one guard — see
        ``join_ready`` for the aggregation the real pipeline applies).
    """
    rng = np.random.default_rng(seed)
    vendor_name = _vendor_namer(seed)

    orders: list[dict] = []
    lines: list[dict] = []
    history: list[dict] = []

    for i in range(n_orders):
        order_id = f"45{i:08d}"  # EKKO.EBELN
        vendor_id = f"{1_000_000_000 + int(rng.integers(0, 100_000_000)):010d}"
        created = _EPOCH + pd.Timedelta(days=int(rng.integers(0, 365)),
                                        hours=float(rng.uniform(0, 8)))
        approved = created + pd.Timedelta(hours=float(rng.exponential(48)))
        orders.append({
            "order_id": order_id,                       # EKKO.EBELN
            "vendor_id": vendor_id,                      # EKKO.LIFNR
            "vendor_name": vendor_name(vendor_id),       # cosmetic
            "company_code": str(rng.choice(["1000", "2000", "3000"])),  # EKKO.BUKRS
            "created_at": created,                       # EKKO.AEDAT
            "approved_at": approved,
            "amount_total": round(float(rng.uniform(100, 100_000)), 2),  # EKPO.NETWR (rollup)
        })

        n_lines = max(1, int(rng.poisson(avg_lines)))
        for ln in range(1, n_lines + 1):
            delivery = approved + pd.Timedelta(days=int(rng.integers(3, 30)))
            lines.append({
                "order_id": order_id,                    # EKPO.EBELN
                "line_no": f"{ln * 10:05d}",             # EKPO.EBELP
                "material_id": f"MAT-{int(rng.integers(1000, 9999))}",  # EKPO.MATNR
                "quantity": int(rng.integers(1, 500)),   # EKPO.MENGE
                "delivery_date": delivery,               # EKPO.EINDT
            })

        # EKBE history: a goods receipt always; an invoice receipt unless this
        # is a 2-way match; an optional duplicate GR models a rework loop.
        events = ["GR"] if rng.random() < two_way_fraction else ["GR", "IR"]
        if rng.random() < rework_rate:
            events.insert(1, "GR")
        ts = approved
        for ev in events:
            ts = ts + pd.Timedelta(hours=float(rng.exponential(72)))
            history.append({
                "order_id": order_id,                    # EKBE.EBELN
                "event_type": ev,                        # EKBE.VGABE (1=GR, 2=IR)
                "posting_date": ts,                      # EKBE.BUDAT
                "amount": round(float(rng.uniform(50, 50_000)), 2),  # EKBE.DMBTR
            })

    return {
        "orders": pd.DataFrame(orders),
        "order_lines": pd.DataFrame(lines),
        "order_history": pd.DataFrame(history),
    }


def join_ready(tables: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """Aggregate the line/history tables to ONE row per order.

    ``_join_table`` enforces ``validate="many_to_one"`` and rejects a right
    table with duplicate join keys (a many-to-many fan-out would silently
    multiply event counts). The real recipe pipeline therefore collapses each
    additional table to one representative row per case before the join; this
    helper does the same so the multi-source join can be exercised end-to-end.

    Returns ``{"orders", "lines_summary", "receipts"}``, each unique on
    ``order_id``:
      * ``lines_summary`` — earliest delivery date + rolled-up quantity/line count
      * ``receipts``      — goods-receipt and invoice-receipt dates pivoted wide
    """
    orders = tables["orders"].copy()

    lines = tables["order_lines"]
    lines_summary = (
        lines.groupby("order_id", as_index=False)
        .agg(
            first_delivery_date=("delivery_date", "min"),
            total_quantity=("quantity", "sum"),
            n_lines=("line_no", "count"),
        )
    )

    hist = tables["order_history"]
    gr = (
        hist[hist["event_type"] == "GR"]
        .groupby("order_id")["posting_date"].min()
        .rename("goods_receipt_date")
    )
    ir = (
        hist[hist["event_type"] == "IR"]
        .groupby("order_id")["posting_date"].min()
        .rename("invoice_receipt_date")
    )
    receipts = pd.concat([gr, ir], axis=1).reset_index()

    return {"orders": orders, "lines_summary": lines_summary, "receipts": receipts}


# Event spec matching the join-ready wide table — the same shape a build request
# / recipe passes to ``build_event_log``. Reused by the tests.
P2P_EVENTS = [
    {"activity_name": "PO Created", "timestamp_column": "created_at"},
    {"activity_name": "PO Approved", "timestamp_column": "approved_at"},
    {"activity_name": "First Delivery", "timestamp_column": "first_delivery_date"},
    {"activity_name": "Goods Receipt", "timestamp_column": "goods_receipt_date"},
    {"activity_name": "Invoice Receipt", "timestamp_column": "invoice_receipt_date"},
]


def write_tables(tables: dict[str, pd.DataFrame], out_dir: str | Path) -> dict[str, str]:
    """Write each frame to ``out_dir/<name>.csv``; return ``name -> path``."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    for name, df in tables.items():
        p = out / f"{name}.csv"
        df.to_csv(p, index=False)
        paths[name] = str(p)
    return paths


def generate(out_dir: str | Path, **kwargs) -> tuple[str, str, str]:
    """Convenience: write the three normalized tables, return their paths.

    Returns ``(orders_path, order_lines_path, order_history_path)``.
    """
    tables = generate_tables(**kwargs)
    paths = write_tables(tables, out_dir)
    return paths["orders"], paths["order_lines"], paths["order_history"]


def _vendor_namer(seed: int):
    if _FAKER_AVAILABLE:
        fake = Faker()
        Faker.seed(seed)
        cache: dict[str, str] = {}

        def name(vendor_id: str) -> str:
            if vendor_id not in cache:
                cache[vendor_id] = fake.company()
            return cache[vendor_id]

        return name

    def fallback(vendor_id: str) -> str:
        return f"Vendor {vendor_id[-4:]}"

    return fallback


def _main() -> None:
    ap = argparse.ArgumentParser(description="Generate synthetic P2P relational CSVs.")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--orders", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--join-ready", action="store_true",
                    help="also write the one-row-per-order aggregated tables")
    args = ap.parse_args()

    tables = generate_tables(n_orders=args.orders, seed=args.seed)
    paths = write_tables(tables, args.out)
    for name, p in paths.items():
        print(f"{name:14s} {len(tables[name]):>7d} rows -> {p}")
    if args.join_ready:
        jr = join_ready(tables)
        jr_paths = write_tables(jr, Path(args.out) / "join_ready")
        for name, p in jr_paths.items():
            print(f"{name:14s} {len(jr[name]):>7d} rows -> {p}")


if __name__ == "__main__":
    _main()
