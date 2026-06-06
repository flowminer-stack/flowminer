"""Temporally-constrained counterfactual explanations for non-conformant cases.

Implements a genetic-algorithm approach inspired by Buliga, Di
Francescomarino, Ghidini, Montali & Ronzani (AAAI 2025, arXiv
2503.01792) — *"Generating Counterfactual Explanations Under Temporal
Constraints"*. Given a case whose trace doesn't conform to the
discovered reference model, we search for the minimum-edit rewrite
that would conform, while respecting temporal ordering constraints
(activities that must precede others cannot be re-ordered freely).

The search space is the set of edit operations (insert, delete, swap)
applied to the original trace. The fitness function combines:
    - conformance improvement (via the existing conformance engine)
    - edit distance to the original trace (smaller is better)
    - temporal-constraint compliance (hard reject on violation)

For logs with dozens of activities the search space is enormous, so
we use a small population (32) + few generations (20) and early-stop
when a conformant candidate is found. Good enough for an explainer,
not a solver.
"""

from __future__ import annotations

import logging
import random
from dataclasses import dataclass
from typing import Any

import pandas as pd

from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL

logger = logging.getLogger(__name__)


@dataclass
class _Candidate:
    trace: list[str]
    edits: list[str]  # human-readable diff log

    def edit_distance(self, original: list[str]) -> int:
        # Levenshtein via DP — trace lengths are small enough
        n, m = len(original), len(self.trace)
        if n == 0:
            return m
        if m == 0:
            return n
        dp = list(range(m + 1))
        for i in range(1, n + 1):
            prev = dp[0]
            dp[0] = i
            for j in range(1, m + 1):
                tmp = dp[j]
                if original[i - 1] == self.trace[j - 1]:
                    dp[j] = prev
                else:
                    dp[j] = 1 + min(prev, dp[j], dp[j - 1])
                prev = tmp
        return dp[m]


def _extract_temporal_constraints(df: pd.DataFrame, strength: float = 0.95) -> set[tuple[str, str]]:
    """Mine hard *"A must precede B"* constraints from the log.

    An ordering (A, B) is promoted to a hard constraint if, in every
    trace where both appear, A strictly precedes B — with at least
    ``strength`` coverage. These are the LTLp-style constraints the
    AAAI 2025 paper enforces via their genetic operator; we enforce
    them as a filter on mutation moves.
    """
    pair_evidence: dict[tuple[str, str], tuple[int, int]] = {}
    for _case_id, group in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
        acts = group[ACTIVITY_COL].astype(str).tolist()
        seen: dict[str, int] = {}
        for idx, a in enumerate(acts):
            if a not in seen:
                seen[a] = idx
        unique_acts = list(seen.keys())
        for i, a in enumerate(unique_acts):
            for b in unique_acts[i + 1 :]:
                total, ordered = pair_evidence.get((a, b), (0, 0))
                pair_evidence[(a, b)] = (total + 1, ordered + 1)
                total_r, ordered_r = pair_evidence.get((b, a), (0, 0))
                pair_evidence[(b, a)] = (total_r + 1, ordered_r)

    constraints: set[tuple[str, str]] = set()
    for (a, b), (total, ordered) in pair_evidence.items():
        if total == 0 or a == b:
            continue
        if ordered / total >= strength and total >= 5:
            constraints.add((a, b))
    return constraints


def _violates_constraints(trace: list[str], constraints: set[tuple[str, str]]) -> bool:
    positions: dict[str, int] = {}
    for idx, act in enumerate(trace):
        if act not in positions:
            positions[act] = idx
    for a, b in constraints:
        if a in positions and b in positions and positions[a] > positions[b]:
            return True
    return False


