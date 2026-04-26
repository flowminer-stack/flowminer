"""Verify the ETL expression sandbox rejects every class of unsafe construct.

If any of these start passing silently we have regressed — a subsequent
``pd.DataFrame.eval`` or raw ``eval`` call has crept back in somewhere.
"""

import pandas as pd
import pytest

from app.services.safe_expression import UnsafeExpressionError, safe_eval


@pytest.fixture
def df():
    return pd.DataFrame({"a": [1, 2, 3], "b": [10, 20, 30], "name": ["foo", "bar", "baz"]})


# ── Legit expressions all execute ────────────────────────────────────────────


def test_arithmetic(df):
    assert safe_eval("a + b", df).tolist() == [11, 22, 33]
    assert safe_eval("a * 2 + b", df).tolist() == [12, 24, 36]
    assert safe_eval("a / 2", df).tolist() == [0.5, 1.0, 1.5]


def test_comparisons(df):
    result = safe_eval("a > 1", df).tolist()
    assert result == [False, True, True]


def test_bool_ops(df):
    result = safe_eval("(a > 1) and (b < 30)", df).tolist()
    assert result == [False, True, False]


def test_allowed_functions(df):
    assert safe_eval("abs(a - 2)", df).tolist() == [1, 0, 1]
    assert safe_eval("round(a / 2, 1)", df).tolist() == [0.5, 1.0, 1.5]
    assert safe_eval("upper(name)", df).tolist() == ["FOO", "BAR", "BAZ"]
    assert safe_eval("lower(name)", df).tolist() == ["foo", "bar", "baz"]
    assert safe_eval("len(name)", df).tolist() == [3, 3, 3]


def test_string_literals(df):
    # Comparing against a literal string
    result = safe_eval("name == 'foo'", df).tolist()
    assert result == [True, False, False]


# ── Attack surface — every one of these must raise ───────────────────────────


@pytest.mark.parametrize(
    "expr",
    [
        '__import__("os").system("ls")',
        "a.__class__.__bases__",
        'open("/etc/passwd")',
        "a + __builtins__",
        "(lambda: 1)()",
        "[x for x in a]",
        "{x: x for x in a}",
        "a if True else b",
        "eval('1+1')",
        "exec('x=1')",
        "globals()",
        "getattr(a, 'sum')",
        "a @ b",  # matrix mul — not in our allowlist
        "a:b",  # slice — hard-fail at parse time
    ],
)
def test_attacks_rejected(df, expr):
    with pytest.raises((UnsafeExpressionError, SyntaxError)):
        safe_eval(expr, df)


def test_unknown_column_rejected(df):
    with pytest.raises(UnsafeExpressionError):
        safe_eval("nonexistent_column + 1", df)


def test_unknown_function_rejected(df):
    with pytest.raises(UnsafeExpressionError):
        safe_eval("sum(a)", df)  # sum is not in the allowlist


def test_expression_length_limit():
    import pandas as pd
    # Expression > 1000 chars
    big = "a" + "+a" * 800  # 1 + 2*800 = 1601 chars
    with pytest.raises(UnsafeExpressionError):
        safe_eval(big, pd.DataFrame({"a": [1]}))


def test_non_string_expression():
    with pytest.raises(UnsafeExpressionError):
        safe_eval(123, pd.DataFrame({"a": [1]}))  # type: ignore[arg-type]
