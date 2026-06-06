"""Compare the Rust-backed Heuristic/Split miners against the pm4py path:
node/edge overlap (soundness) on a subsample + full-log timing."""
from __future__ import annotations
import gzip, sys, time
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
CSV = ROOT.parent / "docs" / "examples" / "bpic2019_p2p.csv.gz"
CASE, ACT, TS, RES = "case:concept:name", "concept:name", "time:timestamp", "org:resource"


def load(n=None):
    with gzip.open(CSV, "rt") as f:
        df = pd.read_csv(f)
    df = df.rename(columns={"case_id": CASE, "activity": ACT, "timestamp": TS, "resource": RES})
    df[TS] = pd.to_datetime(df[TS], utc=True, errors="coerce")
    df = df.dropna(subset=[TS])
    if n:
        cases = df[CASE].drop_duplicates().head(n)
        df = df[df[CASE].isin(set(cases))].copy()
    return df


def sets(res):
    nodes = frozenset(n["id"] for n in res["nodes"])
    edges = frozenset((e["source"], e["target"]) for e in res["edges"])
    return nodes, edges


def jacc(a, b):
    return len(a & b) / len(a | b) if (a | b) else 1.0


def main():
    import app.services.rust_accel as ra
    from app.services.discovery import DiscoveryService
    disc = DiscoveryService()

    # ── soundness: Rust vs pm4py output on a subsample ──
    sub = load(20_000)
    print(f"soundness compare on {len(sub):,} events / {sub[CASE].nunique():,} cases")
    for algo, fn in [("heuristic", lambda d: disc.discover_heuristic(d)),
                     ("split_miner", lambda d: disc.discover(d, "split_miner"))]:
        ra.RUST_AVAILABLE = True
        r = fn(sub)
        ra.RUST_AVAILABLE = False
        p = fn(sub)
        ra.RUST_AVAILABLE = True
        rn, re = sets(r); pn, pe = sets(p)
        print(f"  {algo:<12} rust={len(rn)}n/{len(re)}e  pm4py={len(pn)}n/{len(pe)}e  "
              f"node_jaccard={jacc(rn,pn):.2f} edge_jaccard={jacc(re,pe):.2f}")

    # ── full-log timing (Rust path) ──
    full = load()
    print(f"\nfull-log timing on {len(full):,} events / {full[CASE].nunique():,} cases (Rust ON)")
    for algo, fn in [("discover_heuristic", lambda d: disc.discover_heuristic(d)),
                     ("split_miner", lambda d: disc.discover(d, "split_miner"))]:
        t = time.perf_counter()
        res = fn(full)
        dt = time.perf_counter() - t
        print(f"  {algo:<20} {dt:7.3f}s  {len(res['nodes'])}n/{len(res['edges'])}e")


if __name__ == "__main__":
    main()
