"""Parse the BPIC2019 XES once and cache it as parquet for the analysis
benchmark (so each per-analysis subprocess reloads fast instead of re-parsing
695 MB of XML). Reports parse time + peak RSS + frame stats.
"""
import os
import sys
import time
import resource

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.mining_engine import mining_engine  # noqa: E402

XES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tests", "fixtures", "bpic", "BPI_Challenge_2019.xes",
)
OUT = "/tmp/bpic2019.parquet"


def main() -> None:
    t0 = time.perf_counter()
    df = mining_engine.load_event_log(
        file_path=XES,
        case_id_col="case:concept:name",
        activity_col="concept:name",
        timestamp_col="time:timestamp",
        resource_col="org:resource",
    )
    parse_s = time.perf_counter() - t0
    rows = len(df)
    cases = df["case:concept:name"].nunique()
    acts = df["concept:name"].nunique()
    mem_mb = df.memory_usage(deep=True).sum() / 1e6
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print(f"parse_seconds={parse_s:.1f}")
    print(f"rows={rows:,} cases={cases:,} activities={acts}")
    print(f"columns={list(df.columns)}")
    print(f"frame_mem_mb={mem_mb:.0f} peak_rss_mb={peak_mb:.0f}")
    t1 = time.perf_counter()
    df.to_parquet(OUT)
    print(f"parquet_write_seconds={time.perf_counter() - t1:.1f} path={OUT} size_mb={os.path.getsize(OUT)/1e6:.0f}")


if __name__ == "__main__":
    main()
