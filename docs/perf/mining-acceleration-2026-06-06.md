# Process-mining performance audit — BPIC2019 (2026-06-06)

Profiled every discovery/analysis function on the real **BPI Challenge 2019**
log (`docs/examples/bpic2019_p2p.csv.gz` — 1,595,923 events / 251,734 cases /
42 activities) and accelerated the slow paths.

Benchmark harnesses (reusable): `backend/scripts/bench_mining.py`,
`bench_scaling.py`. Correctness gates: `verify_accel.py`, `verify_heuristic.py`,
`verify_edge_cases.py`.

## Headline finding: the Rust accel module was never built locally

`backend/rust_accel/` (a pyo3/maturin crate with ~20 native algorithms) was
**not compiled** in the dev environment, so `RUST_AVAILABLE` was `False` and
*every* analysis silently ran its pure-Python/pm4py fallback. Building it
(`maturin develop --release`) reactivates DFG, variants, bottleneck, temporal
profile, case-overlap, SNA, token-replay, precision, generalization, etc.

It also exposed a latent build bug: `rust_accel/pyproject.toml` had no
`project.version`, which modern maturin (≥1.4) refuses to build — this would
also break the Docker image build. Fixed with `dynamic = ["version"]` (sources
the version from `Cargo.toml`).

## Full-log timings (Rust ON), before → after this change

| Function | Before | After | Speedup | Notes |
|---|---:|---:|---:|---|
| `social_network` (handover) | 27.6s | **0.31s** | ~89× | new Rust `compute_handover_network` |
| `statistics` | 11.0s | **0.40s** | ~28× | new Rust `compute_log_statistics` + vectorised `cases_over_time` |
| `split_miner` (= UI "heuristic") | 31.9s | **1.6s** | ~20× | wired existing-but-dormant Rust heuristic miner; **output identical** to pm4py (Jaccard 1.0) |
| `discover_dfg` | — | 0.96s | — | already Rust (was dormant) |
| `variant_analysis` | — | 0.30s | — | already Rust (was dormant) |
| `bottleneck` | — | 1.28s | — | already Rust (was dormant) |

Two pure-Python hot loops (`social_network`, `statistics`) and the
`cases_over_time` `.apply(lambda)` (9.3s of the 11s!) were the real offenders;
`split_miner` was paying for `pm4py.discover_petri_net_heuristics` on 1.6M rows.

## Not changed (deliberately)

| Function | Full-log | Why left as-is |
|---|---:|---|
| `discover_inductive` | **43.0s** | **Now ported to Rust** (see below) but kept on pm4py in the service — it is the conformance *reference model*, so changing its provenance is out of scope for this pass. |
| `discover_alpha` | 2.4s | Acceptable; no Rust path, low usage. |
| `discover_heuristic` | 4.3s | Kept on pm4py — the simplified Rust net construction differs on *unfiltered* output (edge Jaccard 0.46). It is not reachable from the discovery dispatcher (which routes `"heuristic"→split_miner`). |

> **Update (wired in):** the Rust IM is now wired into the service via
> `rust_accel.discover_inductive_net` (Rust tree → pm4py `fold`+`tree_sort`+
> `convert_to_petri_net`) and used by `discovery.discover_inductive` (IM /
> noise_threshold=0 only) and `conformance._discover_reference_model` (hence all
> conformance methods + counterfactual), with a pm4py fallback. Verified on all
> 6 logs: net structure, the `_petri_net_to_dict` activity graph, AND
> conformance fitness/precision/generalization are **identical** to pm4py;
> BPIC2019 discovery 41.4s → **0.63s (65×)**. See `scripts/verify_inductive_net.py`.

## Inductive Miner — Rust port