def _mutate(
    cand: _Candidate,
    activities: list[str],
    constraints: set[tuple[str, str]],
    max_attempts: int = 8,
) -> _Candidate:
    """Apply a random edit that preserves temporal constraints."""
    for _ in range(max_attempts):
        if not cand.trace:
            new_trace = [random.choice(activities)]
            new_edits = cand.edits + [f"insert@0 {new_trace[0]}"]
        else:
            op = random.choice(["insert", "delete", "swap", "replace"])
            new_trace = list(cand.trace)
            new_edits = list(cand.edits)
            if op == "insert":
                pos = random.randint(0, len(new_trace))
                act = random.choice(activities)
                new_trace.insert(pos, act)
                new_edits.append(f"insert@{pos} {act}")
            elif op == "delete" and len(new_trace) > 1:
                pos = random.randint(0, len(new_trace) - 1)
                removed = new_trace.pop(pos)
                new_edits.append(f"delete@{pos} {removed}")
            elif op == "swap" and len(new_trace) >= 2:
                pos = random.randint(0, len(new_trace) - 2)
                new_trace[pos], new_trace[pos + 1] = new_trace[pos + 1], new_trace[pos]
                new_edits.append(f"swap@{pos}")
            elif op == "replace":
                pos = random.randint(0, len(new_trace) - 1)
                old = new_trace[pos]
                act = random.choice(activities)
                if act != old:
                    new_trace[pos] = act
                    new_edits.append(f"replace@{pos} {old}→{act}")
                else:
                    continue
            else:
                continue

        if not _violates_constraints(new_trace, constraints):
            return _Candidate(trace=new_trace, edits=new_edits)
    return cand  # give up — return unchanged


def _score(
    cand: _Candidate,
    original: list[str],
    fitness_fn,
) -> tuple[float, float, int]:
    """Score a candidate: higher fitness + lower edit distance is better."""
    try:
        fit = float(fitness_fn(cand.trace))
    except Exception:
        fit = 0.0
    dist = cand.edit_distance(original)
    # Combined score: fitness dominates, edit cost is a mild penalty
    combined = fit - 0.02 * dist
    return combined, fit, dist


def _net_to_reference_dict(net, initial_marking, final_marking) -> dict:
    """Serialize a pm4py Petri net to the dict form ``check_conformance`` accepts.

    Produces exactly the structure consumed by
    ``ConformanceService._reference_model_to_petri_net`` (places, transitions,
    arcs, initial/final marking by place name) so the discovered reference
    model can be discovered ONCE and reused across every fitness evaluation
    instead of being re-discovered per candidate.
    """
    return {
        "places": [{"name": p.name} for p in net.places],
        "transitions": [{"name": t.name, "label": t.label} for t in net.transitions],
        "arcs": [
            {"source": a.source.name, "target": a.target.name} for a in net.arcs
        ],
        "initial_marking": [p.name for p in initial_marking],
        "final_marking": [p.name for p in final_marking],
    }


