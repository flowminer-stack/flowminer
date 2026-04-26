"""
Discrete-Event Simulation (DES) engine for FlowMiner.

Inspired by Simod (Camargo et al., BPM 2020 / SoftwareX 2025).
Uses simpy for the event loop when available; falls back to a pure-Python
priority-queue scheduler otherwise.

Distribution choices (v1):
  - Inter-arrival times: exponential (mean = observed mean inter-arrival)
  - Activity durations: empirical bootstrap (sample from observed values)
  - Gateway branching: empirical multinomial from observed directly-follows
"""

from __future__ import annotations

import heapq
import logging
import math
import random
import statistics
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

# ─── Simpy import with graceful fallback ────────────────────────────────────

try:
    import simpy  # type: ignore

    _SIMPY = True
except ImportError:
    simpy = None  # type: ignore
    _SIMPY = False
    logger.warning("simpy not available — DES will use pure-Python fallback scheduler")


# ─── Constants ────────────────────────────────────────────────────────────────

CASE_COL = "case:concept:name"
ACTIVITY_COL = "concept:name"
TIMESTAMP_COL = "time:timestamp"
RESOURCE_COL = "org:resource"

_MAX_SAMPLES = 200  # cap stored per-activity samples


# ─── Pure-Python fallback event loop ─────────────────────────────────────────


class _PQueue:
    """Priority queue of (timestamp, seq, callback) events."""

    def __init__(self) -> None:
        self._heap: list[tuple[float, int, Any]] = []
        self._seq = 0
        self.now: float = 0.0

    def schedule(self, delay: float, cb) -> None:
        heapq.heappush(self._heap, (self.now + delay, self._seq, cb))
        self._seq += 1

    def run_until_empty(self) -> None:
        while self._heap:
            t, _, cb = heapq.heappop(self._heap)
            self.now = t
            cb()


# ─── DESSimulator ─────────────────────────────────────────────────────────────


