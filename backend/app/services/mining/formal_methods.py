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

    # ── Phase 2: custom O(n) scan for richer templates ───────────────────
    # Derive per-case activity sequences
    sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
    cases: dict[str, list[str]] = {}
    for case_id, grp in sorted_df.groupby(CASE_COL, sort=False):
        cases[str(case_id)] = [str(a) for a in grp[ACTIVITY_COL].tolist()]

    total_cases = len(cases)
    if total_cases == 0:
        return {"rules": pm4py_rules}

    all_activities: set[str] = {a for seq in cases.values() for a in seq}

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

    for seq in cases.values():
        # Single left-to-right pass: count occurrences and record the first
        # and last position of each activity. This collapses the former
        # O(k² · n²) per-case work (per pair: rebuild index lists + nested
        # "is there a later/earlier match" scans) into O(n) for the scan plus
        # O(k²) for the pair enumeration, giving identical counters.
        act_counts = _dd(int)
        first_pos: dict[str, int] = {}
        last_pos: dict[str, int] = {}
        for i, a in enumerate(seq):
            act_counts[a] += 1
            if a not in first_pos:
                first_pos[a] = i
            last_pos[a] = i

        act_set = first_pos.keys()  # unique activities in the case

        for a in act_set:
            act_cases[a] += 1
            if act_counts[a] == 1:
                act_exactly_one[a] += 1
            if seq[0] == a:
                act_init[a] += 1
            if seq[-1] == a:
                act_end[a] += 1

        for a in act_set:
            fa, la = first_pos[a], last_pos[a]
            for b in act_set:
                if a == b:
                    continue
                ab = (a, b)
                pair_both[ab] += 1

                # A before B: some occurrence of A precedes some occurrence of
                # B ⟺ first(A) < last(B).
                if fa < last_pos[b]:
                    pair_a_before_b[ab] += 1

                # Response(A,B): every A is eventually followed by B ⟺ the last
                # A has a B strictly after it ⟺ last(A) < last(B).
                if la < last_pos[b]:
                    pair_response[ab] += 1

                # Precedence(A,B): every B is preceded by A ⟺ the first B has an
                # A strictly before it ⟺ first(A) < first(B).
                if fa < first_pos[b]:
                    pair_precedence[ab] += 1

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
