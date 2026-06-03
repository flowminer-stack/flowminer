"""
ETL Pipeline executor: applies a sequence of transformation steps to a pandas DataFrame.

Supported step types:
    - filter_rows: {"type": "filter_rows", "column": str, "operator": "eq"|"ne"|"gt"|"lt"|"contains"|"not_null", "value": any}
    - rename_column: {"type": "rename_column", "old_name": str, "new_name": str}
    - drop_column: {"type": "drop_column", "column": str}
    - derive_column: {"type": "derive_column", "name": str, "expression": str}  # e.g., "col_a + col_b"
    - cast_type: {"type": "cast_type", "column": str, "dtype": "str"|"int"|"float"|"datetime"}
    - fill_missing: {"type": "fill_missing", "column": str, "value": any}
    - deduplicate: {"type": "deduplicate", "columns": list[str]}  # drop duplicate rows by columns
    - sort: {"type": "sort", "column": str, "ascending": bool}
    - limit_rows: {"type": "limit_rows", "limit": int}
    - join_table: {"type": "join_table", "right_source": str, "left_on": list[str],
                   "right_on": list[str], "how": "left"|"inner"|"right"|"outer",
                   "suffixes": [str, str]}
                   # merge another table (header+line+status ERP joins) onto the
                   # working DataFrame. ``right_source`` is a staging/file path.
"""

import logging
from pathlib import Path

import pandas as pd

from app.services.infra.safe_expression import UnsafeExpressionError, safe_eval

logger = logging.getLogger(__name__)

_VALID_JOIN_HOW = {"left", "inner", "right", "outer"}


def _load_right_dataframe(file_path: str) -> pd.DataFrame:
    """Load the right-hand DataFrame for a join step from a file path.

    Mirrors the loaders in log_builder/etl: supports CSV (with latin-1
    fallback), Parquet, and Excel.
    """
    ext = Path(file_path).suffix.lower()
    if ext == ".csv":
        try:
            return pd.read_csv(file_path, encoding="utf-8")
        except UnicodeDecodeError:
            return pd.read_csv(file_path, encoding="latin-1")
    if ext == ".parquet":
        return pd.read_parquet(file_path)
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(file_path)
    raise ValueError(f"Unsupported file type for join_table: {ext}")


def execute_pipeline(df: pd.DataFrame, steps: list[dict]) -> pd.DataFrame:
    """Apply a sequence of transformation steps to a DataFrame.

    Returns a new DataFrame (does not modify the input).
    Raises ValueError on invalid step configuration.
    """
    result = df.copy()

    for i, step in enumerate(steps):
        step_type = step.get("type")
        try:
            if step_type == "filter_rows":
                result = _filter_rows(result, step)
            elif step_type == "rename_column":
                result = result.rename(columns={step["old_name"]: step["new_name"]})
            elif step_type == "drop_column":
                col = step["column"]
                if col in result.columns:
                    result = result.drop(columns=[col])
            elif step_type == "derive_column":
                # Sandboxed AST walker — does NOT use pandas.eval or Python eval.
                # See app/services/safe_expression.py for the allowed grammar.
                try:
                    value = safe_eval(step["expression"], result)
                except UnsafeExpressionError:
                    raise  # bubble up so the user gets a clean 400
                result[step["name"]] = value
            elif step_type == "cast_type":
                col = step["column"]
                dtype = step["dtype"]
                if col in result.columns:
                    if dtype == "datetime":
                        result[col] = pd.to_datetime(result[col], errors="coerce")
                    elif dtype == "int":
                        result[col] = pd.to_numeric(result[col], errors="coerce").astype("Int64")
                    elif dtype == "float":
                        result[col] = pd.to_numeric(result[col], errors="coerce")
                    else:
                        result[col] = result[col].astype(str)
            elif step_type == "fill_missing":
                col = step["column"]
                if col in result.columns:
                    result[col] = result[col].fillna(step["value"])
            elif step_type == "deduplicate":
                cols = step.get("columns")
                result = result.drop_duplicates(subset=cols if cols else None)
            elif step_type == "sort":
                col = step["column"]
                if col in result.columns:
                    result = result.sort_values(col, ascending=step.get("ascending", True))
            elif step_type == "limit_rows":
                limit = step.get("limit", 10000)
                result = result.head(limit)
            elif step_type == "join_table":
                result = _join_table(result, step)
            else:
                logger.warning(f"Unknown ETL step type '{step_type}' at index {i}, skipping")
        except Exception as e:
            raise ValueError(f"ETL step {i} ({step_type}) failed: {e}") from e

    return result


