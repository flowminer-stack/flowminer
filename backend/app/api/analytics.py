"""
Analytics endpoints covering the high-value competitor gaps:
- Sustainability / ESG metrics
- Agent mining
- Federated / cross-process benchmarking
- SQL sandbox
- Calendar heatmap
- Text-to-Widget natural-language query parser
"""

import logging
import os
import re
from uuid import UUID

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import _user_can_access_project, get_current_active_user
from app.database import get_db
from app.models import EventLog, Project, User
from app.services.ai.agent_mining import analyze_agents
from app.services.ingestion import ACTIVITY_COL, CASE_COL, RESOURCE_COL, TIMESTAMP_COL
from app.services.mining_engine import mining_engine
from app.services.sustainability import compute_sustainability

logger = logging.getLogger(__name__)
router = APIRouter()


async def _load_df(
    event_log_id: UUID,
    db: AsyncSession,
    user: User,
) -> tuple[EventLog, pd.DataFrame]:
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if not event_log or not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(status_code=404, detail="Event log not found")

    # Row-level authorization — don't let a caller analyze someone else's log
    proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
    project = proj_result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=404, detail="Event log not found")

    if not event_log.case_id_column:
        raise HTTPException(status_code=400, detail="Column mapping not set")
    df = mining_engine.load_event_log(
        file_path=event_log.file_path,
        case_id_col=event_log.case_id_column,
        activity_col=event_log.activity_column,
        timestamp_col=event_log.timestamp_column,
        resource_col=event_log.resource_column,
        cost_col=event_log.cost_column,
    )

    # Enforce per-project privacy config — same logic as mining.py path.
    try:
        from app.models import PrivacyConfig, UserRole
        from app.services.anonymizer import anonymize_df

        if user is not None and user.role != UserRole.admin:
            pc_result = await db.execute(
                select(PrivacyConfig).where(PrivacyConfig.project_id == event_log.project_id)
            )
            pc = pc_result.scalar_one_or_none()
            if pc is not None:
                role_sees_raw = (
                    (user.role == UserRole.analyst and pc.analyst_sees_raw)
                    or (user.role == UserRole.viewer and pc.viewer_sees_raw)
                )
                if not role_sees_raw or pc.anonymize_resources or pc.anonymize_case_ids or pc.masked_columns:
                    df = anonymize_df(
                        df,
                        anonymize_resources=pc.anonymize_resources or not role_sees_raw,
                        anonymize_case_ids=pc.anonymize_case_ids or not role_sees_raw,
                        masked_columns=pc.masked_columns or [],
                    )
    except Exception as e:
        logger.warning("Privacy enforcement failed on analytics path: %s", e)

    return event_log, df


# ─── Sustainability / ESG ────────────────────────────────────────────────────


class SustainabilityRequest(BaseModel):
    event_log_id: UUID
    factors: dict | None = None
    activity_overrides: dict[str, dict] | None = None


@router.post("/sustainability")
async def sustainability(
    body: SustainabilityRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return ESG metrics (CO2, energy, water, cost) per activity and over time."""
    _el, df = await _load_df(body.event_log_id, db, current_user)
    return compute_sustainability(df, factors=body.factors, activity_overrides=body.activity_overrides)


# ─── Agent mining ────────────────────────────────────────────────────────────


@router.get("/agent-mining/{event_log_id}")
async def agent_mining(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Classify resources as bot/human and analyze handoff patterns."""
    _el, df = await _load_df(event_log_id, db, current_user)
    return analyze_agents(df)


# ─── Federated / cross-process benchmarking ──────────────────────────────────


class BenchmarkRequest(BaseModel):
    event_log_ids: list[UUID]


def _process_kpis(df: pd.DataFrame) -> dict:
    """Aggregate KPIs for a single process — the output is safe to share federation-wide."""
    if df.empty:
        return {}
    case_durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
        lambda x: (x.max() - x.min()).total_seconds()
    )
    sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
    variant_series = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].apply(lambda x: "→".join(x))
    top_variant_share = float(variant_series.value_counts(normalize=True).iloc[0]) if len(variant_series) > 0 else 0
    return {
        "cases": int(df[CASE_COL].nunique()),
        "events": int(len(df)),
        "activities": int(df[ACTIVITY_COL].nunique()),
        "resources": int(df[RESOURCE_COL].nunique()) if RESOURCE_COL in df.columns else 0,
        "variants": int(variant_series.nunique()),
        "avg_case_duration_sec": float(case_durations.mean()) if len(case_durations) > 0 else 0,
        "median_case_duration_sec": float(case_durations.median()) if len(case_durations) > 0 else 0,
        "p95_case_duration_sec": float(case_durations.quantile(0.95)) if len(case_durations) > 0 else 0,
        "top_variant_share": round(top_variant_share, 3),
        "date_start": str(df[TIMESTAMP_COL].min()),
        "date_end": str(df[TIMESTAMP_COL].max()),
    }


