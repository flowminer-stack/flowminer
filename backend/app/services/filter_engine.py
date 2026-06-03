"""
Filter-expression engine for the case-filter DSL.

Tokeniser + recursive-descent evaluator for expressions like
``case.duration > 5m and activity = "Approve"``. Previously private helpers
inside ``app.api.competitive``; relocated to the services layer so other
routers (e.g. custom_kpis) can use them without importing from a sibling
router. Kept byte-for-byte equivalent to the originals; only their home moved.
"""

from __future__ import annotations

from app.services.ingestion import (
    ACTIVITY_COL,
    CASE_COL,
    RESOURCE_COL,
    TIMESTAMP_COL,
)


def _tokenize_expr(expr: str) -> list[tuple[str, str]]:
    """Tokenise a filter expression into ``(kind, value)`` tuples.

    Kinds: ``ident`` (metric or keyword), ``op``, ``str``, ``num``,
    ``dur``, ``lparen``, ``rparen``. Whitespace is skipped.
    """
    import re

    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(expr)
    ident_re = re.compile(r"[A-Za-z_][\w\.:]*")
    num_re = re.compile(r"\d+(?:\.\d+)?")
    dur_re = re.compile(r"^(\d+)([smhd])$")
    while i < n:
        c = expr[i]
        if c.isspace():
            i += 1
            continue
        if c == "(":
            tokens.append(("lparen", "("))
            i += 1
            continue
        if c == ")":
            tokens.append(("rparen", ")"))
            i += 1
            continue
        if c == '"' or c == "'":
            # Quoted string — find the matching close
            quote = c
            j = i + 1
            buf = []
            while j < n and expr[j] != quote:
                if expr[j] == "\\" and j + 1 < n:
                    buf.append(expr[j + 1])
                    j += 2
                else:
                    buf.append(expr[j])
                    j += 1
            tokens.append(("str", "".join(buf)))
            i = j + 1
            continue
        # Multi-char operators first
        if expr[i : i + 2] in ("!=", ">=", "<="):
            tokens.append(("op", expr[i : i + 2]))
            i += 2
            continue
        if c in "=><":
            tokens.append(("op", c))
            i += 1
            continue
        # Numbers — check for duration suffix
        m = num_re.match(expr, i)
        if m:
            num_end = m.end()
            dur = dur_re.match(expr[i : num_end + 1])
            if dur and num_end < n and expr[num_end] in "smhd":
                tokens.append(("dur", expr[i : num_end + 1]))
                i = num_end + 1
            else:
                tokens.append(("num", m.group(0)))
                i = num_end
            continue
        # Identifiers and keywords
        m = ident_re.match(expr, i)
        if m:
            val = m.group(0)
            lower = val.lower()
            if lower in ("and", "or", "contains"):
                kind = "op" if lower == "contains" else "kw"
                tokens.append((kind, lower))
            else:
                tokens.append(("ident", val))
            i = m.end()
            continue
        # Unknown char — skip and let the parser emit a warning
        i += 1
    return tokens


