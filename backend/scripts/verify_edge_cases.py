"""Edge-case parity tests for the Rust-accelerated statistics + social network:
synthetic logs the BPIC2019 verification may not exercise."""
from __future__ import annotations
import sys
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
CASE, ACT, TS, RES = "case:concept:name", "concept:name", "time:timestamp", "org:resource"
import app.services.rust_accel as ra
from app.services.statistics import StatisticsService
from app.services.mining import org_mining

ss = StatisticsService()


def mk(rows):
    df = pd.DataFrame(rows, columns=[CASE, ACT, TS, RES])
    df[TS] = pd.to_datetime(df[TS], utc=True)
    return df


def norm_stats(d):
    def m(lst, k="frequency"):
        return {x["activity"]: x[k] for x in lst}
    return (
        {k: d[k] for k in ("total_cases", "total_events", "total_activities",
                           "avg_case_duration", "median_case_duration",
                           "min_case_duration", "max_case_duration", "avg_events_per_case")},
        m(d["start_activities"]), m(d["end_activities"]), m(d["activity_frequencies"]),
        {x["date"]: x["count"] for x in d["cases_over_time"]},
    )


def norm_soc(d):
    return (sorted((n["id"], n["frequency"]) for n in d["nodes"]),
            {(e["source"], e["target"]): e["frequency"] for e in d["edges"]},
            d["total_resources"], d["total_handovers"])


CASES = {
    "tied_ts_within_case": [
        ("c1", "A", "2020-01-01", "r1"), ("c1", "B", "2020-01-01", "r2"),
        ("c1", "C", "2020-01-01", "r1"), ("c1", "D", "2020-01-02", "r3"),
        ("c2", "A", "2020-01-01", "r2"), ("c2", "B", "2020-01-03", "r2"),
    ],
    "single_event_cases": [
        ("c1", "A", "2020-01-01", "r1"),
        ("c2", "A", "2020-01-05", "r2"),
        ("c3", "B", "2020-03-01", "r1"),
    ],
    "single_global_case": [
        ("only", "A", "2021-06-01", "r1"), ("only", "B", "2021-06-02", "r1"),
        ("only", "C", "2021-06-03", "r2"),
    ],
    "long_range_months": [
        ("c1", "A", "2018-01-01", "r1"), ("c1", "B", "2021-12-01", "r2"),
        ("c2", "A", "2019-06-15", "r1"), ("c2", "C", "2020-06-15", "r2"),
    ],
    "null_resources": [
        ("c1", "A", "2020-01-01", None), ("c1", "B", "2020-01-02", "r1"),
        ("c1", "C", "2020-01-03", None), ("c2", "A", "2020-01-01", "r1"),
        ("c2", "B", "2020-01-02", "r2"),
    ],
}

ok_all = True
for name, rows in CASES.items():
    df = mk(rows)
    ra.RUST_AVAILABLE = True
    sr, ser = ss.compute_statistics(df), org_mining.get_social_network(df)
    ra.RUST_AVAILABLE = False
    sp, sep = ss.compute_statistics(df), org_mining.get_social_network(df)
    ra.RUST_AVAILABLE = True
    st_ok = norm_stats(sr) == norm_stats(sp)
    soc_ok = norm_soc(ser) == norm_soc(sep)
    ok_all &= st_ok and soc_ok
    print(f"[{'PASS' if st_ok else 'FAIL'}] statistics   {name}")
    if not st_ok:
        for a, b, lbl in zip(norm_stats(sr), norm_stats(sp),
                             ["scalars", "start", "end", "freq", "cot"]):
            if a != b:
                print(f"        {lbl}: rust={a} py={b}")
    print(f"[{'PASS' if soc_ok else 'FAIL'}] social_net    {name}")
    if not soc_ok:
        print(f"        rust={norm_soc(ser)}\n        py  ={norm_soc(sep)}")

# NaN activity: Rust path must fall back gracefully, not crash
ra.RUST_AVAILABLE = True
df_nan = mk([("c1", "A", "2020-01-01", "r1"), ("c1", None, "2020-01-02", "r1")])
try:
    r = ss.compute_statistics(df_nan)
    print(f"[PASS] statistics   nan_activity (no crash, {r['total_events']} events, "
          f"{r['total_activities']} acts)")
except Exception as e:
    ok_all = False
    print(f"[FAIL] statistics   nan_activity crashed: {type(e).__name__}: {e}")

# Empty df
df_empty = mk([]).iloc[0:0]
try:
    r = ss.compute_statistics(df_empty)
    s = org_mining.get_social_network(df_empty)
    print(f"[PASS] empty_df (stats total_cases={r['total_cases']}, "
          f"soc resources={s['total_resources']})")
except Exception as e:
    ok_all = False
    print(f"[FAIL] empty_df crashed: {type(e).__name__}: {e}")

print("\n" + ("ALL EDGE CASES PASS ✓" if ok_all else "EDGE-CASE FAILURES ✗"))
sys.exit(0 if ok_all else 1)
