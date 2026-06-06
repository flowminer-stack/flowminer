"""Verify the Rust-IM-derived Petri net matches pm4py's on every bundled log:
net structure, the discovered activity graph (_petri_net_to_dict), and
conformance numbers (fitness/precision/generalization) — plus discovery timing."""
from __future__ import annotations
import gzip, sys, time
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
EX = ROOT.parent / "docs" / "examples"
CASE, ACT, TS = "case:concept:name", "concept:name", "time:timestamp"

import pm4py
import app.services.rust_accel as ra
from app.services.discovery import DiscoveryService
from app.services.conformance import ConformanceService

LOGS = [
    ("running-example.csv", "case:concept:name", "concept:name", "time:timestamp", False),
    ("HR_Onboarding.1.csv", "Employee_ID", "Activity", "Timestamp", False),
    ("HR_Onboarding.2.csv", "Employee_ID", "Activity", "Timestamp", False),
    ("tpch_order_to_cash.csv", "case_id", "activity", "timestamp", False),
    ("sepsis.csv", "case_id", "activity", "timestamp", False),
    ("bpic2019_p2p.csv.gz", "case_id", "activity", "timestamp", True),
]


def load(fname, ccol, acol, tcol, gz):
    p = EX / fname
    df = pd.read_csv(gzip.open(p, "rt")) if gz else pd.read_csv(p)
    df = df.rename(columns={ccol: CASE, acol: ACT, tcol: TS})[[CASE, ACT, TS]]
    df[CASE] = df[CASE].astype(str); df[ACT] = df[ACT].astype(str)
    df[TS] = pd.to_datetime(df[TS], utc=True, errors="coerce")
    return df.dropna(subset=[TS]).sort_values([CASE, TS], kind="stable").reset_index(drop=True)


def net_shape(net):
    labels = sorted(t.label for t in net.transitions if t.label is not None)
    n_silent = sum(1 for t in net.transitions if t.label is None)
    return (len(net.places), len(net.transitions), len(net.arcs), n_silent, tuple(labels))


def graph_sets(res):
    return (frozenset(n["id"] for n in res["nodes"]),
            frozenset((e["source"], e["target"]) for e in res["edges"]))


def main():
    disc = DiscoveryService()
    conf = ConformanceService()
    print(f"{'log':<24}{'rust disc':>10}{'pm4py disc':>11}{'speedup':>8}  "
          f"{'net(P/T/A)':>14}  net=  graph=  conf=")
    print("-" * 92)
    allok = True
    for fname, c, a, t, gz in LOGS:
        df = load(fname, c, a, t, gz)

        ra.RUST_AVAILABLE = True
        t0 = time.perf_counter(); rs = ra.discover_inductive_net(df); rt = time.perf_counter() - t0
        t0 = time.perf_counter()
        pm = pm4py.discover_petri_net_inductive(df, case_id_key=CASE, activity_key=ACT, timestamp_key=TS)
        pt = time.perf_counter() - t0

        net_eq = net_shape(rs[0]) == net_shape(pm[0])
        # activity graph via _petri_net_to_dict
        g_rs = graph_sets(disc._petri_net_to_dict(rs[0], rs[1], rs[2], df))
        g_pm = graph_sets(disc._petri_net_to_dict(pm[0], pm[1], pm[2], df))
        graph_eq = g_rs == g_pm

        # conformance numbers: reference = rust net vs pm4py net
        rmodel = disc._petri_net_to_dict  # not used; build dicts via conformance helper
        cf_rs = conf.check_conformance(df, reference_model=_net_to_dict(rs), method="token_replay")
        cf_pm = conf.check_conformance(df, reference_model=_net_to_dict(pm), method="token_replay")
        def k(c): return (round(c["fitness"], 6), round(c.get("precision") or 0, 6),
                          round(c.get("generalization") or 0, 6))
        conf_eq = k(cf_rs) == k(cf_pm)

        ok = net_eq and graph_eq and conf_eq
        allok &= ok
        sp = pt / rt if rt > 0 else float("inf")
        P, T, A, _, _ = net_shape(rs[0])
        print(f"{fname:<24}{rt:>9.3f}s{pt:>10.3f}s{sp:>7.0f}x  {P:>4}/{T:>3}/{A:>4}  "
              f"{'Y' if net_eq else 'N':>4}  {'Y' if graph_eq else 'N':>5}  {'Y' if conf_eq else 'N':>4}")
        if not ok:
            print(f"    rust net={net_shape(rs[0])}\n    pm4y net={net_shape(pm[0])}")
            print(f"    conf rust={k(cf_rs)} pm={k(cf_pm)}")
    print("-" * 92)
    print("ALL NETS MATCH pm4py ✓" if allok else "MISMATCH ✗")
    return 0 if allok else 1


def _net_to_dict(triple):
    net, im, fm = triple
    return {
        "places": [{"name": p.name} for p in net.places],
        "transitions": [{"name": t.name, "label": t.label} for t in net.transitions],
        "arcs": [{"source": a.source.name, "target": a.target.name} for a in net.arcs],
        "initial_marking": [p.name for p in im],
        "final_marking": [p.name for p in fm],
    }


if __name__ == "__main__":
    raise SystemExit(main())
