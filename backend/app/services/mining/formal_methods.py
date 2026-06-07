"""Declarative / formal process models: DCR rules, LTL-f checking, log skeleton, DECLARE."""

import logging
from typing import Optional

import numpy as np
import pandas as pd

from app.services.ingestion import (
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
)
from app.services.rust_accel import (
    discover_performance_dfg as _rs_perf_dfg,
    compute_efg as _rs_efg,
    compute_temporal_profile as _rs_temporal,
    compute_sna as _rs_sna,
    compute_case_overlap as _rs_case_overlap,
    compute_rework as _rs_rework,
    compute_edge_stats as _rs_edge_stats,
)

logger = logging.getLogger(__name__)


def discover_dcr_rules(df: pd.DataFrame) -> dict:
    """Discover a minimal DCR graph (conditions + responses) from the log.

    - Condition(A, B): every trace containing B also contains A strictly
      before it. "B requires A."
    - Response(A, B): every trace containing A also contains B strictly
      after it. "A obliges B."
    """
    trace_count = 0
    trace_contains: dict[str, int] = {}
    pair_count: dict[tuple[str, str], int] = {}

    for _, grp in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
        trace_count += 1
        acts = [str(a) for a in grp[ACTIVITY_COL].tolist()]
        for a in set(acts):
            trace_contains[a] = trace_contains.get(a, 0) + 1
        for i, a in enumerate(acts):
            for b in acts[i + 1:]:
                if a != b:
                    pair_count[(a, b)] = pair_count.get((a, b), 0) + 1

    conditions = []
    responses = []
    for (a, b), count in pair_count.items():
        if trace_contains.get(b, 0) > 0 and count == trace_contains[b]:
            conditions.append({"trigger": b, "condition": a, "trace_support": count})
        if trace_contains.get(a, 0) > 0 and count == trace_contains[a]:
            responses.append({"trigger": a, "response": b, "trace_support": count})

    conditions.sort(key=lambda r: -r["trace_support"])
    responses.sort(key=lambda r: -r["trace_support"])

    return {
        "total_cases": trace_count,
        "conditions": conditions[:100],
        "responses": responses[:100],
    }


def check_ltl(df: pd.DataFrame, formula: str) -> dict:
    """Evaluate a small LTL-f dialect against every case in the log.

    This is a lightweight, custom evaluator tailored to the most
    common compliance patterns. Full LTL is not supported — users
    who need that should use the log skeleton endpoint.

    Supported operators (case-insensitive):
      - ``ACTIVITY BEFORE ACTIVITY`` : first must appear before second
      - ``ACTIVITY AFTER ACTIVITY``  : first must appear after second
      - ``ACTIVITY ALWAYS_WITH ACTIVITY`` : presence implies presence
      - ``ACTIVITY NEVER_WITH ACTIVITY``  : mutually exclusive
      - ``ACTIVITY AT_LEAST_ONCE``
      - ``ACTIVITY EXACTLY_ONCE``
      - ``NOT <expr>``, ``<expr> AND <expr>``, ``<expr> OR <expr>``
    Parentheses group expressions.

    Case IDs and activity names are matched against the literal
    string in the formula.
    """
    import re

    compiled = _compile_ltl(formula)

    compliant = 0
    total = 0
    violations: list[dict] = []
    for case_id, grp in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
        acts = grp[ACTIVITY_COL].tolist()
        total += 1
        if compiled(acts):
            compliant += 1
        else:
            if len(violations) < 200:
                violations.append({"case_id": str(case_id), "activities": [str(a) for a in acts]})

    return {
        "formula": formula,
        "total_cases": total,
        "compliant_cases": compliant,
        "compliance_rate": round(compliant / total, 3) if total else 0.0,
        "sample_violations": violations,
    }