def _filter_rows(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    col = step["column"]
    op = step["operator"]
    val = step.get("value")

    if col not in df.columns:
        return df

    if op == "eq":
        return df[df[col].astype(str) == str(val)]
    elif op == "ne":
        return df[df[col].astype(str) != str(val)]
    elif op == "gt":
        return df[pd.to_numeric(df[col], errors="coerce") > float(val)]
    elif op == "lt":
        return df[pd.to_numeric(df[col], errors="coerce") < float(val)]
    elif op == "contains":
        return df[df[col].astype(str).str.contains(str(val), case=False, na=False)]
    elif op == "not_null":
        return df[df[col].notna()]
    else:
        raise ValueError(f"Unknown filter operator: {op}")


def _join_table(df: pd.DataFrame, step: dict) -> pd.DataFrame:
    """Merge another table onto the working DataFrame (header+line+status joins).

    Loads the right-hand DataFrame from ``step['right_source']`` (a file/staging
    path), validates that the join keys exist on both sides, and performs a
    pandas merge. Raises ValueError with a clear message on any misconfiguration.
    """
    right_source = step.get("right_source")
    if not right_source:
        raise ValueError("join_table requires a 'right_source' (path to the table to join)")

    how = step.get("how", "left")
    if how not in _VALID_JOIN_HOW:
        raise ValueError(
            f"join_table 'how' must be one of {sorted(_VALID_JOIN_HOW)}, got '{how}'"
        )

    left_on = step.get("left_on") or []
    right_on = step.get("right_on") or left_on
    if isinstance(left_on, str):
        left_on = [left_on]
    if isinstance(right_on, str):
        right_on = [right_on]
    if not left_on or not right_on:
        raise ValueError("join_table requires 'left_on' (and optionally 'right_on') join keys")
    if len(left_on) != len(right_on):
        raise ValueError(
            f"join_table left_on ({len(left_on)} keys) and right_on "
            f"({len(right_on)} keys) must have the same length"
        )

    missing_left = [c for c in left_on if c not in df.columns]
    if missing_left:
        raise ValueError(f"join_table left keys not found in source table: {missing_left}")

    try:
        right_df = _load_right_dataframe(right_source)
    except FileNotFoundError as e:
        raise ValueError(f"join_table right_source could not be loaded: {e}") from e

    missing_right = [c for c in right_on if c not in right_df.columns]
    if missing_right:
        raise ValueError(f"join_table right keys not found in joined table: {missing_right}")

    suffixes = step.get("suffixes") or ["", "_right"]
    if isinstance(suffixes, list):
        suffixes = tuple(suffixes[:2])
    if len(suffixes) != 2:
        raise ValueError("join_table 'suffixes' must be a list/tuple of exactly 2 strings")

    # The canonical ERP join (header onto lines, status onto header, ...) is
    # *-to-one: the right table holds at most one row per join key. A non-unique
    # right key would make pandas fan out into a many-to-many cross product,
    # silently multiplying rows and corrupting the resulting event-log count.
    # Detect that up front and reject it with a clear message instead of
    # producing a wrong log. pandas' validate="many_to_one" enforces exactly
    # this (it raises MergeError when the right key is not unique).
    dup_count = right_df.duplicated(subset=right_on).sum()
    if dup_count:
        raise ValueError(
            f"join_table right_source has {int(dup_count)} duplicate row(s) for join "
            f"key(s) {right_on}; a non-unique right key would multiply rows "
            "(many-to-many fan-out). Deduplicate or aggregate the joined table "
            "on its key first."
        )

    return df.merge(
        right_df,
        how=how,
        left_on=left_on,
        right_on=right_on,
        suffixes=suffixes,
        validate="many_to_one",
    )
