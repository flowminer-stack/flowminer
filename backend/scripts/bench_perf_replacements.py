"""
Perf + parity bench for optimised analyses vs. pm4py.

Run inside the backend container:
    docker exec processmining-backend-1 python3 /app/scripts/bench_perf_replacements.py

Fails (non-zero exit) on any correctness mismatch between the new
mining_engine implementations and pm4py's reference output. Prints a
before/after timing table so we can see the speedup per log.

Design — hanging-call guard
───────────────────────────
pm4py's heavy algorithms (precision_token_based_replay on very long
traces) can hang for >10 minutes in C code and ignore Python-level
signals / thread cancellation. The Python `concurrent.futures` approach
leaks stranded threads that hold multi-GB of state.

To actually bound the wall time, each analysis × each fixture runs in a
freshly-spawned child subprocess with `subprocess.run(..., timeout=CAP)`.
When the child exceeds the cap, Python kills it (SIGKILL) and the
parent records it as TIMED-OUT. Stranded pm4py state dies with the
child. The parent process stays clean for the next fixture.

Run-one-fixture mode:
    python bench_perf_replacements.py --run-one <LABEL> <PATH> <CASE> <ACT> <TS> <ANALYSIS>
This is the per-child entrypoint. It loads the log, runs the one
analysis both ways, prints a single JSON line to stdout, and exits.
"""
from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import sys
import time
from pathlib import Path

# Quiet pm4py's tqdm progress bars
os.environ.setdefault("PM4PY_DISABLE_PROGRESS_BAR", "1")

# ── fixtures ──────────────────────────────────────────────────────────

# (label, file_path, case_id_col, activity_col, timestamp_col)
FIXTURES: list[tuple[str, str, str, str, str]] = [
    (
        "running-example (6×6)",
        "/data/uploads/5597743b-db20-44f8-bc24-69bd38af79ab/09abf064a8534c479042ad0836e6604c_running-example.csv",
        "Case ID",
        "Activity",
        "Timestamp",
    ),
    (
        "HR_Onboarding (1000×6)",
        "/data/uploads/b91ec801-ace3-45b2-9e09-39423761d741/cbea35819f19407d84d1d4aa5a073037_HR_Onboarding.1.csv",
        "Employee_ID",
        "Activity",
        "Timestamp",
    ),
    (
        "Transport Document flatten (594×4.3)",
        "/data/uploads/flattened/f8e4df30abe54cb484c70eef12b5dc65_Transport Document_flattened.csv",
        "case:concept:name",
        "concept:name",
        "time:timestamp",
    ),
    (
        "Forklift flatten (3×2579)",
        "/data/uploads/flattened/a304b0b92d504c59847d94c1b4335f48_Forklift_flattened.csv",
        "case:concept:name",
        "concept:name",
        "time:timestamp",
    ),
]

ANALYSES = ["efg", "temporal_profile", "log_skeleton", "conformance"]

# Per-child wall-clock cap. User asked for "ridiculously high" — 5
# minutes is way longer than any honest algorithm needs. A subprocess
# that exceeds this is genuinely broken.
CAP_SEC = 300


# ── helpers ───────────────────────────────────────────────────────────


def approx_equal(a, b, rel: float = 1e-4, abs_: float = 1e-9) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return math.isclose(float(a), float(b), rel_tol=rel, abs_tol=abs_)
    except (TypeError, ValueError):
        return False


def _log_skeleton_canonicalise(obj):
    """Replicates the private `_convert` helper inside
    `mining_engine.get_log_skeleton`. Used by the bench to transform
    pm4py's raw output into exactly the shape the service produces,
    so parity checks compare apples to apples.
    """
    if isinstance(obj, dict):
        return {str(k): _log_skeleton_canonicalise(v) for k, v in obj.items()}
    if isinstance(obj, (set, frozenset)):
        return [_log_skeleton_canonicalise(i) for i in sorted(str(x) for x in obj)]
    if isinstance(obj, (tuple, list)):
        return [_log_skeleton_canonicalise(i) for i in obj]
    return obj


# ── child-mode: run one analysis in this subprocess and emit JSON ─────


