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
"""

import logging

import pandas as pd

from app.services.safe_expression import UnsafeExpressionError, safe_eval

logger = logging.getLogger(__name__)


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