class DESSimulator:
    """
    Mine simulation parameters from an event log and run what-if DES scenarios.
    """

    # ------------------------------------------------------------------
    # Parameter mining
    # ------------------------------------------------------------------

    def mine_simulation_parameters(self, df: pd.DataFrame) -> dict:
        """
        Extract simulation parameters from a standard event-log DataFrame.

        Returns a dict with keys:
          arrival_distribution, activity_durations, gateway_probabilities,
          resource_pools, hourly_calendar
        """
        df = df.copy()

        # Normalise column names (tolerate missing cols gracefully)
        case_col = _find_col(df, CASE_COL, "case")
        act_col = _find_col(df, ACTIVITY_COL, "activity", "concept:name")
        ts_col = _find_col(df, TIMESTAMP_COL, "timestamp", "time:timestamp")
        res_col = _find_col(df, RESOURCE_COL, "resource", "org:resource")

        if case_col is None or act_col is None or ts_col is None:
            raise ValueError(
                "DataFrame must contain case, activity, and timestamp columns"
            )

        # Ensure timestamps are datetime
        df[ts_col] = pd.to_datetime(df[ts_col], utc=True, errors="coerce")
        df = df.dropna(subset=[ts_col])
        df = df.sort_values([case_col, ts_col])

        # ── Arrival distribution ──────────────────────────────────────
        # Inter-arrival time between consecutive case *starts*
        case_starts = (
            df.groupby(case_col)[ts_col].min().sort_values().reset_index()
        )
        case_starts.columns = ["case_id", "start_ts"]
        inter_arrivals_s: list[float] = []
        starts = case_starts["start_ts"].tolist()
        for i in range(1, len(starts)):
            delta = (starts[i] - starts[i - 1]).total_seconds()
            if delta > 0:
                inter_arrivals_s.append(delta)

        if inter_arrivals_s:
            mean_iat = statistics.mean(inter_arrivals_s)
        else:
            mean_iat = 3600.0  # fallback: 1 case/hour

        arrival_distribution = {
            "kind": "exponential",
            "lambda": 1.0 / mean_iat if mean_iat > 0 else 1.0 / 3600.0,
            "mean_inter_arrival_s": mean_iat,
        }

        # ── Activity durations ────────────────────────────────────────
        activity_durations: dict[str, dict] = {}
        case_groups = df.groupby(case_col)
        act_dur_map: dict[str, list[float]] = {}
        for _, grp in case_groups:
            grp = grp.sort_values(ts_col)
            activities = grp[act_col].tolist()
            times = grp[ts_col].tolist()
            for i in range(len(activities) - 1):
                dur = (times[i + 1] - times[i]).total_seconds()
                if dur >= 0:
                    act_dur_map.setdefault(activities[i], []).append(dur)

        for act, durs in act_dur_map.items():
            if not durs:
                continue
            mean_d = statistics.mean(durs)
            std_d = statistics.stdev(durs) if len(durs) > 1 else 0.0
            activity_durations[act] = {
                "mean": mean_d,
                "std": std_d,
                "samples": durs[:_MAX_SAMPLES],
                "count": len(durs),
            }

        # ── Gateway probabilities ─────────────────────────────────────
        # P(A→B) = freq(A→B) / sum_x(freq(A→x))
        edge_counts: dict[tuple[str, str], int] = {}
        out_counts: dict[str, int] = {}
        for _, grp in case_groups:
            grp = grp.sort_values(ts_col)
            acts = grp[act_col].tolist()
            for i in range(len(acts) - 1):
                edge = (acts[i], acts[i + 1])
                edge_counts[edge] = edge_counts.get(edge, 0) + 1
                out_counts[acts[i]] = out_counts.get(acts[i], 0) + 1

        gateway_probabilities: dict[str, dict[str, float]] = {}
        for (src, tgt), cnt in edge_counts.items():
            total = out_counts.get(src, 1)
            gateway_probabilities.setdefault(src, {})[tgt] = cnt / total

        # ── Resource pools ────────────────────────────────────────────
        resource_pools: dict[str, dict] = {}
        if res_col and res_col in df.columns:
            res_counts = (
                df.groupby([act_col, res_col])
                .size()
                .reset_index(name="count")
            )
            # Primary resource per activity = most frequent
            act_resource: dict[str, str] = {}
            for _, row in (
                res_counts.sort_values("count", ascending=False)
                .drop_duplicates(subset=[act_col])
                .iterrows()
            ):
                act_resource[row[act_col]] = row[res_col]

            # Build pools: each distinct resource, default capacity 1
            res_case_counts = df.groupby(res_col)[case_col].nunique()
            for res, ncases in res_case_counts.items():
                resource_pools[str(res)] = {
                    "capacity": 1,
                    "cases_handled": int(ncases),
                }

        # ── Hourly calendar ───────────────────────────────────────────
        if hasattr(df[ts_col].iloc[0], "hour"):
            hour_counts = df[ts_col].dt.hour.value_counts().sort_index()
        else:
            hour_counts = pd.Series(dtype=int)

        total_events = len(df)
        hourly_calendar: dict[int, float] = {}
        for h in range(24):
            hourly_calendar[h] = hour_counts.get(h, 0) / max(total_events, 1)

        # ── Activity→resource mapping (used by simulator) ─────────────
        act_resource_map: dict[str, str | None] = {}
        if res_col and res_col in df.columns:
            for act, res in (
                df.groupby(act_col)[res_col]
                .agg(lambda x: x.mode().iloc[0] if len(x) > 0 else None)
                .items()
            ):
                act_resource_map[act] = str(res) if res is not None else None
        else:
            for act in activity_durations:
                act_resource_map[act] = None

        # ── Start / sink activities ───────────────────────────────────
        start_activities: list[str] = []
        sink_activities: list[str] = []
        for _, grp in case_groups:
            grp = grp.sort_values(ts_col)
            acts = grp[act_col].tolist()
            if acts:
                start_activities.append(acts[0])
                sink_activities.append(acts[-1])

        from collections import Counter

        start_counter = Counter(start_activities)
        sink_counter = Counter(sink_activities)
        most_common_start = start_counter.most_common(3)
        most_common_sink = sink_counter.most_common(3)

        return {
            "arrival_distribution": arrival_distribution,
            "activity_durations": activity_durations,
            "gateway_probabilities": gateway_probabilities,
            "resource_pools": resource_pools,
            "hourly_calendar": hourly_calendar,
            "act_resource_map": act_resource_map,
            "start_activities": [a for a, _ in most_common_start],
            "sink_activities": [a for a, _ in most_common_sink],
            "total_cases_observed": df[case_col].nunique(),
        }

    # ------------------------------------------------------------------
    # Simulation
    # ------------------------------------------------------------------

    def simulate(
        self,
        params: dict,
        scenario: dict,
        runs: int = 5,
        max_cases: int = 1000,
    ) -> dict:
        """
        Run `runs` DES replications with the given scenario and compute
        aggregate results alongside a no-scenario baseline.

        scenario fields (all optional):
          arrival_rate_multiplier: float = 1.0
          activity_duration_overrides: {activity: multiplier}
          activity_automation: {activity: True}  # duration → 0
          resource_pool_overrides: {resource: capacity}
          new_resources: [{name, capacity}]
        """
        # ── Run scenario ──────────────────────────────────────────────
        scenario_runs = [
            self._single_run(params, scenario, max_cases, seed=i)
            for i in range(runs)
        ]
        scenario_summary = _aggregate_runs(scenario_runs)

        # ── Run baseline (empty scenario) ─────────────────────────────
        baseline_runs = [
            self._single_run(params, {}, max_cases, seed=i + 1000)
            for i in range(runs)
        ]
        baseline_summary = _aggregate_runs(baseline_runs)

        # ── Deltas ────────────────────────────────────────────────────
        def _pct_change(new: float, old: float) -> float:
            if old == 0:
                return 0.0
            return (new - old) / old * 100.0

        delta = {
            "avg_case_duration_pct": _pct_change(
                scenario_summary["avg_case_duration_s"],
                baseline_summary["avg_case_duration_s"],
            ),
            "throughput_pct": _pct_change(
                scenario_summary["throughput_cases_per_day"],
                baseline_summary["throughput_cases_per_day"],
            ),
            "p50_pct": _pct_change(
                scenario_summary["p50"],
                baseline_summary["p50"],
            ),
            "p90_pct": _pct_change(
                scenario_summary["p90"],
                baseline_summary["p90"],
            ),
            "p95_pct": _pct_change(
                scenario_summary["p95"],
                baseline_summary["p95"],
            ),
        }

        return {
            "summary": scenario_summary,
            "baseline": baseline_summary,
            "delta": delta,
            "runs": runs,
        }

    # ------------------------------------------------------------------
    # Internal single-run
    # ------------------------------------------------------------------

    def _single_run(
        self,
        params: dict,
        scenario: dict,
        max_cases: int,
        seed: int = 42,
    ) -> dict:
        rng = random.Random(seed)

        arrival_dist = params.get("arrival_distribution", {})
        act_durs = params.get("activity_durations", {})
        gw_probs = params.get("gateway_probabilities", {})
        res_pools = dict(params.get("resource_pools", {}))
        act_res_map = params.get("act_resource_map", {})
        start_acts = params.get("start_activities", [])
        sink_acts = params.get("sink_activities", [])

        # Apply scenario overrides
        arr_mult = float(scenario.get("arrival_rate_multiplier", 1.0))
        dur_overrides: dict[str, float] = scenario.get(
            "activity_duration_overrides", {}
        )
        automations: dict[str, bool] = scenario.get("activity_automation", {})
        pool_overrides: dict[str, int] = scenario.get(
            "resource_pool_overrides", {}
        )
        new_resources: list[dict] = scenario.get("new_resources", [])

        # Merge resource pool capacities
        effective_pools: dict[str, int] = {}
        for name, info in res_pools.items():
            cap = pool_overrides.get(name, info.get("capacity", 1))
            effective_pools[name] = max(1, int(cap))
        for nr in new_resources:
            effective_pools[nr["name"]] = max(1, int(nr.get("capacity", 1)))

        # Mean inter-arrival with multiplier
        mean_iat = arrival_dist.get("mean_inter_arrival_s", 3600.0)
        if arr_mult > 0:
            mean_iat = mean_iat / arr_mult  # more cases = shorter gaps

        if _SIMPY:
            return self._run_simpy(
                rng, max_cases, mean_iat, act_durs, gw_probs,
                effective_pools, act_res_map, start_acts, sink_acts,
                dur_overrides, automations,
            )
        else:
            return self._run_pqueue(
                rng, max_cases, mean_iat, act_durs, gw_probs,
                effective_pools, act_res_map, start_acts, sink_acts,
                dur_overrides, automations,
            )

    # ------------------------------------------------------------------
    # Simpy implementation
    # ------------------------------------------------------------------

    def _run_simpy(
        self,
        rng, max_cases, mean_iat, act_durs, gw_probs,
        effective_pools, act_res_map, start_acts, sink_acts,
        dur_overrides, automations,
    ) -> dict:
        env = simpy.Environment()
        sim_resources = {
            name: simpy.Resource(env, capacity=cap)
            for name, cap in effective_pools.items()
        }
        case_durations: list[float] = []
        resource_busy: dict[str, float] = {n: 0.0 for n in effective_pools}
        concurrent_tracker: list[int] = []
        active_cases = [0]

        def run_case(case_id: int):
            start = env.now
            active_cases[0] += 1
            concurrent_tracker.append(active_cases[0])

            path = _sample_path(rng, start_acts, sink_acts, gw_probs)
            for act in path:
                dur = _sample_duration(rng, act, act_durs, dur_overrides, automations)
                res_name = act_res_map.get(act)
                if res_name and res_name in sim_resources:
                    with sim_resources[res_name].request() as req:
                        yield req
                        resource_busy[res_name] = resource_busy.get(res_name, 0.0) + dur
                        yield env.timeout(dur)
                else:
                    yield env.timeout(max(dur, 0.001))

            active_cases[0] -= 1
            case_durations.append(env.now - start)

        def arrival_gen():
            for i in range(max_cases):
                iat = rng.expovariate(1.0 / max(mean_iat, 0.001))
                yield env.timeout(iat)
                env.process(run_case(i))

        env.process(arrival_gen())
        sim_time = mean_iat * max_cases * 1.5
        env.run(until=sim_time)

        return _compile_run_stats(
            case_durations, resource_busy, effective_pools, concurrent_tracker, sim_time
        )

    # ------------------------------------------------------------------
    # Pure-Python fallback
    # ------------------------------------------------------------------

    def _run_pqueue(
        self,
        rng, max_cases, mean_iat, act_durs, gw_probs,
        effective_pools, act_res_map, start_acts, sink_acts,
        dur_overrides, automations,
    ) -> dict:
        """Minimal event-loop DES without resource contention modelling."""
        case_durations: list[float] = []
        concurrent_tracker: list[int] = []
        active_cases = [0]
        resource_busy: dict[str, float] = {n: 0.0 for n in effective_pools}

        # Pre-schedule all arrival times
        t = 0.0
        arrivals: list[tuple[float, int]] = []
        for i in range(max_cases):
            t += rng.expovariate(1.0 / max(mean_iat, 0.001))
            arrivals.append((t, i))

        sim_time = t + mean_iat * 10

        for start_t, case_id in arrivals:
            active_cases[0] += 1
            concurrent_tracker.append(active_cases[0])
            cur_t = start_t

            path = _sample_path(rng, start_acts, sink_acts, gw_probs)
            for act in path:
                dur = _sample_duration(rng, act, act_durs, dur_overrides, automations)
                res_name = act_res_map.get(act)
                if res_name and res_name in effective_pools:
                    resource_busy[res_name] = resource_busy.get(res_name, 0.0) + dur
                cur_t += max(dur, 0.0)

            active_cases[0] -= 1
            case_durations.append(cur_t - start_t)

        return _compile_run_stats(
            case_durations, resource_busy, effective_pools, concurrent_tracker, sim_time
        )


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _find_col(df: pd.DataFrame, *candidates: str) -> str | None:
    for c in candidates:
        if c in df.columns:
            return c
    # case-insensitive fallback
    lower = {col.lower(): col for col in df.columns}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def _sample_duration(
    rng: random.Random,
    activity: str,
    act_durs: dict,
    dur_overrides: dict[str, float],
    automations: dict[str, bool],
) -> float:
    if automations.get(activity):
        return 0.0
    multiplier = float(dur_overrides.get(activity, 1.0))
    info = act_durs.get(activity)
    if not info:
        return 0.0
    samples = info.get("samples")
    if samples:
        dur = rng.choice(samples)
    else:
        mean = info.get("mean", 0.0)
        std = info.get("std", 0.0)
        dur = max(0.0, rng.gauss(mean, std)) if std > 0 else mean
    return max(0.0, dur * multiplier)


