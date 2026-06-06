"""Benchmark FlowMiner analysis functions on the real BPIC2019 log.

Loads docs/examples/bpic2019_p2p.csv.gz (~1.6M events) into a pm4py-format
DataFrame and times each analysis. Heavy miners (alpha/inductive/heuristic,
which have no Rust path) run on a capped case-subsample; the linear
Rust-accelerated leaf ops run on the full log.

Usage:
    python scripts/bench_mining.py                 # full run
    python scripts/bench_mining.py --rows 200000   # cap total events
    python scripts/bench_mining.py --heavy-cases 1500
    python scripts/bench_mining.py --rust off      # force pure-Python fallbacks
"""

from __future__ import annotations

import argparse
import gzip
import sys
import time
import traceback
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

CSV = ROOT.parent / "docs" / "examples" / "bpic2019_p2p.csv.gz"

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"
RESOURCE_COL = "org:resource"


def load(rows: int | None) -> pd.DataFrame:
    t = time.perf_counter()
    with gzip.open(CSV, "rt") as f:
        df = pd.read_csv(f)
    df = df.rename(columns={
        "case_id": CASE_COL,
        "activity": ACTIVITY_COL,
        "timestamp": TIMESTAMP_COL,
        "resource": RESOURCE_COL,
    })
    df[TIMESTAMP_COL] = pd.to_datetime(df[TIMESTAMP_COL], utc=True, errors="coerce")
    df = df.dropna(subset=[TIMESTAMP_COL])
    if rows is not None and rows < len(df):
        df = df.iloc[:rows].copy()
    dt = time.perf_counter() - t
    print(f"loaded {len(df):,} events / {df[CASE_COL].nunique():,} cases / "
          f"{df[ACTIVITY_COL].nunique()} activities in {dt:.2f}s")
    return df


def subsample_cases(df: pd.DataFrame, n_cases: int) -> pd.DataFrame:
    """First n_cases whole cases (traces kept intact)."""
    cases = df[CASE_COL].drop_duplicates().head(n_cases)
    return df[df[CASE_COL].isin(set(cases))].copy()


def timed(label: str, fn, *, repeat: int = 1):
    """Run fn, print wall-clock (best of `repeat`). Returns (secs, ok, note)."""
    best = float("inf")
    note = ""
    ok = True
    for _ in range(repeat):
        t = time.perf_counter()
        try:
            res = fn()
            dt = time.perf_counter() - t
            best = min(best, dt)
            # cheap size hint for sanity
            if isinstance(res, dict):
                if "edges" in res:
                    note = f"{len(res.get('nodes', []))}n/{len(res.get('edges', []))}e"
                elif "variants" in res:
                    note = f"{len(res.get('variants', []))} variants"
                elif "bottlenecks" in res:
                    note = f"{len(res.get('bottlenecks', []))} acts"
                elif "fitness" in res:
                    note = f"fit={res.get('fitness'):.3f} prec={res.get('precision')}"
            elif isinstance(res, list):
                note = f"{len(res)} items"
        except Exception as e:  # noqa: BLE001
            dt = time.perf_counter() - t
            best = min(best, dt)
            ok = False
            note = f"ERR {type(e).__name__}: {e}"
            if "--trace" in sys.argv:
                traceback.print_exc()
            break
    flag = "ok " if ok else "ERR"
    print(f"  [{flag}] {label:<34} {best:8.3f}s  {note}")
    return best, ok, note


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=None)
    ap.add_argument("--heavy-cases", type=int, default=2000,
                    help="case cap for alpha/inductive/heuristic/conformance")
    ap.add_argument("--rust", choices=["on", "off"], default="on")
    ap.add_argument("--trace", action="store_true")
    args = ap.parse_args()

    import app.services.rust_accel as ra
    if args.rust == "off":
        ra.RUST_AVAILABLE = False
    print(f"RUST_AVAILABLE = {ra.RUST_AVAILABLE}  (--rust {args.rust})\n")

    from app.services.discovery import DiscoveryService
    from app.services.variant_analysis import VariantAnalysisService
    from app.services.bottleneck import BottleneckService
    from app.services.conformance import ConformanceService
    from app.services.statistics import StatisticsService
    from app.services.mining import org_mining, performance

    df = load(args.rows)
    heavy = subsample_cases(df, args.heavy_cases)
    print(f"heavy subsample: {len(heavy):,} events / {heavy[CASE_COL].nunique():,} cases\n")

    disc = DiscoveryService()
    var = VariantAnalysisService()
    bott = BottleneckService()
    conf = ConformanceService()
    stats = StatisticsService()

    print("── FULL LOG (linear / Rust-accelerated leaf ops) ──")
    timed("discover_dfg", lambda: disc.discover_dfg(df))
    timed("variant_analysis", lambda: var.analyze_variants(df))
    timed("bottleneck", lambda: bott.analyze_bottlenecks(df))
    timed("statistics", lambda: stats.compute_statistics(df))
    timed("temporal_profile", lambda: performance.get_temporal_profile(df))
    timed("case_overlap", lambda: performance.get_case_overlap(df))
    timed("sna_handover", lambda: org_mining.get_sna(df, "handover")
          if hasattr(org_mining, "get_sna") else org_mining.get_social_network(df))
    timed("social_network", lambda: org_mining.get_social_network(df))
    timed("split_miner", lambda: disc.discover(df, "split_miner"))

    print("\n── HEAVY MINERS (pm4py, NO Rust path) — on subsample ──")
    timed("discover_alpha", lambda: disc.discover_alpha(heavy))
    timed("discover_heuristic", lambda: disc.discover_heuristic(heavy))
    timed("discover_inductive", lambda: disc.discover_inductive(heavy))
    timed("conformance_token", lambda: conf.check_conformance(heavy, method="token_replay"))

    print("\ndone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