`rust_accel/src/inductive.rs` is a faithful port of pm4py 2.7.22.4's IM
(log-based / UVCL variant): same framework order (empty-trace handling →
base cases → cuts → fall-throughs), all four cuts (XOR connected-components,
StrictSequence with `_skippable` + alphabet-cluster merging, Concurrency, and
this build's two-group Loop with the four reachability checks), every
projection, and all six fall-throughs. Exposed as
`flowminer_accel.discover_inductive_tree`; **not** wired into the discovery
service.

Verified against `pm4py.discover_process_tree_inductive` on **every bundled
flat log** — equal by pm4py's own `structurally_language_equal` *and* by exact
canonical-string match (`fold` + `tree_sort`):

| log | events | acts | rust | pm4py | speedup | tree | equal |
|---|--:|--:|--:|--:|--:|--:|:--|
| running-example | 42 | 8 | 0.000s | 0.003s | 37× | 14 | exact |
| HR_Onboarding.1 | 6,000 | 6 | 0.000s | 0.003s | 42× | 7 | exact |
| HR_Onboarding.2 | 8,000 | 8 | 0.000s | 0.003s | 41× | 9 | exact |
| tpch_order_to_cash | 6,000 | 4 | 0.000s | 0.003s | 44× | 7 | exact |
| sepsis | 15,214 | 16 | 0.006s | 0.283s | 45× | 61 | exact |
| **bpic2019** | **1,595,923** | **42** | **0.438s** | **40.96s** | **94×** | **160** | **exact** |

(OCEL files — `container_logistics.json`, `sample-order-management.jsonocel` —
are object-centric, not flat logs, so the flat IM does not apply. The 695 MB
`BPI_Challenge_2019.xes` is the same data as the gzipped CSV.)

Proof + benchmark harness: `scripts/verify_inductive.py`. To wire it in later,
convert the returned tree to a pm4py net (`pm4py.convert_to_petri_net`) and feed
the existing `_petri_net_to_dict`.

## Round 2 — compute + memory sweep

A 6-agent audit of the backend ranked 71 hotspots by (memory + compute) ×
hot-path × scale ÷ risk. Implemented + verified the top batch:

| Hotspot | Before | After | Win | Verified |
|---|--:|--:|---|---|
| **predictive `_extract_prefix_features`** (Rust `compute_prefix_features`; all 4 predictive endpoints) | 20.7s / 1.59 GB | **1.2s / 653 MB** | 18× CPU, 2.4× mem | exact parity (discrete+float) |
| **`anonymize_df`** (runs before *every* non-admin mining request) | 8.6s / 262 MB | **0.10s / 93 MB** | 88× CPU, −169 MB | byte-identical, input untouched |
| **`bottleneck` DBSM branch** (every bottleneck request) | 1.20s / 397 MB | **0.29s / 84 MB** | 4.1× CPU, −313 MB | DBSM scores identical (max Δ 0.0) |
| **`cluster_log_dbscan` matrix** | O(cases×events) | **O(events)** pivot | 100–1000× on large logs | matrix `array_equal` |

How:
- **predictive** — new Rust `compute_prefix_features` builds the per-(case,
  prefix) feature rows in one native pass (running unique-set, no O(L²)
  recompute), returning numpy columns so the DataFrame has no per-row Python
  objects. Also fixed a latent non-determinism bug: the pandas fallback sorted
  by timestamp only (non-stable), so prefixes varied run-to-run on tied
  timestamps — now a stable `[case, ts]` sort, matching Rust.
- **anonymizer** — shallow `copy(deep=False)` + reassign only the pseudonymised
  columns (untouched columns are shared, not deep-copied), and hash only each
  column's *distinct* values (628 resources, not 1.6M rows).
- **bottleneck** — Rust `compute_bottlenecks` now also returns each activity's
  `p95_duration`, so the DBSM branch no longer rebuilds a per-event `valid`
  frame (it was doing two full-log sorts/copies on every request).
- **dbscan** — replaced the per-case `df[df[CASE]==id]` scan with one
  `groupby([case, act]).size().unstack()` pivot.

### Round 2b — backlog cleared (12 targets, parallel file-disjoint agents + verified)

Quick wins (all verified output-identical):
- `_ocel_counts` → `len(ocel.events)`/`len(ocel.objects)` (was building the
  extended-table cross-join + `ocel_objects_summary` just to count — ~4000× on
  the 190-event sample).
- `ocel_state_aware` — relation annotation O(R×E)→O(R) via id→ts/type dicts;
  dropped 3 read-only `.copy()`; mode transitions via `groupby.shift()`.
- `sustainability` — three `apply(axis=1)` → numpy `Series.map(factor)` arrays;
  **fixed an in-place mutation of the cached frame** (was `sorted_df = df` then
  column assignment).
- `insights` — case durations / ties / inversions vectorized; removed the
  double full-frame `assign` (matters ×15 on the OCEL summary path).
- `queue_mining`/`data_quality`/`drift` — dropped redundant `.copy()`/sorts.
- `case_explorer` (timeline, dotted-chart) — iterrows → vectorized `to_dict`.
- `filter_engine` — lazy per-metric series + `(df[ACT]==v).groupby(case).any()`.

Bigger bets (verified against the HEAD versions):
- `conformance` — `_jsd_stochastic_conformance` + `compute_stochastic_conformance`
  variant builders now reuse Rust `analyze_variants` (one pass vs per-case sort
  in a Python groupby loop); EMD switched to the scipy-first path, avoiding the
  eager pm4py `EventLog` (~up to 10M `Pm4pyEvent` objects). Variant counters
  verified identical on sepsis/running-example.
- `simulation_des` — three per-case sort+loop passes collapsed into one
  stable-sorted vectorized pass (shifts + `groupby.first/last` + DFG counts);
  params identical on no-tie logs, deterministic on tied logs.
- `counterfactual` — **correctness fix, NOT a speedup** (kept by explicit
  decision). The GA scored each candidate by conformance fitness, but the old
  `_fitness` discovered the reference model from the candidate's *own* 1-case
  synthetic frame, which the inductive miner fits perfectly — so fitness was a
  constant ≈1.0 for every trace (verified: real order / reversed / all-same /
  random garbage all scored 1.000). The GA therefore had zero signal and
  `initial_fitness≈1.0` made the function early-return "nothing to fix" for
  every case — the feature was a silent no-op. Now the reference model is
  discovered **once from the full log** and every candidate is scored against
  it (same traces now score 0.50 / 0.625 / 0.000 / 0.524). This adds one
  full-log inductive discovery per request (slightly slower; e.g. 0.09s→0.40s on
  sepsis) — it is a behavior/correctness change, not a perf win. (An earlier
  note here claimed a ~700→1 discovery speedup; that was based on a wrong audit
  assumption — the old code discovered from the tiny synth, not the full log.)
- `ingestion.repair_timestamps` — the 1.6M-row `df.at` scalar-write loop
  vectorized (bit-identical repaired timestamps + report).

Cross-cutting: several of these (predictive, social_network, conformance,
simulation, ocel_state_aware) hardened the same latent bug — pandas' default
**unstable** `sort_values(timestamp)` made tied-timestamp ordering
non-deterministic; all now use a stable `[case, ts]` sort.

(`discover_heuristic` was flagged by the audit but is dead code — the dispatcher
routes `"heuristic"→split_miner`; left as-is.)

## Correctness

All accelerated paths verified to match their pure-Python reference **exactly**
on the full 1.6M-event log and on synthetic edge cases (tied timestamps,
single-event cases, single global case, multi-year month bucketing, null
resources, empty log, NaN activity).

Three bugs were caught and fixed during verification (the last via an
adversarial multi-agent code review of the diff):
1. **Non-determinism (pre-existing):** `get_social_network` sorted each case
   with pandas' non-stable quicksort, so handover counts varied run-to-run on
   day-granularity logs (48k events sit on tied timestamps in a 50k-case
   slice). The Rust path is deterministic (stable row-order tie-break); the
   Python fallback was switched to `kind="mergesort"` to match.
2. **NaN-activity panic:** a null activity encodes to category code `-1`, which
   indexed out of bounds in `compute_log_statistics` (and pyo3's
   `PanicException` is not caught by `except Exception`). The wrapper now
   detects negative codes and defers to the pandas path, which handles NaN via
   `dropna()`.
3. **NaT-timestamp duration corruption:** a `NaT` timestamp encodes to
   `i64::MIN`; the µs/ms→ns `*1000` scaling then overflows, producing a garbage
   (often negative) case duration — whereas the pandas path skips `NaT` in its
   `groupby().agg(['min','max'])`. Both wrappers now bail to pandas when any
   timestamp is `NaT`, and the Rust duration math was promoted to `i128` so the
   subtraction can never wrap (defense-in-depth). Verified: with a `NaT` row the
   Rust and pandas outputs are identical and no negative durations appear.

Verification tooling lives in `backend/scripts/` and doubles as a regression
suite (there was no prior test coverage for these services).