def _compile_ltl(formula: str):
    """Compile a subset of LTL-f into a callable (acts: list[str]) -> bool."""
    import re

    tokens = re.findall(
        r"\(|\)|AND|OR|NOT|BEFORE|AFTER|ALWAYS_WITH|NEVER_WITH|AT_LEAST_ONCE|EXACTLY_ONCE|[A-Za-z_][\w\-\s]*",
        formula,
        flags=re.IGNORECASE,
    )
    # Normalize: strip whitespace from activity tokens
    tokens = [t.strip() for t in tokens if t.strip()]

    def parse(idx=0):
        # simple recursive-descent: expr := atom ( (AND|OR) atom )*
        def atom(i):
            if i >= len(tokens):
                return (lambda _a: True), i
            t = tokens[i]
            up = t.upper()
            if up == "(":
                fn, i2 = parse(i + 1)
                # Expect close paren
                if i2 < len(tokens) and tokens[i2] == ")":
                    return fn, i2 + 1
                return fn, i2
            if up == "NOT":
                sub, i2 = atom(i + 1)
                return (lambda a, sub=sub: not sub(a)), i2
            # Otherwise treat t as an activity name, then look ahead for
            # a binary operator.
            if i + 1 >= len(tokens):
                name = t
                return (lambda a, n=name: n in a), i + 1
            op = tokens[i + 1].upper()
            if op in ("BEFORE", "AFTER", "ALWAYS_WITH", "NEVER_WITH"):
                if i + 2 >= len(tokens):
                    return (lambda _a: True), i + 2
                lhs, rhs = t, tokens[i + 2]
                if op == "BEFORE":
                    fn = lambda a, l=lhs, r=rhs: (l in a and r in a and a.index(l) < a.index(r))
                elif op == "AFTER":
                    fn = lambda a, l=lhs, r=rhs: (l in a and r in a and a.index(l) > a.index(r))
                elif op == "ALWAYS_WITH":
                    fn = lambda a, l=lhs, r=rhs: (l not in a) or (r in a)
                else:  # NEVER_WITH
                    fn = lambda a, l=lhs, r=rhs: not (l in a and r in a)
                return fn, i + 3
            if op in ("AT_LEAST_ONCE", "EXACTLY_ONCE"):
                name = t
                if op == "AT_LEAST_ONCE":
                    fn = lambda a, n=name: a.count(n) >= 1
                else:
                    fn = lambda a, n=name: a.count(n) == 1
                return fn, i + 2
            # No binary operator — just activity presence
            return (lambda a, n=t: n in a), i + 1

        fn, i = atom(idx)
        while i < len(tokens) and tokens[i].upper() in ("AND", "OR"):
            op = tokens[i].upper()
            rhs, i = atom(i + 1)
            if op == "AND":
                fn = (lambda a, l=fn, r=rhs: l(a) and r(a))
            else:
                fn = (lambda a, l=fn, r=rhs: l(a) or r(a))
        return fn, i

    fn, _ = parse()
    return fn


