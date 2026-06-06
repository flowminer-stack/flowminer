"""Scaling sweep: how the discovery miners and Python-only analyses grow
with case count on BPIC2019. Confirms which functions become 'incredibly slow'
on the large dataset."""
from __future__ import annotations
import gzip, sys, time, signal
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
CSV = ROOT.parent / "docs" / "examples" / "bpic2019_p2p.csv.gz"
CASE, ACT, TS, RES = "case:concept:name", "concept:name", "time:timestamp", "org:resource"


def load():
    with gzip.open(CSV, "rt") as f:
        df = pd.read_csv(f)
    df = df.rename(columns={"case_id": CASE, "activity": ACT, "timestamp": TS, "resource": RES})
    df[TS] = pd.to_datetime(df[TS], utc=True, errors="coerce")
    return df.dropna(subset=[TS])


def sub(df, n):
    cases = df[CASE].drop_duplicates().head(n)
    return df[df[CASE].isin(set(cases))].copy()


class TimeoutErr(Exception): ...
def _alarm(sig, frm): raise TimeoutErr()


def timed(label, fn, limit=120):
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(limit)
    t = time.perf_counter()
    try:
        fn(); dt = time.perf_counter() - t; note = "ok"
    except TimeoutErr:
        dt = time.perf_counter() - t; note = f">{limit}s TIMEOUT"
    except Exception as e:
        dt = time.perf_counter() - t; note = f"ERR {type(e).__name__}: {str(e)[:60]}"
    finally:
        signal.alarm(0)
    print(f"    {label:<22} {dt:8.3f}s  {note}")
    return dt


def main():
    from app.services.discovery import DiscoveryService
    from app.services.statistics import StatisticsService
    from app.services.mining import org_mining
    df = load()
    disc, stats = DiscoveryService(), StatisticsService()
    print(f"full: {len(df):,} events / {df[CASE].nunique():,} cases\n")
    for n in [5_000, 20_000, 50_000, 100_000, df[CASE].nunique()]:
        d = sub(df, n)
        print(f"── {d[CASE].nunique():,} cases / {len(d):,} events ──")
        timed("alpha", lambda: disc.discover_alpha(d))
        timed("heuristic", lambda: disc.discover_heuristic(d))
        timed("inductive", lambda: disc.discover_inductive(d))
        timed("split_miner", lambda: disc.discover(d, "split_miner"))
        timed("statistics", lambda: stats.compute_statistics(d))
        timed("social_network", lambda: org_mining.get_social_network(d))
        print()


if __name__ == "__main__":
    main()
