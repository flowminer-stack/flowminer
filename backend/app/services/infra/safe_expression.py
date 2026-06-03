"""
Safe arithmetic expression evaluator for the ETL pipeline.

We deliberately DO NOT use ``pd.DataFrame.eval`` or Python's builtin ``eval``
— both can reach arbitrary code paths via attribute access, dunder names,
generator expressions, decorators, or numexpr's escape hatches. Instead we
walk the AST explicitly and only permit a small set of node types: column
names, numeric / string / bool literals, arithmetic, comparison, logical
and bitwise ops, parenthesized groups, and a whitelist of pandas-side
function calls (``abs``, ``min``, ``max``, ``round``, ``len``).

If the expression touches anything outside that allowlist — dunders,
attribute access, function calls we don't recognize, comprehensions,
lambda, await, etc. — we raise ``UnsafeExpressionError`` with a specific
reason so the user can fix their mapping.
"""

from __future__ import annotations

import ast
import operator as _op
from typing import Any

import pandas as pd


class UnsafeExpressionError(ValueError):
    """Raised when the ETL expression contains a construct we refuse to evaluate."""


# Ops we understand. Anything else -> UnsafeExpressionError.
_BIN_OPS: dict[type, Any] = {
    ast.Add: _op.add,
    ast.Sub: _op.sub,
    ast.Mult: _op.mul,
    ast.Div: _op.truediv,
    ast.FloorDiv: _op.floordiv,
    ast.Mod: _op.mod,
    ast.Pow: _op.pow,
}
_UNARY_OPS: dict[type, Any] = {
    ast.USub: _op.neg,
    ast.UAdd: _op.pos,
    ast.Not: _op.not_,
}
_CMP_OPS: dict[type, Any] = {
    ast.Eq: _op.eq,
    ast.NotEq: _op.ne,
    ast.Lt: _op.lt,
    ast.LtE: _op.le,
    ast.Gt: _op.gt,
    ast.GtE: _op.ge,
}
_BOOL_OPS: dict[type, Any] = {
    ast.And: lambda a, b: a & b,
    ast.Or: lambda a, b: a | b,
}

# Function allowlist. All operate element-wise over Series; nothing here can
# escape into arbitrary Python objects.
_ALLOWED_FUNCS: dict[str, Any] = {
    "abs": lambda s: s.abs() if isinstance(s, pd.Series) else abs(s),
    "round": lambda s, n=0: s.round(int(n)) if isinstance(s, pd.Series) else round(s, int(n)),
    "min": lambda a, b: pd.concat([_to_series(a), _to_series(b)], axis=1).min(axis=1),
    "max": lambda a, b: pd.concat([_to_series(a), _to_series(b)], axis=1).max(axis=1),
    "len": lambda s: s.str.len() if isinstance(s, pd.Series) else len(s),
    "upper": lambda s: s.str.upper() if isinstance(s, pd.Series) else str(s).upper(),
    "lower": lambda s: s.str.lower() if isinstance(s, pd.Series) else str(s).lower(),
    "strip": lambda s: s.str.strip() if isinstance(s, pd.Series) else str(s).strip(),
}


def _to_series(x: Any) -> pd.Series:
    if isinstance(x, pd.Series):
        return x
    return pd.Series([x])


def safe_eval(expression: str, df: pd.DataFrame) -> Any:
    """Evaluate an arithmetic / comparison expression over a DataFrame.

    Column names appear as bare identifiers (``col_a + col_b``). Call sites
    catch ``UnsafeExpressionError`` and surface a clean 400 to the user.
    """
    if not isinstance(expression, str):
        raise UnsafeExpressionError("expression must be a string")

    if len(expression) > 1000:
        raise UnsafeExpressionError("expression too long (max 1000 chars)")

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        raise UnsafeExpressionError(f"syntax error: {e.msg}") from e

    return _walk(tree.body, df)


def _walk(node: ast.AST, df: pd.DataFrame) -> Any:
    # ── Literals ──────────────────────────────────────────────────────────
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float, str, bool)) or node.value is None:
            return node.value
        raise UnsafeExpressionError(f"unsupported constant type: {type(node.value).__name__}")

    # ── Column references ────────────────────────────────────────────────
    if isinstance(node, ast.Name):
        name = node.id
        # Dunder / private names are always rejected, even if they happen
        # to match a column.
        if name.startswith("_"):
            raise UnsafeExpressionError(f"names starting with underscore are not allowed: {name}")
        if name in df.columns:
            return df[name]
        # Bare True / False / None come through here on older Pythons
        if name == "True":
            return True
        if name == "False":
            return False
        if name == "None":
            return None
        raise UnsafeExpressionError(f"unknown column or name: {name}")

    # ── Binary operations ─────────────────────────────────────────────────
    if isinstance(node, ast.BinOp):
        op_fn = _BIN_OPS.get(type(node.op))
        if op_fn is None:
            raise UnsafeExpressionError(f"operator not allowed: {type(node.op).__name__}")
        left = _walk(node.left, df)
        right = _walk(node.right, df)
        return op_fn(left, right)

    # ── Unary operations ─────────────────────────────────────────────────
    if isinstance(node, ast.UnaryOp):
        op_fn = _UNARY_OPS.get(type(node.op))
        if op_fn is None:
            raise UnsafeExpressionError(f"unary operator not allowed: {type(node.op).__name__}")
        return op_fn(_walk(node.operand, df))

    # ── Comparisons (chained) ────────────────────────────────────────────
    if isinstance(node, ast.Compare):
        left = _walk(node.left, df)
        result = None
        current = left
        for op, right_node in zip(node.ops, node.comparators):
            cmp_fn = _CMP_OPS.get(type(op))
            if cmp_fn is None:
                raise UnsafeExpressionError(f"comparison operator not allowed: {type(op).__name__}")
            right = _walk(right_node, df)
            piece = cmp_fn(current, right)
            result = piece if result is None else result & piece
            current = right
        return result

    # ── Boolean AND / OR ─────────────────────────────────────────────────
    if isinstance(node, ast.BoolOp):
        op_fn = _BOOL_OPS.get(type(node.op))
        if op_fn is None:
            raise UnsafeExpressionError(f"boolean operator not allowed: {type(node.op).__name__}")
        values = [_walk(v, df) for v in node.values]
        acc = values[0]
        for v in values[1:]:
            acc = op_fn(acc, v)
        return acc

    # ── Function calls (whitelist only) ──────────────────────────────────
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise UnsafeExpressionError("function calls must be plain names (no attribute access)")
        fname = node.func.id
        if fname not in _ALLOWED_FUNCS:
            raise UnsafeExpressionError(f"function not allowed: {fname}")
        if node.keywords:
            raise UnsafeExpressionError("keyword arguments are not allowed")
        args = [_walk(a, df) for a in node.args]
        return _ALLOWED_FUNCS[fname](*args)

    # ── Everything else is rejected ──────────────────────────────────────
    # Attribute access, subscript, starred args, generator expressions,
    # comprehensions, f-strings, lambda, await, joined strings, etc.
    raise UnsafeExpressionError(f"expression construct not allowed: {type(node).__name__}")