def get_log_skeleton(df: pd.DataFrame) -> dict:
    """
    Discover the log skeleton — six families of declarative constraints
    matching pm4py's `discover_log_skeleton` output exactly (noise=0).

    Faithful O(N·k) replacement
    ────────────────────────────
    pm4py's reference implementation calls `trace_skel.after` / `before`
    which generate every (i,j) pair in a trace — O(n²) per trace. On the
    Forklift log (3 cases × ~2579 events) that's ~20M Python tuples.

    This implementation builds the after-set for each unique trace
    variant in O(n·k) by walking left-to-right with a running "seen"
    set. Before-set is derived by swapping; combos (for
    never_together) by taking k² pairs from the activity set;
    directly-follows by a single adjacent-pair scan. All family
    accumulators use the exact same `>= all_activs[x]` threshold that
    pm4py uses, so the output set is byte-identical to pm4py's.

    Families (pm4py semantics, reproduced verbatim):
      - equivalence:     (x,y) where every trace has freq[x] == freq[y]
      - always_after:    (A,B) where every trace has exactly one A and
                         ≥1 B after it, OR no A (strict pm4py rule)
      - always_before:   symmetric
      - never_together:  (x,y) where no trace contains both
      - directly_follows: (A,B) where total count of "A→B consecutive"
                         pairs across log ≥ total events of A (i.e.
                         every A is directly followed by B)
      - activ_freq:      per-activity, set of per-trace occurrence counts
    """
    from collections import Counter

    # Trace variants: matches pm4py.util.pandas_utils.get_traces.
    # NB: default groupby sorts by case_id, which matches pm4py.
    traces = [
        tuple(x)
        for x in df.groupby(CASE_COL)[ACTIVITY_COL].agg(list).to_dict().values()
    ]
    logs_traces: "Counter[tuple]" = Counter(traces)
    all_activs: "Counter[str]" = Counter()
    for trace_variant, variant_freq in logs_traces.items():
        for act in trace_variant:
            all_activs[act] += variant_freq
    events_count = sum(len(t) * f for t, f in logs_traces.items())

    equiv_sum: "Counter[tuple]" = Counter()
    after_count: "Counter[tuple]" = Counter()
    before_count: "Counter[tuple]" = Counter()
    df_count: "Counter[tuple]" = Counter()
    never_dec: "Counter[tuple]" = Counter()
    activ_freq_raw: dict[str, "Counter[int]"] = {
        act: Counter() for act in all_activs
    }

    for trace_variant, variant_freq in logs_traces.items():
        n = len(trace_variant)
        freq = Counter(trace_variant)

        # equivalence per-trace: Σ over (x,y) with freq[x]==freq[y] of freq[x]
        for x, fx in freq.items():
            for y, fy in freq.items():
                if x != y and fx == fy:
                    equiv_sum[(x, y)] += fx * variant_freq

        # after-set in O(n·k): left-to-right, track "seen so far".
        # Inner loop naturally emits (a,a) the second time a is seen.
        after_set: set[tuple] = set()
        seen_left: set = set()
        for act in trace_variant:
            for prev in seen_left:
                after_set.add((prev, act))
            seen_left.add(act)
        for pair in after_set:
            after_count[pair] += variant_freq
            # before-set is just the swap; pm4py's trace_skel.before
            # yields (trace[i], trace[j]) with j<i so its set is the
            # reverse of after-set's tuples.
            before_count[(pair[1], pair[0])] += variant_freq

        # directly-follows counter (counts duplicate consecutive pairs)
        for i in range(n - 1):
            df_count[(trace_variant[i], trace_variant[i + 1])] += variant_freq

        # never_together decrement: one hit per (x,y) with x!=y both
        # present in the trace — pm4py's combos() returns a set.
        acts_in_trace = list(freq.keys())
        for x in acts_in_trace:
            for y in acts_in_trace:
                if x != y:
                    never_dec[(x, y)] += variant_freq

        # activ_freq: per-trace activity count (pad missing with 0)
        for a in all_activs:
            activ_freq_raw[a][freq.get(a, 0)] += variant_freq

    equivalence_set = {
        (x, y) for (x, y), s in equiv_sum.items() if s >= all_activs[x]
    }
    always_after_set = {
        (A, B) for (A, B), s in after_count.items() if s >= all_activs[A]
    }
    always_before_set = {
        (A, B) for (A, B), s in before_count.items() if s >= all_activs[A]
    }
    never_together_set = {
        (x, y)
        for x in all_activs
        for y in all_activs
        if x != y and (x, y) not in never_dec
    }
    directly_follows_set = {
        (A, B) for (A, B), s in df_count.items() if s >= all_activs[A]
    }

    # activ_freq: faithful port of pm4py's truncation loop at
    # noise_threshold=0. The loop rarely truncates anything because
    # the accumulator is in "trace counts" units and the threshold
    # is in "event counts" units — but we reproduce it exactly so
    # any edge case behaves identically.
    activ_freq_out: dict[str, set] = {}
    for act, cnt_counter in activ_freq_raw.items():
        sorted_items = sorted(
            cnt_counter.items(), key=lambda x: x[1], reverse=True
        )
        added = 0
        i = 0
        while i < len(sorted_items):
            added += sorted_items[i][1]
            if added >= events_count:
                sorted_items = sorted_items[: min(i + 1, len(sorted_items))]
            i += 1
        activ_freq_out[act] = set(v for (v, _) in sorted_items)

    skeleton = {
        "equivalence": equivalence_set,
        "always_after": always_after_set,
        "always_before": always_before_set,
        "never_together": never_together_set,
        "directly_follows": directly_follows_set,
        "activ_freq": activ_freq_out,
    }

    def _convert(obj):
        if isinstance(obj, dict):
            return {str(k): _convert(v) for k, v in obj.items()}
        if isinstance(obj, (set, frozenset)):
            return [_convert(i) for i in sorted(str(x) for x in obj)]
        if isinstance(obj, (tuple, list)):
            return [_convert(i) for i in obj]
        return obj

    return {"constraints": _convert(skeleton)}