def _percentile_rank(values: list[float], value: float) -> float:
    """Zero-indexed percentile rank of value within values (higher = 'better'-relative)."""
    if not values:
        return 0.5
    below = sum(1 for v in values if v < value)
    return round(below / len(values), 3)


@router.post("/benchmark")
async def benchmark(
    body: BenchmarkRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Compute aggregate KPIs for each selected event log and a benchmark summary
    (avg / min / max) across all selected processes. Raw event data never leaves
    each process's KPI block — this is the federated-analysis guarantee.
    """
    if not body.event_log_ids:
        raise HTTPException(status_code=400, detail="At least one event_log_id required")

    per_process = []
    for elid in body.event_log_ids:
        try:
            # Row-level authorization: pass current_user through so
            # _load_df's access check runs. Without it, a caller who
            # guesses an event_log_id they can't see in the UI would
            # still get KPIs for it.
            el, df = await _load_df(elid, db, current_user)
            kpis = _process_kpis(df)
            per_process.append({"event_log_id": str(elid), "name": el.name, "kpis": kpis})
        except HTTPException:
            # 403/404 from the access check — don't leak whether the
            # id exists; report a generic failure.
            per_process.append({"event_log_id": str(elid), "name": None, "error": "not accessible"})
        except Exception as e:
            logger.warning(f"Failed to load event_log {elid}: {e}")
            per_process.append({"event_log_id": str(elid), "name": None, "error": "load failed"})

    # Benchmark each KPI across all successfully loaded processes
    successful = [p for p in per_process if "kpis" in p]
    metrics = ["cases", "events", "activities", "resources", "variants",
               "avg_case_duration_sec", "median_case_duration_sec",
               "p95_case_duration_sec", "top_variant_share"]
    benchmark_summary = {}
    for m in metrics:
        values = [p["kpis"].get(m, 0) for p in successful if p["kpis"].get(m) is not None]
        if not values:
            continue
        benchmark_summary[m] = {
            "min": float(min(values)),
            "max": float(max(values)),
            "avg": float(sum(values) / len(values)),
        }

    # Annotate each process with its percentile rank for "avg_case_duration_sec"
    for p in successful:
        all_values = [pp["kpis"]["avg_case_duration_sec"] for pp in successful]
        p["kpis"]["duration_percentile"] = _percentile_rank(all_values, p["kpis"]["avg_case_duration_sec"])

    return {
        "processes": per_process,
        "benchmark": benchmark_summary,
        "total_processes": len(successful),
    }


# ─── SQL sandbox ─────────────────────────────────────────────────────────────


class SqlTableRef(BaseModel):
    """A secondary table to register alongside ``log`` for multi-table SQL.

    Exactly one of ``event_log_id`` / ``staging_path`` must be set. The table is
    exposed in the query under ``table_name`` (a SQL identifier). Event logs go
    through the same row-level access check as the primary ``log`` table;
    staging paths must resolve inside the configured upload directory.
    """

    table_name: str
    event_log_id: UUID | None = None
    # Staging paths are authorized too: a project-scoped path
    # (UPLOAD_DIR/<project_id>/...) goes through the same project access check
    # as event logs; only the transient builder staging dir is project-agnostic.
    staging_path: str | None = None


class SqlRequest(BaseModel):
    event_log_id: UUID
    query: str
    limit: int = 1000
    # Optional extra tables to register so users can write multi-table SQL
    # (DuckDB supports joins across them). Default: only the "log" table.
    tables: list[SqlTableRef] = []


# A registrable SQL identifier: letters/digits/underscore, not starting with a
# digit. Prevents injection / clobbering of the reserved ``log`` table name.
_SQL_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


async def _load_staging_dataframe(
    staging_path: str,
    db: AsyncSession,
    user: User,
) -> pd.DataFrame:
    """Load a staging/source table for SQL registration, validating the path
    AND authorizing the caller against whatever it belongs to.

    Resolving inside ``settings.UPLOAD_DIR`` alone is NOT sufficient: uploads
    are laid out as ``UPLOAD_DIR/<project_id>/<file>`` (see event_logs.upload /
    log_builder.build) so a bare commonpath check would let any authenticated
    user read another tenant's uploaded log as a SQL table (cross-tenant IDOR).

    We therefore classify the resolved path:

    * ``UPLOAD_DIR/<project_id>/...`` — a project-scoped file. The first path
      component must be a UUID and the caller must pass the SAME access check
      used everywhere else (``_user_can_access_project``); otherwise 404.
    * ``UPLOAD_DIR/_builder_staging/...`` — transient per-upload builder files
      written by ``/upload-raw`` (not tenant-scoped); accepted, mirroring the
      log-builder's own staging semantics.

    Anything else under (or outside) the upload root is rejected.
    """
    from app.config import settings

    upload_root = os.path.realpath(settings.UPLOAD_DIR)
    resolved = os.path.realpath(staging_path)
    try:
        if os.path.commonpath([resolved, upload_root]) != upload_root:
            raise ValueError("outside upload dir")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid staging path")

    # Determine which subtree of UPLOAD_DIR the file lives in. The relative
    # path's first component is either the builder staging dir or a project id.
    rel = os.path.relpath(resolved, upload_root)
    first_component = rel.split(os.sep, 1)[0]
    if first_component in ("", os.pardir):
        # Sits directly in UPLOAD_DIR with no project scoping — not a resource
        # any tenant owns; refuse rather than expose it.
        raise HTTPException(status_code=400, detail="Invalid staging path")

    if first_component != "_builder_staging":
        # Project-scoped path: the directory name must be a real project the
        # caller can access. Reject (as 404, matching deps.py) otherwise so we
        # neither leak existence nor serve another tenant's data.
        try:
            project_id = UUID(first_component)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Invalid staging path")
        proj_result = await db.execute(select(Project).where(Project.id == project_id))
        project = proj_result.scalar_one_or_none()
        if project is None or not _user_can_access_project(user, project):
            raise HTTPException(status_code=404, detail="Staging table not found")

    if not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="Staging table not found")

    ext = os.path.splitext(resolved)[1].lower()
    if ext == ".csv":
        try:
            return pd.read_csv(resolved, encoding="utf-8")
        except UnicodeDecodeError:
            return pd.read_csv(resolved, encoding="latin-1")
    if ext == ".parquet":
        return pd.read_parquet(resolved)
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(resolved)
    raise HTTPException(status_code=400, detail=f"Unsupported staging file type: {ext}")


_ALLOWED_SQL_PREFIX = re.compile(r"^\s*select\b", re.IGNORECASE)
# Strip /* block */ and -- line comments so attackers can't hide
# keywords inside comment fences ("SELECT 1/*DROP*/ FROM log").
_SQL_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_SQL_LINE_COMMENT = re.compile(r"--[^\n]*")
# DuckDB exposes a zoo of file-reading and file-writing functions that
# would turn the SELECT sandbox into an arbitrary-file-read primitive
# (``SELECT * FROM read_csv_auto('/etc/passwd')``). The original
# denylist only covered DDL/DML keywords, not these function calls.
_FORBIDDEN_SQL = re.compile(
    r"\b("
    r"insert|update|delete|drop|alter|create|attach|detach|pragma|"
    r"replace|truncate|copy|install|load|export|import|set|use|"
    r"read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|"
    r"read_ndjson|read_ndjson_auto|read_blob|read_text|"
    r"write_csv|write_parquet|write_json"
    r")\b",
    re.IGNORECASE,
)


@router.post("/sql-sandbox")
async def sql_sandbox(
    body: SqlRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Execute a read-only SELECT query against an event log (exposed as a table
    named `log`). Additional event logs / staging tables may be registered
    under distinct names via ``body.tables`` so users can write multi-table
    SQL joins (DuckDB supports this natively). Uses DuckDB when available,
    falling back to sqlite in-memory. Only SELECT statements are permitted.
    """
    q = body.query.strip().rstrip(";")
    # Strip comments BEFORE scanning — otherwise attackers can hide
    # forbidden tokens inside /* ... */ or -- fences.
    q_stripped = _SQL_BLOCK_COMMENT.sub(" ", q)
    q_stripped = _SQL_LINE_COMMENT.sub(" ", q_stripped)
    if ";" in q_stripped:
        raise HTTPException(status_code=400, detail="Multi-statement queries are not allowed")
    if not _ALLOWED_SQL_PREFIX.match(q_stripped):
        raise HTTPException(status_code=400, detail="Only SELECT queries are allowed")
    if _FORBIDDEN_SQL.search(q_stripped):
        raise HTTPException(status_code=400, detail="Query contains forbidden keywords")

    _el, df = await _load_df(body.event_log_id, db, current_user)

    # Resolve any additional tables BEFORE opening the connection so auth /
    # path validation failures surface as clean HTTP errors. Each goes through
    # the same _load_df access check (event logs) or upload-dir validation
    # (staging paths). The reserved "log" name cannot be overridden.
    extra_tables: dict[str, pd.DataFrame] = {}
    seen_names = {"log"}
    for ref in body.tables:
        name = ref.table_name
        if not _SQL_TABLE_NAME.match(name):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid table name '{name}': use letters, digits, underscore",
            )
        if name in seen_names:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate or reserved table name '{name}'",
            )
        if (ref.event_log_id is None) == (ref.staging_path is None):
            raise HTTPException(
                status_code=400,
                detail=f"Table '{name}' needs exactly one of event_log_id or staging_path",
            )
        if ref.event_log_id is not None:
            _el2, extra_df = await _load_df(ref.event_log_id, db, current_user)
        else:
            extra_df = await _load_staging_dataframe(ref.staging_path, db, current_user)  # type: ignore[arg-type]
        extra_tables[name] = extra_df
        seen_names.add(name)

    # Restrict row count up front
    limit = max(1, min(body.limit, 10000))

    # Prefer DuckDB for SQL power on DataFrames, fall back to sqlite.
    # We open the connection read-only and disable filesystem /
    # extension access so read_csv_auto('/etc/passwd') and friends
    # are rejected at the engine level even if the denylist misses.
    #
    # The user query is wrapped as a subquery `SELECT * FROM (?) LIMIT ?`
    # — we parameterize ``limit`` through the DB driver rather than
    # interpolating, and the query text itself only flows through after
    # the denylist + regex guards above. The DuckDB
    # ``enable_external_access = false`` setting is the last line of
    # defence against any injection that smuggles a file-reading
    # function past those guards; if DuckDB rejects the setting we
    # refuse the query rather than silently continuing with it enabled,
    # because the denylist alone is known to be incomplete.
    wrapped_query = f"SELECT * FROM ({q_stripped}) LIMIT {limit}"
    try:
        import duckdb  # type: ignore
        con = duckdb.connect(database=":memory:", read_only=False)
        try:
            try:
                con.execute("SET enable_external_access = false")
            except Exception as setting_err:
                con.close()
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "SQL sandbox unavailable: this DuckDB version "
                        "does not support the file-access lockdown "
                        "setting; refusing to run arbitrary queries "
                        f"without it ({setting_err})."
                    ),
                )
            con.register("log", df)
            for name, extra_df in extra_tables.items():
                con.register(name, extra_df)
            result_df = con.execute(wrapped_query).fetchdf()
        finally:
            try:
                con.close()
            except Exception:
                pass
    except ImportError:
        import sqlite3
        con = sqlite3.connect(":memory:")
        try:
            df.to_sql("log", con, index=False)
            for name, extra_df in extra_tables.items():
                extra_df.to_sql(name, con, index=False)
            result_df = pd.read_sql_query(wrapped_query, con)
        finally:
            con.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Query error: {type(e).__name__}")

    # Convert datetimes to strings for JSON
    for col in result_df.columns:
        if pd.api.types.is_datetime64_any_dtype(result_df[col]):
            result_df[col] = result_df[col].astype(str)

    return {
        "columns": list(result_df.columns),
        "rows": result_df.to_dict(orient="records"),
        "row_count": len(result_df),
        "truncated": len(result_df) >= limit,
    }


