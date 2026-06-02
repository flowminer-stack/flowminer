"""
Event Log Builder — transform a raw table (one row per case with multiple
timestamp columns) into an event log (one row per event).

The canonical use case: the user has a CSV like
  order_id, customer, created_at, approved_at, shipped_at, delivered_at
and wants:
  case_id=order_id, activity="Created",   timestamp=created_at
  case_id=order_id, activity="Approved",  timestamp=approved_at
  ...
"""

import logging
from collections.abc import Callable
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)


def _load_dataframe(file_path: str) -> pd.DataFrame:
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
    raise ValueError(f"Unsupported file type for builder: {ext}")


def preview_table(file_path: str, limit: int = 20) -> dict:
    """Return columns, sample rows, and inferred column kinds."""
    df = _load_dataframe(file_path)
    sample = df.head(limit).copy()

    # Serialize datetimes
    for col in sample.columns:
        if pd.api.types.is_datetime64_any_dtype(sample[col]):
            sample[col] = sample[col].astype(str)
    sample = sample.where(pd.notnull(sample), None)

    # Infer column kind
    columns = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        kind = "text"
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            kind = "datetime"
        elif pd.api.types.is_numeric_dtype(df[col]):
            kind = "numeric"
        else:
            # Try parsing as datetime
            try:
                parsed = pd.to_datetime(df[col].dropna().head(50), errors="coerce")
                non_null_ratio = parsed.notna().mean()
                if non_null_ratio > 0.8:
                    kind = "datetime_like"
            except Exception:
                pass

        columns.append({
            "name": col,
            "dtype": dtype,
            "kind": kind,
            "nunique": int(df[col].nunique()),
            "null_ratio": round(float(df[col].isna().mean()), 3),
        })

    return {
        "columns": columns,
        "sample_rows": sample.to_dict(orient="records"),
        "total_rows": int(len(df)),
    }


def _assemble_wide_table(
    file_path: str,
    additional_sources: list[str] | None = None,
    joins: list[dict] | None = None,
    path_validator: Callable[[str], str] | None = None,
) -> pd.DataFrame:
    """Load the primary source and optionally join additional tables into one
    wide DataFrame before the wide->long pivot.

    The canonical multi-table ERP shape is header + line + status tables that
    share a key (e.g. order_id). ``joins`` is a list of join specs in the same
    shape the ETL executor understands::

        {"right_source": <path>, "left_on": [...], "right_on": [...],
         "how": "left"|"inner"|..., "suffixes": [..]}

    A ``right_source`` may either be an explicit path or a 0-based index into
    ``additional_sources`` (when given as an int / numeric string), which lets
    callers reference uploaded staging files by position.

    ``path_validator`` is an optional callback (the API layer's staging-dir
    guard) applied to every resolved string right_source path before it is
    read. This is defense-in-depth: it confines join sources to the allowed
    staging dir even if a caller bypasses the API-level validation, closing the
    path-traversal hole where a string ``right_source`` would otherwise be read
    directly. When ``None`` (the legacy single-source / trusted in-process
    callers) no extra confinement is applied.

    Returns the assembled DataFrame. Falls back to a plain load of
    ``file_path`` when no joins are supplied (single-source path).
    """
    df = _load_dataframe(file_path)

    if not joins:
        return df

    # Reuse the ETL executor's join step so join semantics stay identical
    # across the builder and the pipeline editor.
    from app.services.etl_executor import _join_table

    additional = additional_sources or []
    for spec in joins:
        right = spec.get("right_source")
        # Allow referencing an uploaded additional source by index.
        if right is None:
            raise ValueError("Each join needs a 'right_source' (path or source index)")
        if isinstance(right, int) or (isinstance(right, str) and right.isdigit()):
            idx = int(right)
            if idx < 0 or idx >= len(additional):
                raise ValueError(
                    f"join right_source index {idx} is out of range "
                    f"({len(additional)} additional sources provided)"
                )
            right = additional[idx]
        elif path_validator is not None:
            # Explicit string path: confine it to the allowed staging dir.
            right = path_validator(right)
        step = {**spec, "type": "join_table", "right_source": right}
        df = _join_table(df, step)

    return df


