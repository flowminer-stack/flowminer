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


def build_ocel(
    file_path: str,
    object_type_columns: list[str],
    events: list[dict],
    output_path: str,
    additional_sources: list[str] | None = None,
    joins: list[dict] | None = None,
    path_validator: Callable[[str], str] | None = None,
) -> dict:
    """Assemble a wide table (single or multi-table) and emit an OCEL 2.0 log.

    This is the object-centric sibling of :func:`build_event_log`. Instead of
    one *case id* column it takes ``object_type_columns`` — a list of columns
    on the assembled wide table, each of which designates an OBJECT TYPE whose
    id lives in that column. The same wide table is unpivoted (one row per
    event using the ``events`` activity/timestamp mapping) and then handed to
    pm4py's ``convert_log_to_ocel`` so every event is related to one object of
    each designated type.

    The reuse story matches ``build_event_log`` exactly: the join assembly goes
    through :func:`_assemble_wide_table` (so multi-table ERP shapes — header +
    line + status — work identically), then we pivot wide->long, then convert.

    Args:
        file_path: Primary source table path (CSV/Parquet/Excel).
        object_type_columns: Wide-table columns, each = one OCEL object type.
        events: List of ``{activity_name, timestamp_column}`` event mappings.
        output_path: Where to write the resulting ``.jsonocel`` file (OCEL 2.0).
        additional_sources / joins / path_validator: See
            :func:`_assemble_wide_table`.

    Returns:
        dict with ``object_types``, ``event_count``, ``object_count``,
        ``activities`` and ``output_path``.
    """
    import pm4py

    df = _assemble_wide_table(file_path, additional_sources, joins, path_validator)

    if not object_type_columns:
        raise ValueError("At least one object type column is required for an OCEL build")
    missing_ot = [c for c in object_type_columns if c not in df.columns]
    if missing_ot:
        raise ValueError(f"Object type columns not found on the assembled table: {missing_ot}")

    if not events:
        raise ValueError("At least one event mapping is required")

    # Unpivot the wide table into a long event table, carrying every object-id
    # column onto each event row. The activity/timestamp columns are renamed to
    # pm4py's canonical names so convert_log_to_ocel can pick them up directly.
    rows: list[pd.DataFrame] = []
    for ev in events:
        activity = ev.get("activity_name")
        ts_col = ev.get("timestamp_column")
        if not activity or not ts_col:
            raise ValueError("Each event needs activity_name and timestamp_column")
        if ts_col not in df.columns:
            raise ValueError(f"Timestamp column '{ts_col}' not found")

        sub = df[object_type_columns + [ts_col]].copy()
        sub[ts_col] = pd.to_datetime(sub[ts_col], errors="coerce")
        sub = sub.dropna(subset=[ts_col])
        # Drop rows where every object id is null — they relate no objects.
        sub = sub.dropna(subset=object_type_columns, how="all")
        sub = sub.rename(columns={ts_col: "time:timestamp"})
        sub["concept:name"] = activity
        rows.append(sub)

    if not rows:
        raise ValueError("No valid events produced — check timestamp columns have data")

    long_df = pd.concat(rows, ignore_index=True)
    if long_df.empty:
        raise ValueError("No valid events produced after parsing timestamps")

    # Object ids must be strings for pm4py (it keys objects by id value).
    for col in object_type_columns:
        long_df[col] = long_df[col].astype("string")

    long_df = long_df.sort_values("time:timestamp").reset_index(drop=True)

    try:
        ocel = pm4py.convert_log_to_ocel(
            long_df,
            activity_column="concept:name",
            timestamp_column="time:timestamp",
            object_types=object_type_columns,
        )
    except Exception as e:
        raise ValueError(f"OCEL conversion failed: {e}") from e

    # Persist as OCEL 2.0 JSON so it is reloadable after a worker restart.
    writer = getattr(pm4py, "write_ocel2_json", None) or getattr(pm4py, "write_ocel_json", None)
    if writer is None:  # pragma: no cover - pinned pm4py always has these
        raise ValueError("Installed pm4py exposes no OCEL JSON writer")
    writer(ocel, output_path)

    try:
        object_types = list(pm4py.ocel_get_object_types(ocel))
    except Exception:
        object_types = list(object_type_columns)

    try:
        event_count = int(len(ocel.events))
    except Exception:
        event_count = int(len(long_df))
    try:
        object_count = int(len(ocel.objects))
    except Exception:
        object_count = 0

    activities = sorted({str(a) for a in long_df["concept:name"].unique().tolist()})

    return {
        "object_types": object_types,
        "event_count": event_count,
        "object_count": object_count,
        "activities": activities,
        "output_path": output_path,
        "ocel": ocel,
    }