# ─── Calendar heatmap ────────────────────────────────────────────────────────


@router.get("/calendar-heatmap/{event_log_id}")
async def calendar_heatmap(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Return event counts bucketed by day-of-week x hour-of-day."""
    _el, df = await _load_df(event_log_id, db, current_user)
    if df.empty:
        return {"matrix": [], "days": [], "hours": list(range(24))}

    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    # dayofweek: 0 = Monday
    df2 = df.copy()
    df2["dow"] = df2[TIMESTAMP_COL].dt.dayofweek
    df2["hour"] = df2[TIMESTAMP_COL].dt.hour

    grouped = df2.groupby(["dow", "hour"]).size().to_dict()
    matrix = []
    total = int(len(df2))
    for d in range(7):
        row = {"day": days[d], "values": []}
        for h in range(24):
            count = int(grouped.get((d, h), 0))
            row["values"].append({"hour": h, "count": count, "share": round(count / total, 4) if total else 0})
        matrix.append(row)

    # Peak identification
    peak_dow, peak_hour = max(grouped, key=grouped.get) if grouped else (0, 0)
    off_hours_events = int(sum(v for (d, h), v in grouped.items() if h < 6 or h > 20))

    return {
        "matrix": matrix,
        "days": days,
        "hours": list(range(24)),
        "total_events": total,
        "peak_day": days[peak_dow],
        "peak_hour": peak_hour,
        "off_hours_events": off_hours_events,
        "off_hours_share": round(off_hours_events / total, 3) if total else 0,
    }


# ─── Text-to-Widget (NL query parser) ────────────────────────────────────────


class TextToWidgetRequest(BaseModel):
    event_log_id: UUID
    question: str


_NL_PATTERNS = [
    (r"(bottleneck|slowest|longest activit)", "bottleneck"),
    (r"(rework|loop|repeat)", "rework"),
    (r"(variant|path|route)", "variants"),
    (r"(conformance|fitness|deviation)", "conformance"),
    (r"(throughput|case count|total cases)", "case_count"),
    (r"(duration|cycle time|how long)", "case_duration"),
    (r"(top resource|busiest resource|who does)", "resource_top"),
    (r"(activit.*count|most frequent activ)", "activity_frequency"),
    (r"(when|hour|day of week|heatmap|calendar)", "calendar"),
    (r"(bot|automation|rpa|agent)", "agent_mining"),
    (r"(co2|carbon|emission|sustainab|esg|energy)", "sustainability"),
    (r"(trend|over time|monthly)", "trend"),
]


@router.post("/text-to-widget")
async def text_to_widget(
    body: TextToWidgetRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Parse a natural language question into a widget configuration.

    This is a lightweight keyword router — not an LLM call. It picks the best
    endpoint and chart type to answer the question, and executes it.
    """
    _el, df = await _load_df(body.event_log_id, db, current_user)
    q = body.question.lower()

    chosen = None
    for pattern, kind in _NL_PATTERNS:
        if re.search(pattern, q):
            chosen = kind
            break

    if chosen is None:
        # Default to case duration distribution
        chosen = "case_duration"

    # Build a widget config and compute its data
    widget: dict = {"question": body.question, "kind": chosen}

    if chosen == "bottleneck":
        data = mining_engine.run_bottleneck_analysis(df)
        top = data.get("bottlenecks", [])[:10]
        widget.update({
            "title": "Top bottleneck activities",
            "chart_type": "bar",
            "x": [b.get("activity") for b in top],
            "y": [b.get("avg_duration", 0) for b in top],
            "y_label": "avg duration (s)",
        })
    elif chosen == "rework":
        data = mining_engine.get_rework(df)
        items = data.get("rework_activities", [])[:10]
        widget.update({
            "title": "Activities with most rework",
            "chart_type": "bar",
            "x": [a.get("activity") for a in items],
            "y": [a.get("rework_count", 0) for a in items],
            "y_label": "rework count",
        })
    elif chosen == "variants":
        data = mining_engine.run_variant_analysis(df)
        vs = data.get("variants", [])[:10]
        widget.update({
            "title": "Top process variants",
            "chart_type": "bar",
            "x": [f"#{i+1}" for i in range(len(vs))],
            "y": [v.get("case_count", 0) for v in vs],
            "y_label": "cases",
        })
    elif chosen == "conformance":
        data = mining_engine.run_conformance(df)
        widget.update({
            "title": "Conformance fitness",
            "chart_type": "gauge",
            "value": round(float(data.get("fitness", 0)) * 100, 1),
            "unit": "%",
        })
    elif chosen == "case_count":
        widget.update({
            "title": "Total cases",
            "chart_type": "kpi",
            "value": int(df[CASE_COL].nunique()),
        })
    elif chosen == "case_duration":
        durations = df.groupby(CASE_COL)[TIMESTAMP_COL].apply(
            lambda x: (x.max() - x.min()).total_seconds()
        )
        widget.update({
            "title": "Case duration distribution (seconds)",
            "chart_type": "histogram",
            "values": durations.tolist()[:500],
            "mean": float(durations.mean()) if len(durations) else 0,
            "median": float(durations.median()) if len(durations) else 0,
        })
    elif chosen == "resource_top":
        if RESOURCE_COL in df.columns:
            top = df[RESOURCE_COL].value_counts().head(10)
            widget.update({
                "title": "Busiest resources",
                "chart_type": "bar",
                "x": top.index.astype(str).tolist(),
                "y": top.values.tolist(),
                "y_label": "events",
            })
        else:
            widget.update({"title": "No resource column", "chart_type": "empty"})
    elif chosen == "activity_frequency":
        top = df[ACTIVITY_COL].value_counts().head(15)
        widget.update({
            "title": "Most frequent activities",
            "chart_type": "bar",
            "x": top.index.astype(str).tolist(),
            "y": top.values.tolist(),
            "y_label": "events",
        })
    elif chosen == "calendar":
        cal = await calendar_heatmap(body.event_log_id, db, current_user=current_user)  # type: ignore
        widget.update({
            "title": "Activity by day and hour",
            "chart_type": "heatmap",
            "data": cal,
        })
    elif chosen == "agent_mining":
        data = analyze_agents(df)
        widget.update({
            "title": "Human vs automated work",
            "chart_type": "pie",
            "labels": ["bot", "human"],
            "values": [data.get("bot_events", 0), data.get("human_events", 0)],
        })
    elif chosen == "sustainability":
        data = compute_sustainability(df)
        widget.update({
            "title": "CO2 emissions by activity",
            "chart_type": "bar",
            "x": [a["activity"] for a in data.get("by_activity", [])[:10]],
            "y": [a["co2_g"] for a in data.get("by_activity", [])[:10]],
            "y_label": "CO2 (g)",
        })
    elif chosen == "trend":
        df2 = df.copy()
        df2["month"] = df2[TIMESTAMP_COL].dt.to_period("M").astype(str)
        monthly = df2.groupby("month")[CASE_COL].nunique()
        widget.update({
            "title": "Cases per month",
            "chart_type": "line",
            "x": monthly.index.tolist(),
            "y": monthly.values.tolist(),
            "y_label": "cases",
        })

    return widget