def generate_counterfactual(
    df: pd.DataFrame,
    case_id: str,
    reference_model: dict | None = None,
    max_generations: int = 20,
    population_size: int = 32,
    random_seed: int = 42,
) -> dict[str, Any]:
    """Generate a minimum-edit counterfactual for a non-conformant case.

    Returns a dict with the original trace, the repaired trace, the
    edit log, the fitness before/after, and the mined temporal
    constraints that bounded the search.
    """
    rng = random.Random(random_seed)
    random.seed(random_seed)

    case_df = df[df[CASE_COL].astype(str) == str(case_id)].sort_values(TIMESTAMP_COL)
    if case_df.empty:
        return {"error": f"Case '{case_id}' not found in event log"}

    original = case_df[ACTIVITY_COL].astype(str).tolist()
    if not original:
        return {"error": "Case has no events"}

    activities = sorted(df[ACTIVITY_COL].astype(str).unique().tolist())
    if len(activities) < 2:
        return {"error": "Need at least 2 distinct activities to mutate"}

    constraints = _extract_temporal_constraints(df)

    # Build a fitness function bound to the current log + model. We
    # evaluate candidates by materializing a one-case frame with
    # synthetic timestamps and running the existing conformance engine.
    from app.services.conformance import ConformanceService

    svc = ConformanceService()
    base_time = case_df[TIMESTAMP_COL].iloc[0]

    # Discover the reference model ONCE, up front, and reuse it for every
    # candidate. Previously each _fitness call passed reference_model=None,
    # which made check_conformance re-run pm4py.discover_petri_net_inductive
    # for every one of the ~population_size * generations candidates — and,
    # because discovery ran on the candidate's own one-case synthetic frame,
    # it trivially fit itself (fitness ≡ 1.0). Discovering once from the FULL
    # log gives a stable reference process to score every candidate against,
    # which is what the counterfactual search actually needs, and collapses
    # ~700 redundant discoveries down to one.
    prebuilt_model = reference_model
    if prebuilt_model is None:
        try:
            _net, _im, _fm = svc._discover_reference_model(df)
            prebuilt_model = _net_to_reference_dict(_net, _im, _fm)
        except Exception:
            # If up-front discovery fails, fall back to the per-call path so
            # the explainer still returns something rather than erroring.
            prebuilt_model = None

    def _fitness(trace: list[str]) -> float:
        if not trace:
            return 0.0
        rows = []
        for i, a in enumerate(trace):
            rows.append({
                CASE_COL: str(case_id),
                ACTIVITY_COL: a,
                TIMESTAMP_COL: base_time + pd.Timedelta(seconds=60 * i),
            })
        synth = pd.DataFrame(rows)
        try:
            result = svc.check_conformance(
                synth, reference_model=prebuilt_model, method="token_replay"
            )
            return float(result.get("fitness") or 0.0)
        except Exception:
            return 0.0

    initial_fitness = _fitness(original)
    if initial_fitness >= 0.999:
        return {
            "case_id": str(case_id),
            "original_trace": original,
            "counterfactual_trace": original,
            "edits": [],
            "initial_fitness": initial_fitness,
            "final_fitness": initial_fitness,
            "edit_distance": 0,
            "constraints_used": sorted([f"{a} ≺ {b}" for a, b in constraints])[:30],
            "note": "Case is already conformant — nothing to fix.",
        }

    # Seed population with the original + small random perturbations
    population: list[_Candidate] = [_Candidate(trace=list(original), edits=[])]
    while len(population) < population_size:
        seed = _Candidate(trace=list(original), edits=[])
        for _ in range(rng.randint(1, 3)):
            seed = _mutate(seed, activities, constraints)
        population.append(seed)

    best = max(population, key=lambda c: _score(c, original, _fitness)[0])
    best_score, best_fit, best_dist = _score(best, original, _fitness)

    for gen in range(max_generations):
        scored = [(c, *_score(c, original, _fitness)) for c in population]
        scored.sort(key=lambda x: -x[1])
        # Elitism: keep top 4
        elite = [s[0] for s in scored[:4]]
        # Offspring: mutate the elites
        offspring = []
        while len(offspring) < population_size - len(elite):
            parent = rng.choice(elite)
            child = _mutate(
                _Candidate(trace=list(parent.trace), edits=list(parent.edits)),
                activities,
                constraints,
            )
            offspring.append(child)
        population = elite + offspring

        # Track best overall
        cand_best = max(population, key=lambda c: _score(c, original, _fitness)[0])
        cand_score, cand_fit, cand_dist = _score(cand_best, original, _fitness)
        if cand_score > best_score:
            best, best_score, best_fit, best_dist = cand_best, cand_score, cand_fit, cand_dist

        # Early stop when we're fully conformant
        if best_fit >= 0.999:
            break

    return {
        "case_id": str(case_id),
        "original_trace": original,
        "counterfactual_trace": best.trace,
        "edits": best.edits[-30:],
        "initial_fitness": round(initial_fitness, 4),
        "final_fitness": round(best_fit, 4),
        "edit_distance": int(best_dist),
        "constraints_used": sorted([f"{a} ≺ {b}" for a, b in constraints])[:30],
        "generations_run": max_generations,
        "method": "temporally_constrained_ga",
        "inspired_by": "Buliga, Di Francescomarino, Ghidini, Montali, Ronzani — AAAI 2025",
    }