def _sample_path(
    rng: random.Random,
    start_acts: list[str],
    sink_acts: list[str],
    gw_probs: dict[str, dict[str, float]],
    max_steps: int = 100,
) -> list[str]:
    if not start_acts:
        return []
    current = rng.choice(start_acts)
    path = [current]
    sink_set = set(sink_acts)
    for _ in range(max_steps):
        if current in sink_set:
            break
        successors = gw_probs.get(current)
        if not successors:
            break
        targets = list(successors.keys())
        weights = [successors[t] for t in targets]
        total = sum(weights)
        if total <= 0:
            break
        r = rng.random() * total
        cumul = 0.0
        chosen = targets[-1]
        for t, w in zip(targets, weights):
            cumul += w
            if r <= cumul:
                chosen = t
                break
        path.append(chosen)
        current = chosen
    return path


def _compile_run_stats(
    case_durations: list[float],
    resource_busy: dict[str, float],
    effective_pools: dict[str, int],
    concurrent_tracker: list[int],
    sim_time: float,
) -> dict:
    if not case_durations:
        return {
            "avg_case_duration_s": 0.0,
            "p50": 0.0,
            "p90": 0.0,
            "p95": 0.0,
            "throughput_cases_per_day": 0.0,
            "max_concurrent_cases": 0,
            "resource_utilization": {},
        }
    sorted_d = sorted(case_durations)
    n = len(sorted_d)

    def _pct(p: float) -> float:
        idx = min(int(p * n), n - 1)
        return sorted_d[idx]

    utilization: dict[str, float] = {}
    for res, busy in resource_busy.items():
        cap = effective_pools.get(res, 1)
        utilization[res] = min(1.0, busy / max(sim_time * cap, 0.001))

    throughput = n / max(sim_time / 86400.0, 0.001)

    return {
        "avg_case_duration_s": statistics.mean(case_durations),
        "p50": _pct(0.50),
        "p90": _pct(0.90),
        "p95": _pct(0.95),
        "throughput_cases_per_day": throughput,
        "max_concurrent_cases": max(concurrent_tracker) if concurrent_tracker else 0,
        "resource_utilization": utilization,
    }