def get_declare(df: pd.DataFrame, support_threshold: float = 0.7) -> dict:
    """
    Discover DECLARE constraints from the event log.

    Runs a two-phase approach:
    1. pm4py.discover_declare for the standard pm4py templates (Response,
       Precedence, etc.) normalised into a flat rules list.
    2. A custom O(n) scan over case sequences that computes the richer
       template set from MINERful / SIESTA literature with proper
       support, confidence, and a plain-language narrative.

    Template coverage (custom scan):
        Existence, Absence, Exactly-one (unary cardinality)
        Init, End (position)
        Response, Precedence, Succession (ordering)
        Co-existence, Not-Co-existence, Choice, Exclusive-choice (relational)

    Args:
        support_threshold: only return rules where support >= this value
            (default 0.7 — 70% of cases must satisfy the rule).

    Returns:
        dict with key: rules (list of {template, activity_a, activity_b,
            support, confidence, narrative})
    """
    from collections import defaultdict as _dd

    # ── Phase 1: pm4py discover_declare ─────────────────────────────────
    import pm4py as _pm4py

    pm4py_rules: list[dict] = []
    try:
        if len(df) > 50_000:
            # pm4py.discover_declare materialises multi-GB on large logs; the
            # custom variant scan below covers the same templates (with richer
            # narratives), so skip the pm4py phase here.
            raise RuntimeError("large log — skipping pm4py declare phase")
        declare_model = _pm4py.discover_declare(
            df,
            activity_key=ACTIVITY_COL,
            case_id_key=CASE_COL,
            timestamp_key=TIMESTAMP_COL,
        )
        for template_name, pairs in declare_model.items():
            if isinstance(pairs, dict):
                for pair_key, support in pairs.items():
                    if isinstance(pair_key, (tuple, list)) and len(pair_key) == 2:
                        act_a, act_b = str(pair_key[0]), str(pair_key[1])
                    else:
                        act_a = str(pair_key)
                        act_b = None
                    if isinstance(support, dict):
                        sup_val = support.get("support", support.get("confidence", 0))
                    else:
                        sup_val = support
                    try:
                        sup_val = float(sup_val)
                    except (TypeError, ValueError):
                        sup_val = 0.0
                    pm4py_rules.append({
                        "template": str(template_name),
                        "activity_a": act_a,
                        "activity_b": act_b,
                        "support": sup_val,
                        "confidence": sup_val,
                        "narrative": None,
                    })
            elif isinstance(pairs, (int, float)):
                pm4py_rules.append({
                    "template": str(template_name),
                    "activity_a": "",
                    "activity_b": None,
                    "support": float(pairs),
                    "confidence": float(pairs),
                    "narrative": None,
                })
    except Exception as exc:
        logger.warning(f"pm4py.discover_declare failed, skipping pm4py phase: {exc}")

    # ── Phase 2: custom scan over UNIQUE VARIANTS (frequency-weighted) ────
    # Working per-case would materialise one Python list per case (250k+ on
    # BPIC ⇒ multi-GB RAM). Every Declare counter below is a case-count, so we
    # instead iterate the far smaller set of distinct variant sequences and add
    # each variant's frequency — mathematically identical, O(#variants) memory.
    from app.services.variant_analysis import VariantAnalysisService
    _var = VariantAnalysisService().analyze_variants(df)
    variant_items: list[tuple[list[str], int]] = [
        ([str(a) for a in v["activities"]], int(v["frequency"]))
        for v in _var.get("variants", [])
        if v.get("activities")
    ]
    total_cases = sum(f for _, f in variant_items)
    if total_cases == 0:
        return {"rules": pm4py_rules}

    all_activities: set[str] = {a for seq, _ in variant_items for a in seq}

    # Per-activity counters
    act_cases: dict[str, int] = _dd(int)       # cases containing A
    act_exactly_one: dict[str, int] = _dd(int)  # cases with exactly one A
    act_init: dict[str, int] = _dd(int)         # cases starting with A
    act_end: dict[str, int] = _dd(int)          # cases ending with A

    # Pair counters  (A, B) ordered
    pair_both: dict[tuple, int] = _dd(int)       # cases containing both A and B
    pair_a_before_b: dict[tuple, int] = _dd(int) # cases where A appears before any B
    pair_response: dict[tuple, int] = _dd(int)   # cases where after every A, B eventually follows
    pair_precedence: dict[tuple, int] = _dd(int) # cases where every B is preceded by A

    for seq, freq in variant_items:
        # One left-to-right pass per UNIQUE variant; counters are incremented by
        # the variant's case frequency (identical to per-case counting). Records
        # the first/last position of each activity, collapsing the former
        # O(k²·n²) per-pair work into O(n) scan + O(k²) pair enumeration.
        act_counts = _dd(int)
        first_pos: dict[str, int] = {}
        last_pos: dict[str, int] = {}
        for i, a in enumerate(seq):
            act_counts[a] += 1
            if a not in first_pos:
                first_pos[a] = i
            last_pos[a] = i

        act_set = first_pos.keys()  # unique activities in the variant

        for a in act_set:
            act_cases[a] += freq
            if act_counts[a] == 1:
                act_exactly_one[a] += freq
            if seq[0] == a:
                act_init[a] += freq
            if seq[-1] == a:
                act_end[a] += freq

        for a in act_set:
            fa, la = first_pos[a], last_pos[a]
            for b in act_set:
                if a == b:
                    continue
                ab = (a, b)
                pair_both[ab] += freq

                # A before B: some occurrence of A precedes some occurrence of
                # B ⟺ first(A) < last(B).
                if fa < last_pos[b]:
                    pair_a_before_b[ab] += freq

                # Response(A,B): every A is eventually followed by B ⟺ the last
                # A has a B strictly after it ⟺ last(A) < last(B).
                if la < last_pos[b]:
                    pair_response[ab] += freq

                # Precedence(A,B): every B is preceded by A ⟺ the first B has an
                # A strictly before it ⟺ first(A) < first(B).
                if fa < first_pos[b]:
                    pair_precedence[ab] += freq

    _NARRATIVES = {
        "Existence":         lambda a, _: f"'{a}' occurs at least once in the case.",
        "Absence":           lambda a, _: f"'{a}' never occurs in the case.",
        "ExactlyOne":        lambda a, _: f"'{a}' occurs exactly once per case.",
        "Init":              lambda a, _: f"'{a}' is always the first activity in the case.",
        "End":               lambda a, _: f"'{a}' is always the last activity in the case.",
        "Response":          lambda a, b: f"Whenever '{a}' occurs, '{b}' eventually follows in the same case.",
        "Precedence":        lambda a, b: f"'{b}' only occurs after '{a}' has occurred.",
        "Succession":        lambda a, b: f"'{a}' and '{b}' always occur together with '{a}' before '{b}'.",
        "CoExistence":       lambda a, b: f"If '{a}' occurs, '{b}' also occurs (and vice versa).",
        "NotCoExistence":    lambda a, b: f"'{a}' and '{b}' never both appear in the same case.",
        "Choice":            lambda a, b: f"At least one of '{a}' or '{b}' occurs in every case.",
        "ExclusiveChoice":   lambda a, b: f"Exactly one of '{a}' or '{b}' occurs — never both, never neither.",
    }

    def _narrative(template: str, a: str, b: str | None) -> str:
        fn = _NARRATIVES.get(template)
        if fn:
            return fn(a, b or "")
        return f"{template}: {a}" + (f" → {b}" if b else "")

    custom_rules: list[dict] = []

    def _add(template, act_a, act_b, support, confidence):
        if support < support_threshold:
            return
        custom_rules.append({
            "template": template,
            "activity_a": act_a,
            "activity_b": act_b,
            "support": round(support, 4),
            "confidence": round(confidence, 4),
            "narrative": _narrative(template, act_a, act_b),
        })

    # Unary templates
    for a in sorted(all_activities):
        n_a = act_cases[a]
        sup_exist = n_a / total_cases
        _add("Existence", a, None, sup_exist, sup_exist)
        _add("Absence", a, None, 1.0 - sup_exist, 1.0 - sup_exist)
        _add("ExactlyOne", a, None, act_exactly_one[a] / total_cases,
             act_exactly_one[a] / n_a if n_a else 0.0)
        _add("Init", a, None, act_init[a] / total_cases,
             act_init[a] / n_a if n_a else 0.0)
        _add("End", a, None, act_end[a] / total_cases,
             act_end[a] / n_a if n_a else 0.0)

    # Binary templates
    for a in sorted(all_activities):
        for b in sorted(all_activities):
            if a >= b:
                continue
            ab = (a, b)
            ba = (b, a)
            n_both = pair_both.get(ab, 0) or pair_both.get(ba, 0)
            n_a = act_cases[a]
            n_b = act_cases[b]

            # Response(A→B)
            if n_a > 0:
                resp_sup = pair_response.get(ab, 0) / total_cases
                resp_conf = pair_response.get(ab, 0) / n_a
                _add("Response", a, b, resp_sup, resp_conf)

            # Response(B→A)
            if n_b > 0:
                resp_sup_ba = pair_response.get(ba, 0) / total_cases
                resp_conf_ba = pair_response.get(ba, 0) / n_b
                _add("Response", b, a, resp_sup_ba, resp_conf_ba)

            # Precedence(A before B)
            if n_b > 0:
                prec_sup = pair_precedence.get(ab, 0) / total_cases
                prec_conf = pair_precedence.get(ab, 0) / n_b
                _add("Precedence", a, b, prec_sup, prec_conf)

            # Succession(A,B) = Response(A,B) AND Precedence(A,B)
            succ_cases = min(pair_response.get(ab, 0), pair_precedence.get(ab, 0))
            if total_cases > 0:
                _add("Succession", a, b, succ_cases / total_cases,
                     succ_cases / n_a if n_a else 0.0)

            # CoExistence
            if n_both > 0:
                coex_sup = n_both / total_cases
                coex_conf_a = n_both / n_a if n_a else 0.0
                _add("CoExistence", a, b, coex_sup, min(coex_conf_a, n_both / n_b if n_b else 0.0))

            # NotCoExistence
            n_neither = total_cases - n_both
            if total_cases > 0:
                _add("NotCoExistence", a, b, n_neither / total_cases, n_neither / total_cases)

            # Choice: at least one occurs
            n_at_least_one = n_a + n_b - n_both
            if total_cases > 0:
                _add("Choice", a, b, n_at_least_one / total_cases, n_at_least_one / total_cases)

            # ExclusiveChoice: exactly one occurs
            n_exactly_one = n_a + n_b - 2 * n_both
            if total_cases > 0:
                _add("ExclusiveChoice", a, b, n_exactly_one / total_cases, n_exactly_one / total_cases)

    # Merge: pm4py rules first, then custom (they complement each other).
    # Deduplicate on (template, activity_a, activity_b) keeping the custom
    # version when both exist (it carries confidence + narrative).
    seen: set[tuple] = set()
    merged: list[dict] = []
    for r in custom_rules + pm4py_rules:
        key = (r["template"], r.get("activity_a", ""), r.get("activity_b") or "")
        if key not in seen:
            seen.add(key)
            # Ensure all rules carry confidence and narrative fields
            r.setdefault("confidence", r.get("support", 0.0))
            if not r.get("narrative"):
                r["narrative"] = _narrative(r["template"], r.get("activity_a", ""), r.get("activity_b"))
            merged.append(r)

    return {"rules": merged}


