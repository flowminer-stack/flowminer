"""Correctness check: Rust-accelerated paths must match the pure-Python
references on the real BPIC2019 log. Runs each analysis twice (Rust ON / OFF)
and diffs the results."""
from __future__ import annotations
import gzip, sys
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
CSV = ROOT.parent / "docs" / "examples" / "bpic2019_p2p.csv.gz"
CASE, ACT, TS, RES = "case:concept:name", "concept:name", "time:timestamp", "org:resource"

N_CASES = int(sys.argv[1]) if len(sys.argv) > 1 else 50_000


def load():
    with gzip.open(CSV, "rt") as f:
        df = pd.read_csv(f)
    df = df.rename(columns={"case_id": CASE, "activity": ACT, "timestamp": TS, "resource": RES})
    df[TS] = pd.to_datetime(df[TS], utc=True, errors="coerce")
    df = df.dropna(subset=[TS])
    cases = df[CASE].drop_duplicates().head(N_CASES)
    return df[df[CASE].isin(set(cases))].copy()


def run(rust: bool):
    """Re-import services with RUST_AVAILABLE forced to `rust`."""
    import app.services.rust_accel as ra
    ra.RUST_AVAILABLE = rust
    # reload dependent modules so their module-level flags re-read (they call
    # the wrappers which read ra.RUST_AVAILABLE at call time, so no reload needed)
    from app.services.statistics import StatisticsService
    from app.services.mining import org_mining
    return StatisticsService(), org_mining


def norm_social(d):
    nodes = sorted((n["id"], n["frequency"]) for n in d["nodes"])
    edges = {(e["source"], e["target"]): e["frequency"] for e in d["edges"]}
    return nodes, edges, d["total_resources"], d["total_handovers"]


def norm_stats(d):
    # order-independent comparison for the activity lists
    def as_map(lst, key="frequency"):
        return {x["activity"]: x[key] for x in lst}
    return {
        "scalars": {k: d[k] for k in (
            "total_cases", "total_events", "total_activities",
            "avg_case_duration", "median_case_duration", "min_case_duration",
            "max_case_duration", "avg_events_per_case")},
        "start": as_map(d["start_activities"]),
        "end": as_map(d["end_activities"]),
        "freq": as_map(d["activity_frequencies"]),
        "rel": {x["activity"]: x["relative_frequency"] for x in d["activity_frequencies"]},
        "cot": {x["date"]: x["count"] for x in d["cases_over_time"]},
    }


def main():
    df = load()
    print(f"verify on {len(df):,} events / {df[CASE].nunique():,} cases\n")

    stats_rs, org_rs = run(True)
    soc_rs = org_rs.get_social_network(df)
    st_rs = stats_rs.compute_statistics(df)

    stats_py, org_py = run(False)
    soc_py = org_py.get_social_network(df)
    st_py = stats_py.compute_statistics(df)

    ok = True

    # ── social network ──
    a, b = norm_social(soc_rs), norm_social(soc_py)
    if a == b:
        print(f"[PASS] social_network: {len(soc_rs['nodes'])} nodes, "
              f"{len(soc_rs['edges'])} edges, {soc_rs['total_handovers']} handovers identical")
    else:
        ok = False
        print("[FAIL] social_network differs")
        print("  nodes equal:", a[0] == b[0], "| edges equal:", a[1] == b[1],
              "| totals:", a[2:], "vs", b[2:])
        if a[1] != b[1]:
            diff = {k: (a[1].get(k), b[1].get(k)) for k in set(a[1]) | set(b[1])
                    if a[1].get(k) != b[1].get(k)}
            print("  edge diffs (first 5):", dict(list(diff.items())[:5]))

    # ── statistics ──
    A, B = norm_stats(st_rs), norm_stats(st_py)
    for k in A:
        if A[k] != B[k]:
            ok = False
            print(f"[FAIL] statistics.{k} differs")
            if isinstance(A[k], dict):
                diff = {kk: (A[k].get(kk), B[k].get(kk)) for kk in set(A[k]) | set(B[k])
                        if A[k].get(kk) != B[k].get(kk)}
                print(f"   diffs (first 8): {dict(list(diff.items())[:8])}")
            else:
                print(f"   {A[k]} vs {B[k]}")
        else:
            print(f"[PASS] statistics.{k} identical")

    print("\n" + ("ALL PASS ✓" if ok else "DIFFERENCES FOUND ✗"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