def build_event_log(
    file_path: str,
    case_id_column: str,
    events: list[dict],
    resource_column: str | None = None,
    passthrough_columns: list[str] | None = None,
    output_path: str = None,
    additional_sources: list[str] | None = None,
    joins: list[dict] | None = None,
    path_validator: Callable[[str], str] | None = None,
) -> dict:
    """Unpivot a wide table into a long event log.

    Supports both a single source table and multi-table assembly: when
    ``joins`` are supplied the primary ``file_path`` is merged with the
    ``additional_sources`` into one wide table first, then the existing
    wide->long pivot runs unchanged. With no joins the behaviour is identical
    to the original single-source builder (fully backward compatible).

    Args:
        file_path: Primary source table path (CSV/Parquet/Excel)
        case_id_column: Column holding the case identifier (on the wide table)
        events: List of {activity_name, timestamp_column} (+ optional
                resource_column, cost_column override per event)
        resource_column: Default resource column for every event
        passthrough_columns: Columns copied onto every event row
        output_path: Where to write the resulting CSV
        additional_sources: Extra table paths to join onto the primary source.
                A join's ``right_source`` may reference these by 0-based index.
        joins: Join specs (see ``_assemble_wide_table``) assembling the wide
                table before the pivot.
        path_validator: Optional callback applied to every explicit string
                join ``right_source`` to confine it to the allowed staging dir
                (defense-in-depth against path traversal). See
                ``_assemble_wide_table``.

    Returns:
        dict with total_events, total_cases, output_path
    """
    df = _assemble_wide_table(file_path, additional_sources, joins, path_validator)
    if case_id_column not in df.columns:
        raise ValueError(f"case_id_column '{case_id_column}' not found")

    if not events:
        raise ValueError("At least one event mapping is required")

    passthrough = passthrough_columns or []
    for col in passthrough:
        if col not in df.columns:
            raise ValueError(f"Passthrough column '{col}' not found")

    rows: list[dict] = []
    for ev in events:
        activity = ev.get("activity_name")
        ts_col = ev.get("timestamp_column")
        if not activity or not ts_col:
            raise ValueError("Each event needs activity_name and timestamp_column")
        if ts_col not in df.columns:
            raise ValueError(f"Timestamp column '{ts_col}' not found")

        ev_resource_col = ev.get("resource_column") or resource_column
        ev_cost_col = ev.get("cost_column")

        sub = df[[case_id_column, ts_col] + passthrough].copy()
        # Parse timestamps
        sub[ts_col] = pd.to_datetime(sub[ts_col], errors="coerce")
        sub = sub.dropna(subset=[ts_col])
        sub = sub.rename(columns={case_id_column: "case_id", ts_col: "timestamp"})
        sub["activity"] = activity

        if ev_resource_col and ev_resource_col in df.columns:
            sub["resource"] = df.loc[sub.index, ev_resource_col].values
        if ev_cost_col and ev_cost_col in df.columns:
            sub["cost"] = df.loc[sub.index, ev_cost_col].values

        rows.append(sub)

    if not rows:
        raise ValueError("No valid events produced — check timestamp columns have data")

    out_df = pd.concat(rows, ignore_index=True)
    out_df = out_df.sort_values(["case_id", "timestamp"]).reset_index(drop=True)

    # Reorder so core columns come first
    core = ["case_id", "activity", "timestamp"]
    optional = [c for c in ["resource", "cost"] if c in out_df.columns]
    rest = [c for c in out_df.columns if c not in core + optional]
    out_df = out_df[core + optional + rest]

    if output_path:
        out_df.to_csv(output_path, index=False)

    return {
        "total_events": int(len(out_df)),
        "total_cases": int(out_df["case_id"].nunique()),
        "activities": sorted(out_df["activity"].unique().tolist()),
        "output_path": output_path,
        "columns": out_df.columns.tolist(),
    }