# ─────────────────────────────────────────────────────────────────────────
# SLA-aware Timed-Declare conformance
# ─────────────────────────────────────────────────────────────────────────

# Unit → seconds, used to (a) convert an SLA bound to seconds and (b)
# convert a measured duration back into the bound's unit for reporting.
_UNIT_SECONDS = {
    "minutes": 60.0,
    "hours": 3600.0,
    "days": 86400.0,
}

# Sample cap for violating_case_ids so a 1M-case log can't return a list
# that dwarfs the rest of the payload.
_VIOLATION_SAMPLE = 200


def _tt_stats(values: list[float], unit: str) -> dict:
    """Build a time-to-violation stats dict (values already in *unit*)."""
    if not values:
        return {"count": 0, "mean": None, "median": None,
                "p95": None, "max": None, "unit": unit}
    arr = np.asarray(values, dtype="float64")
    return {
        "count": int(arr.size),
        "mean": round(float(arr.mean()), 3),
        "median": round(float(np.median(arr)), 3),
        "p95": round(float(np.percentile(arr, 95)), 3),
        "max": round(float(arr.max()), 3),
        "unit": unit,
    }


def _timed_narrative(c: dict, bound_value: float, unit: str) -> str:
    a = c.get("activity_a") or ""
    b = c.get("activity_b") or ""
    win = f"{bound_value:g} {unit}" + (" (business days)" if c.get("business_days") else "")
    t = c.get("type")
    if t == "response":
        return f"After '{a}', '{b}' must follow within {win}."
    if t == "precedence":
        return f"'{b}' must be preceded by '{a}' within {win}."
    if t == "existence":
        return f"'{a}' must occur within {win} of the case starting."
    if t == "absence":
        return f"'{a}' must NOT occur within {win} of the case starting."
    return f"{t}: {a}" + (f" / {b}" if b else "")