def _run_one(label: str, path: str, case_col: str, act_col: str, ts_col: str,
             analysis: str) -> dict:
    """Load the fixture and run exactly one analysis both ways. Returns a
    dict that the parent process decodes. Any exception bubbles up and is
    written as a `crashed` record before re-raising."""

    import pandas as pd
    import pm4py

    # Be loud about what pm4py is doing so we can diagnose hangs.
    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("pm4py").setLevel(logging.INFO)

    from app.services.mining_engine import mining_engine
    from app.services.ingestion import (
        IngestionService,
        CASE_COL,
        ACTIVITY_COL,
        TIMESTAMP_COL,
    )

    ingestion = IngestionService()
    df = ingestion.load_event_log(path, case_col, act_col, ts_col)

    pm_kw = dict(
        case_id_key=CASE_COL,
        activity_key=ACTIVITY_COL,
        timestamp_key=TIMESTAMP_COL,
    )

    def timeit(fn, *args, **kwargs):
        t0 = time.perf_counter()
        out = fn(*args, **kwargs)
        return out, time.perf_counter() - t0

    errors: list[str] = []

    if analysis == "efg":
        ref, t_ref = timeit(pm4py.discover_eventually_follows_graph, df, **pm_kw)
        ours, t_ours = timeit(mining_engine.get_efg, df)
        ours_map = {
            (p["source"], p["target"]): int(p["frequency"]) for p in ours["pairs"]
        }
        ref_map = {(str(a), str(b)): int(n) for (a, b), n in ref.items()}
        missing = set(ref_map) - set(ours_map)
        extra = set(ours_map) - set(ref_map)
        if missing:
            errors.append(f"EFG missing {len(missing)} pairs, e.g. {sorted(missing)[:3]}")
        if extra:
            errors.append(f"EFG extra {len(extra)} pairs, e.g. {sorted(extra)[:3]}")
        diffs = [
            (k, ref_map[k], ours_map[k])
            for k in ref_map
            if k in ours_map and ref_map[k] != ours_map[k]
        ]
        if diffs:
            errors.append(f"EFG freq mismatch on {len(diffs)} pairs, e.g. {diffs[:3]}")

    elif analysis == "temporal_profile":
        ref, t_ref = timeit(pm4py.discover_temporal_profile, df, **pm_kw)
        ours, t_ours = timeit(mining_engine.get_temporal_profile, df)
        ours_map = {
            (p["source"], p["target"]): (p["mean"], p["stdev"])
            for p in ours["profiles"]
        }
        ref_map = {
            (str(a), str(b)): (float(m), float(s)) for (a, b), (m, s) in ref.items()
        }
        missing = set(ref_map) - set(ours_map)
        extra = set(ours_map) - set(ref_map)
        if missing:
            errors.append(f"TP missing {len(missing)} pairs, e.g. {sorted(missing)[:3]}")
        if extra:
            errors.append(f"TP extra {len(extra)} pairs, e.g. {sorted(extra)[:3]}")
        stat_mismatch = 0
        first = None
        for k in ref_map.keys() & ours_map.keys():
            rm, rs = ref_map[k]
            om, os = ours_map[k]
            if not (approx_equal(rm, om) and approx_equal(rs, os)):
                stat_mismatch += 1
                if first is None:
                    first = (k, (rm, rs), (om, os))
        if stat_mismatch:
            errors.append(
                f"TP stat mismatch on {stat_mismatch} pairs, first: {first}"
            )

    elif analysis == "log_skeleton":
        ref, t_ref = timeit(
            pm4py.discover_log_skeleton,
            df,
            activity_key=ACTIVITY_COL,
            case_id_key=CASE_COL,
        )
        ours, t_ours = timeit(mining_engine.get_log_skeleton, df)
        # Run pm4py's output through the same normalizer our service uses
        # (see `_convert` in mining_engine.get_log_skeleton) so we're
        # comparing serialised-for-frontend shape against serialised-for-
        # frontend shape.
        ref_c = _log_skeleton_canonicalise(ref)
        ours_c = ours["constraints"]
        for fam in ("equivalence", "always_after", "always_before",
                    "never_together", "directly_follows", "activ_freq"):
            if ref_c.get(fam) is None and ours_c.get(fam) is None:
                continue
            if ref_c.get(fam) != ours_c.get(fam):
                errors.append(f"LogSkeleton family {fam} mismatch")

    elif analysis == "conformance":
        # Run ours first.
        ours, t_ours = timeit(
            mining_engine.run_conformance, df, method="token_replay"
        )
        # Reference: fitness (always) + precision (only when the prefix
        # workload is within the same cap the service uses). Without this
        # guard the reference precision_token_based_replay hangs forever
        # on logs like the Forklift flatten (~20M prefix ops) even though
        # our service skips precision on the same input. The bench
        # therefore mirrors the service's skip rule so we compare apples
        # to apples.
        PRECISION_WORKLOAD_CAP = 5_000_000
        trace_lengths = df.groupby("case:concept:name", sort=False).size()
        prefix_workload = int((trace_lengths ** 2).sum())
        net, im, fm = pm4py.discover_petri_net_inductive(df, **pm_kw)
        t0 = time.perf_counter()
        ref_fit = pm4py.fitness_token_based_replay(df, net, im, fm, **pm_kw)
        if prefix_workload > PRECISION_WORKLOAD_CAP:
            ref_prec = None
        else:
            try:
                ref_prec = float(
                    pm4py.precision_token_based_replay(
                        df, net, im, fm, **pm_kw
                    )
                )
            except Exception as e:
                ref_prec = None
                errors.append(
                    f"pm4py precision raised: {type(e).__name__}: {str(e)[:80]}"
                )
        t_ref = time.perf_counter() - t0
        if not approx_equal(
            ours["fitness"], float(ref_fit.get("average_trace_fitness", 0.0))
        ):
            errors.append(
                f"conformance fitness mismatch: ours={ours['fitness']} ref={ref_fit}"
            )
        if ref_prec is not None and not approx_equal(ours.get("precision"), ref_prec):
            errors.append(
                f"conformance precision mismatch: ours={ours.get('precision')} ref={ref_prec}"
            )

    else:
        raise ValueError(f"unknown analysis: {analysis}")

    return {
        "label": label,
        "analysis": analysis,
        "t_ref": t_ref,
        "t_ours": t_ours,
        "errors": errors,
    }