def _aggregate_runs(run_stats: list[dict]) -> dict:
    if not run_stats:
        return {
            "avg_case_duration_s": 0.0,
            "p50": 0.0,
            "p90": 0.0,
            "p95": 0.0,
            "throughput_cases_per_day": 0.0,
            "max_concurrent_cases": 0,
            "resource_utilization": {},
        }

    def _mean(key: str) -> float:
        vals = [r[key] for r in run_stats if isinstance(r.get(key), (int, float))]
        return statistics.mean(vals) if vals else 0.0

    # Merge resource utilization dicts
    all_res: set[str] = set()
    for r in run_stats:
        all_res.update(r.get("resource_utilization", {}).keys())

    util_agg: dict[str, float] = {}
    for res in all_res:
        vals = [
            r["resource_utilization"][res]
            for r in run_stats
            if res in r.get("resource_utilization", {})
        ]
        util_agg[res] = statistics.mean(vals) if vals else 0.0

    return {
        "avg_case_duration_s": _mean("avg_case_duration_s"),
        "p50": _mean("p50"),
        "p90": _mean("p90"),
        "p95": _mean("p95"),
        "throughput_cases_per_day": _mean("throughput_cases_per_day"),
        "max_concurrent_cases": int(
            max((r.get("max_concurrent_cases", 0) for r in run_stats), default=0)
        ),
        "resource_utilization": util_agg,
    }