def check_timed_declare(df: pd.DataFrame, constraints: list[dict]) -> dict:
    """Evaluate time-bounded (SLA-aware) DECLARE-style constraints over a log.

    Each constraint is a dict with keys:
        type:          one of 'response', 'precedence', 'existence', 'absence'
        activity_a:    str (the trigger / target activity)
        activity_b:    str | None (required for response/precedence)
        bound_value:   float > 0 — the SLA window magnitude T
        bound_unit:    'minutes' | 'hours' | 'days'
        business_days: bool — measure T over Mon–Fri working time
        label:         str | None — optional display name

    Semantics (per case):
        response(A,B,T):   for every occurrence of A, some B must occur
                           strictly after it within T. Each A occurrence is
                           an obligation; a case violates if ANY A obligation
                           is unmet. Time-to-violation = the smallest A→(next
                           reachable B) gap that exceeds T (or, if no B at
                           all, the A→case-end elapsed).
        precedence(A,B,T): for every occurrence of B, some A must occur
                           strictly before it within T. A case violates if
                           ANY B lacks a qualifying A. TtV = the offending
                           A→B gap (or B's distance from case start when no
                           prior A).
        existence(A,_,T):  A must occur within T of the case's first event.
                           Cases with no A, or whose first A is later than T,
                           violate. TtV = elapsed-to-first-A (or whole case
                           span when A is absent).
        absence(A,_,T):    A must NOT occur within T of the case start. A
                           case with an A inside the window violates. TtV =
                           elapsed-to-first-A inside the window.

    Only cases that *activate* a constraint count toward its denominator:
      - response: cases containing ≥1 A
      - precedence: cases containing ≥1 B
      - existence / absence: all cases (the window always applies)

    Returns a dict matching TimedDeclareResponse: total_cases + a per-
    constraint result carrying violation_rate, a bounded sample of
    violating_case_ids, and time-to-violation stats.
    """
    if df.empty:
        return {"total_cases": 0, "results": []}

    # Sort once; group preserves order within each case.
    sdf = df.sort_values([CASE_COL, TIMESTAMP_COL])
    total_cases = int(sdf[CASE_COL].nunique())

    # Pre-materialize per-case ordered (activity, timestamp) sequences once so
    # every constraint reuses them instead of re-grouping the frame N times.
    # ts stored as numpy datetime64 for cheap business/wall-clock math.
    case_seqs: dict = {}
    for case_id, grp in sdf.groupby(CASE_COL, sort=False):
        acts = grp[ACTIVITY_COL].astype(str).tolist()
        ts = grp[TIMESTAMP_COL]
        case_seqs[str(case_id)] = (acts, ts)

    results: list[dict] = []

    for c in constraints:
        ctype = str(c.get("type", "")).lower()
        a = str(c.get("activity_a", ""))
        b = c.get("activity_b")
        b = str(b) if b is not None else None
        bound_value = float(c.get("bound_value", 0) or 0)
        unit = str(c.get("bound_unit", "hours")).lower()
        if unit not in _UNIT_SECONDS:
            unit = "hours"
        business_days = bool(c.get("business_days", False))
        bound_seconds = bound_value * _UNIT_SECONDS[unit]

        evaluated = 0
        violating = 0
        violating_ids: list[str] = []
        ttv_values: list[float] = []  # in the constraint's unit

        for case_id, (acts, ts) in case_seqs.items():
            # Build aligned arrays for this case.
            ts_list = list(ts)
            n = len(acts)

            if ctype in ("response", "precedence") and b is None:
                # Binary constraint missing its B — cannot evaluate; skip.
                continue

            if ctype == "response":
                a_idx = [i for i, x in enumerate(acts) if x == a]
                if not a_idx:
                    continue  # not activated
                evaluated += 1
                b_idx = [i for i, x in enumerate(acts) if x == b]
                worst_gap = None  # seconds, only set on violation
                case_violates = False
                # last B timestamp for the "no later B" check
                for ai in a_idx:
                    a_ts = ts_list[ai]
                    # earliest B strictly after this A
                    next_b = None
                    for bi in b_idx:
                        if bi > ai:
                            next_b = ts_list[bi]
                            break
                    if next_b is None:
                        # No B follows: obligation unmet. Gap = A→case end.
                        gap = _pair_elapsed(a_ts, ts_list[-1], business_days)
                        case_violates = True
                        if worst_gap is None or gap > worst_gap:
                            worst_gap = gap
                    else:
                        gap = _pair_elapsed(a_ts, next_b, business_days)
                        if gap > bound_seconds:
                            case_violates = True
                            if worst_gap is None or gap > worst_gap:
                                worst_gap = gap
                if case_violates:
                    violating += 1
                    if len(violating_ids) < _VIOLATION_SAMPLE:
                        violating_ids.append(case_id)
                    if worst_gap is not None:
                        ttv_values.append(worst_gap / _UNIT_SECONDS[unit])

            elif ctype == "precedence":
                b_idx = [i for i, x in enumerate(acts) if x == b]
                if not b_idx:
                    continue  # not activated
                evaluated += 1
                a_idx = [i for i, x in enumerate(acts) if x == a]
                worst_gap = None
                case_violates = False
                for bi in b_idx:
                    b_ts = ts_list[bi]
                    # latest A strictly before this B
                    prev_a = None
                    for ai in reversed(a_idx):
                        if ai < bi:
                            prev_a = ts_list[ai]
                            break
                    if prev_a is None:
                        # No prior A: gap = case start → B.
                        gap = _pair_elapsed(ts_list[0], b_ts, business_days)
                        case_violates = True
                        if worst_gap is None or gap > worst_gap:
                            worst_gap = gap
                    else:
                        gap = _pair_elapsed(prev_a, b_ts, business_days)
                        if gap > bound_seconds:
                            case_violates = True
                            if worst_gap is None or gap > worst_gap:
                                worst_gap = gap
                if case_violates:
                    violating += 1
                    if len(violating_ids) < _VIOLATION_SAMPLE:
                        violating_ids.append(case_id)
                    if worst_gap is not None:
                        ttv_values.append(worst_gap / _UNIT_SECONDS[unit])

            elif ctype in ("existence", "absence"):
                evaluated += 1  # window always applies to every case
                case_start = ts_list[0]
                first_a_ts = None
                for i, x in enumerate(acts):
                    if x == a:
                        first_a_ts = ts_list[i]
                        break
                if ctype == "existence":
                    if first_a_ts is None:
                        # A absent → violation; gap = whole case span.
                        gap = _pair_elapsed(case_start, ts_list[-1], business_days)
                        violating += 1
                        if len(violating_ids) < _VIOLATION_SAMPLE:
                            violating_ids.append(case_id)
                        ttv_values.append(gap / _UNIT_SECONDS[unit])
                    else:
                        gap = _pair_elapsed(case_start, first_a_ts, business_days)
                        if gap > bound_seconds:
                            violating += 1
                            if len(violating_ids) < _VIOLATION_SAMPLE:
                                violating_ids.append(case_id)
                            ttv_values.append(gap / _UNIT_SECONDS[unit])
                else:  # absence
                    if first_a_ts is not None:
                        gap = _pair_elapsed(case_start, first_a_ts, business_days)
                        if gap <= bound_seconds:
                            # A occurred inside the forbidden window → violation
                            violating += 1
                            if len(violating_ids) < _VIOLATION_SAMPLE:
                                violating_ids.append(case_id)
                            ttv_values.append(gap / _UNIT_SECONDS[unit])
            else:
                # Unknown type: emit an empty (non-evaluated) result so the
                # caller still sees the constraint echoed back.
                continue

        violation_rate = round(violating / evaluated, 4) if evaluated else 0.0
        results.append({
            "type": ctype,
            "activity_a": a,
            "activity_b": b,
            "bound_value": bound_value,
            "bound_unit": unit,
            "business_days": business_days,
            "label": c.get("label"),
            "narrative": _timed_narrative(c, bound_value, unit),
            "evaluated_cases": evaluated,
            "satisfied_cases": evaluated - violating,
            "violating_cases": violating,
            "violation_rate": violation_rate,
            "violating_case_ids": violating_ids,
            "time_to_violation": _tt_stats(ttv_values, unit),
        })

    return {"total_cases": total_cases, "results": results}


