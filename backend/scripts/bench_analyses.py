"""Per-analysis benchmark on the cached BPIC2019 frame.

Each analysis runs in its OWN subprocess so peak RSS is isolated and a runaway
analysis can't take down the others. A per-worker address-space rlimit makes a
memory-bomb analysis raise MemoryError (reported) instead of OOM-killing the
box; a wall-clock timeout catches hangs (the "takes forever" / Cloudflare-520
case). Response size is measured too, since an oversized JSON is itself a 520
cause.

Usage:
    python scripts/bench_analyses.py            # driver: run all, print table
    python scripts/bench_analyses.py worker NAME # internal: run one analysis
"""
import json
import os
import resource
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PARQUET = "/tmp/bpic2019.parquet"
MEM_CAP_GB = 8          # per-worker address-space cap
TIMEOUT_S = 240         # per-worker wall-clock cap

# name -> callable(df) -> result dict. Built lazily inside the worker so the
# driver process never imports the (heavy) engine.
def _analyses():
    from app.services.mining_engine import mining_engine as m
    return {
        "discover_dfg": lambda df: m.run_discovery(df, "dfg"),
        "discover_inductive": lambda df: m.run_discovery(df, "inductive"),
        "discover_heuristic": lambda df: m.run_discovery(df, "heuristic"),
        "performance_dfg": lambda df: m.get_performance_dfg(df),
        "statistics": lambda df: m.compute_statistics(df),
        "variants": lambda df: m.run_variant_analysis(df),
        "bottlenecks": lambda df: m.run_bottleneck_analysis(df),
        "root_cause": lambda df: m.run_root_cause_analysis(df),
        "rework": lambda df: m.get_rework(df),
        "efg": lambda df: m.get_efg(df),
        "temporal_profile": lambda df: m.get_temporal_profile(df),
        "batches": lambda df: m.get_batches(df),
        "case_overlap": lambda df: m.get_case_overlap(df),
        "sna": lambda df: m.get_sna(df),
        "org_roles": lambda df: m.get_org_roles(df),
        "cases": lambda df: m.get_cases(df),
        "timeline": lambda df: m.get_timeline(df),
        "dotted_chart": lambda df: m.get_dotted_chart(df),
        "performance_spectrum": lambda df: m.get_performance_spectrum(df),
        "log_skeleton": lambda df: m.get_log_skeleton(df),
        "declare": lambda df: m.get_declare(df),
        "conformance_auto": lambda df: m.run_conformance(df, method="auto"),
        "insights": lambda df: m.generate_insights(df),
        "summary": lambda df: m.generate_summary(df),
        "baseline_load_only": lambda df: {"_noop": True},
    }


def run_worker(name: str) -> None:
    # Cap address space so an allocation bomb fails cleanly.
    soft = MEM_CAP_GB * 1024**3
    try:
        resource.setrlimit(resource.RLIMIT_AS, (soft, soft))
    except (ValueError, OSError):
        pass
    import pandas as pd
    fns = _analyses()
    fn = fns[name]
    base = pd.read_parquet(PARQUET)
    df = base.copy(deep=False)  # fresh id => cold transition cache, like a request
    t0 = time.perf_counter()
    err = None
    result_bytes = -1
    try:
        result = fn(df)
        secs = time.perf_counter() - t0
        try:
            result_bytes = len(json.dumps(result, default=str))
        except Exception:  # noqa: BLE001
            result_bytes = -1
    except MemoryError:
        secs = time.perf_counter() - t0
        err = f"MemoryError (>{MEM_CAP_GB}GB)"
    except Exception as e:  # noqa: BLE001
        secs = time.perf_counter() - t0
        err = f"{type(e).__name__}: {str(e)[:160]}"
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print("BENCH_RESULT " + json.dumps({
        "name": name, "ok": err is None, "seconds": round(secs, 2),
        "peak_rss_mb": round(peak_mb), "result_mb": round(result_bytes / 1e6, 2) if result_bytes >= 0 else None,
        "error": err,
    }))


def driver() -> None:
    names = list(_analyses().keys())
    rows = []
    for name in names:
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "worker", name],
            capture_output=True, text=True, timeout=None,
            env={**os.environ},
        ) if False else None
        # use Popen + timeout so a hang is reported, not raised
        try:
            cp = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "worker", name],
                capture_output=True, text=True, timeout=TIMEOUT_S,
            )
            line = next((l for l in cp.stdout.splitlines() if l.startswith("BENCH_RESULT ")), None)
            if line:
                rows.append(json.loads(line[len("BENCH_RESULT "):]))
            elif cp.returncode < 0:
                rows.append({"name": name, "ok": False, "seconds": None, "peak_rss_mb": None,
                             "result_mb": None, "error": f"KILLED/OOM (signal {-cp.returncode})"})
            else:
                tail = (cp.stderr.strip().splitlines() or ["no output"])[-1][:160]
                rows.append({"name": name, "ok": False, "seconds": None, "peak_rss_mb": None,
                             "result_mb": None, "error": f"crash: {tail}"})
        except subprocess.TimeoutExpired:
            rows.append({"name": name, "ok": False, "seconds": TIMEOUT_S, "peak_rss_mb": None,
                         "result_mb": None, "error": f"TIMEOUT (>{TIMEOUT_S}s)"})
        r = rows[-1]
        print(f"  {r['name']:<22} {str(r['seconds']):>7}s  rss={str(r['peak_rss_mb']):>6}MB  "
              f"resp={str(r['result_mb']):>6}MB  {'OK' if r['ok'] else r['error']}", flush=True)

    base = next((r for r in rows if r["name"] == "baseline_load_only"), None)
    floor = base["peak_rss_mb"] if base and base["peak_rss_mb"] else 0
    print("\n=== SUMMARY (sorted by seconds; rss floor ~%d MB just to load) ===" % floor)
    def keyf(r):
        return (r["seconds"] if isinstance(r["seconds"], (int, float)) else 1e9)
    for r in sorted(rows, key=keyf, reverse=True):
        if r["name"] == "baseline_load_only":
            continue
        d_rss = (r["peak_rss_mb"] - floor) if r.get("peak_rss_mb") else None
        print(f"{r['name']:<22} secs={str(r['seconds']):>7}  peakRSS={str(r['peak_rss_mb']):>6}MB  "
              f"ΔRSS={str(d_rss):>6}MB  resp={str(r['result_mb']):>6}MB  {'' if r['ok'] else '<< '+str(r['error'])}")
    print("\nJSON " + json.dumps(rows))


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "worker":
        run_worker(sys.argv[2])
    else:
        driver()