def _parse_duration(s: str) -> float:
    """Parse '30s' / '5m' / '2h' / '7d' into seconds."""
    unit = s[-1]
    n = float(s[:-1])
    return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def _evaluate_filter(
    expr: str,
    df: "pd.DataFrame",
    all_case_ids: set[str],
) -> tuple[set[str], list[str]]:
    """Recursive-descent evaluator returning (matching_case_ids, warnings)."""
    import pandas as pd

    warnings: list[str] = []
    tokens = _tokenize_expr(expr)
    pos = [0]  # mutable cursor used by the nested parser

    # Precompute the per-case view we'll reuse for every clause.
    case_times = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
    case_times["_dur"] = (case_times["max"] - case_times["min"]).dt.total_seconds()
    acts_per_case = df.groupby(CASE_COL)[ACTIVITY_COL].apply(set)
    res_per_case = (
        df.groupby(CASE_COL)[RESOURCE_COL].apply(set)
        if RESOURCE_COL in df.columns
        else None
    )

    def peek() -> tuple[str, str] | None:
        return tokens[pos[0]] if pos[0] < len(tokens) else None

    def consume() -> tuple[str, str] | None:
        t = peek()
        if t is not None:
            pos[0] += 1
        return t

    def eval_atom() -> set[str]:
        t = peek()
        if t is None:
            warnings.append("Unexpected end of expression")
            return set(all_case_ids)
        if t[0] == "lparen":
            consume()
            inner = eval_or()
            nxt = peek()
            if nxt and nxt[0] == "rparen":
                consume()
            return inner
        # Otherwise a comparison: metric op value
        return eval_comparison()

    def eval_comparison() -> set[str]:
        metric_tok = consume()
        op_tok = consume()
        val_tok = consume()
        if not (metric_tok and op_tok and val_tok):
            warnings.append("Truncated comparison")
            return set(all_case_ids)
        metric = metric_tok[1].lower() if metric_tok[0] == "ident" else metric_tok[1]
        op = op_tok[1]
        raw_val = val_tok[1]

        if metric == "case.duration":
            try:
                dv = (
                    _parse_duration(raw_val)
                    if val_tok[0] == "dur"
                    else float(raw_val)
                )
            except (ValueError, KeyError):
                warnings.append(f"Bad duration value: {raw_val}")
                return set(all_case_ids)
            col = case_times["_dur"]
            mask = {
                ">": col > dv,
                "<": col < dv,
                ">=": col >= dv,
                "<=": col <= dv,
                "=": col == dv,
                "!=": col != dv,
            }.get(op)
            if mask is None:
                warnings.append(f"Op {op} not supported for case.duration")
                return set(all_case_ids)
            return set(str(c) for c in case_times[mask].index)

        if metric in ("case.start", "case.end"):
            try:
                dv = pd.to_datetime(raw_val, utc=True)
            except Exception:
                warnings.append(f"Bad date value: {raw_val}")
                return set(all_case_ids)
            col = case_times["min"] if metric == "case.start" else case_times["max"]
            mask = {
                ">": col > dv,
                "<": col < dv,
                ">=": col >= dv,
                "<=": col <= dv,
                "=": col == dv,
                "!=": col != dv,
            }.get(op)
            if mask is None:
                warnings.append(f"Op {op} not supported for {metric}")
                return set(all_case_ids)
            return set(str(c) for c in case_times[mask].index)

        if metric == "activity":
            if op in ("=", "contains"):
                matched = acts_per_case[acts_per_case.apply(lambda s: raw_val in s)]
                return set(str(c) for c in matched.index)
            if op == "!=":
                matched = acts_per_case[acts_per_case.apply(lambda s: raw_val not in s)]
                return set(str(c) for c in matched.index)
            warnings.append(f"Op {op} not supported for activity")
            return set(all_case_ids)

        if metric in ("resource", "org:resource"):
            if res_per_case is None:
                warnings.append("No resource column in this log")
                return set(all_case_ids)
            if op == "=":
                matched = res_per_case[res_per_case.apply(lambda s: raw_val in s)]
                return set(str(c) for c in matched.index)
            if op == "!=":
                matched = res_per_case[res_per_case.apply(lambda s: raw_val not in s)]
                return set(str(c) for c in matched.index)
            warnings.append(f"Op {op} not supported for resource")
            return set(all_case_ids)

        if metric.startswith("attr."):
            col_name = metric[len("attr.") :]
            if col_name not in df.columns:
                warnings.append(f"Unknown attribute column: {col_name}")
                return set(all_case_ids)
            # Reduce to one value per case (first non-null) so the
            # comparison is case-scoped.
            per_case_val = df.groupby(CASE_COL)[col_name].first()
            try:
                if pd.api.types.is_numeric_dtype(per_case_val):
                    target = float(raw_val)
                else:
                    target = raw_val
            except ValueError:
                target = raw_val
            mask = {
                "=": per_case_val == target,
                "!=": per_case_val != target,
                ">": per_case_val > target if pd.api.types.is_numeric_dtype(per_case_val) else None,
                "<": per_case_val < target if pd.api.types.is_numeric_dtype(per_case_val) else None,
                ">=": per_case_val >= target if pd.api.types.is_numeric_dtype(per_case_val) else None,
                "<=": per_case_val <= target if pd.api.types.is_numeric_dtype(per_case_val) else None,
                "contains": per_case_val.astype(str).str.contains(str(raw_val), na=False, regex=False),
            }.get(op)
            if mask is None:
                warnings.append(f"Op {op} not supported for attr.{col_name}")
                return set(all_case_ids)
            return set(str(c) for c in per_case_val[mask].index)

        warnings.append(f"Unknown metric: {metric}")
        return set(all_case_ids)

    def eval_and() -> set[str]:
        result = eval_atom()
        while True:
            t = peek()
            if t and t[0] == "kw" and t[1] == "and":
                consume()
                result &= eval_atom()
            else:
                break
        return result

    def eval_or() -> set[str]:
        result = eval_and()
        while True:
            t = peek()
            if t and t[0] == "kw" and t[1] == "or":
                consume()
                result |= eval_and()
            else:
                break
        return result

    matched = eval_or() if tokens else set(all_case_ids)
    # Consume any leftover tokens as warnings so the user knows something
    # after the parsed prefix wasn't understood.
    if pos[0] < len(tokens):
        warnings.append(
            f"Trailing tokens after parsed expression: {tokens[pos[0]:]}"
        )
    return matched, warnings