def _pair_elapsed(start, end, business_days: bool) -> float:
    """Elapsed seconds between two scalar pandas Timestamps, wall-clock or
    Mon–Fri business time. Negative spans clamp to 0."""
    if start is None or end is None:
        return 0.0
    try:
        raw = (end - start).total_seconds()
    except Exception:
        return 0.0
    if raw <= 0:
        return 0.0
    if not business_days:
        return raw
    return _business_seconds_scalar(start, end)


def _business_seconds_scalar(start, end) -> float:
    """Mon–Fri working-time seconds between two scalar Timestamps.

    Scalar twin of ``_business_seconds_between`` (the vectorized version is
    kept for any future bulk path). Counts the full 24h of each weekday and
    zero for Sat/Sun, so a 1-business-day SLA = 24 weekday-hours.
    """
    day = 86400.0
    s = start.value / 1e9  # ns → s since epoch (UTC instant)
    e = end.value / 1e9

    def weekend_seconds_before(t: float) -> float:
        d = t // day
        dow = (d + 3.0) % 7.0           # epoch (1970-01-01) is Thursday
        dm = d - 4.0                    # shift so each 7-day block starts Monday
        full_weeks = dm // 7.0
        rem_days = dm - full_weeks * 7.0
        leading_weekend = max(0.0, min(2.0, rem_days - 5.0))
        whole = (full_weeks * 2.0 + leading_weekend) * day
        intraday = t - d * day
        today_is_weekend = 1.0 if dow >= 5.0 else 0.0
        return whole + today_is_weekend * intraday

    raw = e - s
    business = raw - (weekend_seconds_before(e) - weekend_seconds_before(s))
    return max(0.0, business)