# ── parent-mode: fan out to one subprocess per analysis ───────────────


def _spawn_one(label: str, path: str, case_col: str, act_col: str, ts_col: str,
               analysis: str) -> dict:
    """Run one analysis in a fresh subprocess with a hard wall-clock cap."""
    cmd = [
        sys.executable,
        "-u",
        __file__,
        "--run-one",
        label,
        path,
        case_col,
        act_col,
        ts_col,
        analysis,
    ]
    env = dict(os.environ)
    env["PYTHONPATH"] = "/app"
    env["PM4PY_DISABLE_PROGRESS_BAR"] = "1"
    t0 = time.perf_counter()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CAP_SEC,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {
            "label": label,
            "analysis": analysis,
            "t_ref": CAP_SEC,
            "t_ours": CAP_SEC,
            "errors": [f"subprocess TIMEOUT (>{CAP_SEC}s, hard-killed)"],
            "timed_out": True,
            "wall": time.perf_counter() - t0,
        }

    if result.returncode != 0:
        return {
            "label": label,
            "analysis": analysis,
            "t_ref": 0.0,
            "t_ours": 0.0,
            "errors": [f"subprocess crashed (rc={result.returncode})",
                       (result.stderr or "").strip().splitlines()[-3:]],
            "wall": time.perf_counter() - t0,
        }

    # Find the JSON record — last JSON line in stdout
    record = None
    for line in reversed(result.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                record = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if record is None:
        return {
            "label": label,
            "analysis": analysis,
            "t_ref": 0.0,
            "t_ours": 0.0,
            "errors": ["no JSON record from child"],
            "wall": time.perf_counter() - t0,
        }
    record["wall"] = time.perf_counter() - t0
    return record


def main_parent() -> int:
    print(
        f"{'log':42s} {'analysis':18s} {'pm4py':>14s} {'ours':>10s} {'speedup':>10s}  status"
    )
    print("-" * 108)
    hard_fail = False
    parity_warnings = 0
    for fix in FIXTURES:
        label, path = fix[0], fix[1]
        if not Path(path).exists():
            print(f"{label:42s}  SKIP — file not found: {path}")
            continue
        for analysis in ANALYSES:
            rec = _spawn_one(*fix, analysis)
            t_ref = rec.get("t_ref", 0.0)
            t_ours = rec.get("t_ours", 0.0)
            timed_out = rec.get("timed_out", False)
            errors = rec.get("errors") or []
            if timed_out:
                t_ref_str = f">{CAP_SEC}s"
                t_ours_str = f">{CAP_SEC}s"
                speed = "—"
            else:
                t_ref_str = f"{t_ref:10.3f}s"
                t_ours_str = f"{t_ours:9.3f}s"
                speed = f"{t_ref / t_ours:.1f}x" if t_ours > 0 else "∞"
            is_real_mismatch = any(
                isinstance(e, str)
                and ("mismatch" in e or "missing" in e or "extra" in e or "crashed" in e)
                for e in errors
            )
            if is_real_mismatch:
                hard_fail = True
                status = "FAIL"
            elif errors or timed_out:
                parity_warnings += 1
                status = "WARN"
            else:
                status = "OK"
            print(
                f"{label:42s} {analysis:18s} {t_ref_str:>14s} {t_ours_str:>10s} {speed:>10s}  {status}"
            )
            for err in errors:
                if isinstance(err, list):
                    for line in err:
                        print(f"  └─ {line}")
                else:
                    print(f"  └─ {err}")
    print()
    print(
        f"Parity warnings (non-fatal): {parity_warnings}. Hard fails: {int(hard_fail)}."
    )
    return 1 if hard_fail else 0


def main_child(argv: list[str]) -> int:
    # Call shape: --run-one LABEL PATH CASE ACT TS ANALYSIS
    _, label, path, case_col, act_col, ts_col, analysis = argv
    try:
        rec = _run_one(label, path, case_col, act_col, ts_col, analysis)
    except Exception as e:
        rec = {
            "label": label,
            "analysis": analysis,
            "t_ref": 0.0,
            "t_ours": 0.0,
            "errors": [f"child crashed: {type(e).__name__}: {str(e)[:160]}"],
        }
    print(json.dumps(rec), flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--run-one":
        sys.exit(main_child(sys.argv[1:]))
    sys.exit(main_parent())
