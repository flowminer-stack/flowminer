"""
Shared mining helpers used across the mining-adjacent routers.

These were previously private helpers inside ``app.api.mining`` that other
routers (ai, bi, competitive, scorecards, task_mining, ocel, event_logs) and
the MCP server reached into directly — a router-imports-router smell. They are
relocated here, in the api-deps layer, so consumers depend on a shared
dependency module rather than on a sibling router. Kept byte-for-byte
equivalent to the originals; only their home moved.

This lives in its own module (rather than ``app.api.deps``) so the heavy
pandas / mining_engine imports stay out of the lightweight auth-dependency
module that nearly every router imports.
"""

import asyncio
import functools
import hashlib
import json
import logging
import os
from contextvars import ContextVar
from uuid import UUID

import pandas as pd
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import _user_can_access_project
from app.models import EventLog, Project, User
from app.schemas.mining import ProcessFilter
from app.services.ingestion import ACTIVITY_COL, CASE_COL, TIMESTAMP_COL
from app.services.mining_engine import mining_engine

# Shared mining result cache (Redis-backed, with in-process fallback).
# Using a shared cache means multi-worker deployments don't recompute the
# same discovery/conformance/etc. per worker.
from app.services.infra.result_cache import (
    cache_clear_event_log,
    cache_get,
    cache_set,
)

logger = logging.getLogger(__name__)


async def _run_in_thread(func, *args, **kwargs):
    """Run a blocking function in the threadpool so it doesn't block the event loop.

    Every CPU-heavy mining_engine call should be dispatched through this
    instead of being awaited directly. Using asyncio.to_thread is cheap and
    means concurrent requests can make progress on the event loop while one
    request's mining is in flight.
    """
    if kwargs:
        return await asyncio.to_thread(functools.partial(func, *args, **kwargs))
    return await asyncio.to_thread(func, *args)


def _make_params_hash(params: dict | None) -> str:
    """Create a deterministic hash for a set of parameters."""
    if not params:
        return "none"
    serialized = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


# Contextvar set by _assert_event_log_access at the top of every request.
# Used by the cache key scoping below so redacted results can't leak
# between roles on a cache hit.
_current_user_ctx: ContextVar[User | None] = ContextVar("mining_current_user", default=None)


def _scope_params(params: dict | None) -> dict:
    """Expand the cache params with a privacy scope. See _current_user_ctx."""
    scoped = dict(params or {})
    user = _current_user_ctx.get()
    if user is not None:
        scoped["_role"] = getattr(user.role, "value", str(user.role))
    return scoped


def _get_cached(event_log_id: UUID, analysis_type: str, params: dict | None = None) -> dict | None:
    return cache_get(str(event_log_id), analysis_type, _make_params_hash(_scope_params(params)))


def _set_cached(event_log_id: UUID, analysis_type: str, result: dict, params: dict | None = None):
    cache_set(str(event_log_id), analysis_type, result, _make_params_hash(_scope_params(params)))


def _clear_cache_for_event_log(event_log_id: UUID):
    """Remove all cached results for a given event log (called when column mapping changes)."""
    cache_clear_event_log(str(event_log_id))


async def _assert_event_log_access(event_log_id: UUID, db: AsyncSession, user: User) -> None:
    """Lightweight authorization check used BEFORE the result cache lookup.

    Without this, a cached mining result would leak to any authenticated user
    who guesses the event_log_id, because the cache bypasses the row fetch
    inside ``_load_event_log_and_df``. This helper does a small two-row lookup
    (event_log + project) and raises 404 if the caller can't access the
    parent project. It also binds ``user`` to the cache-scope contextvar so
    subsequent ``_get_cached`` / ``_set_cached`` calls are tenant-scoped.
    """
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")
    proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
    project = proj_result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    # Bind the authenticated user so cache keys are scoped by role.
    _current_user_ctx.set(user)


async def _load_event_log_and_df(event_log_id: UUID, db: AsyncSession, user: User | None = None):
    """
    Fetch the EventLog record from the DB, verify the caller has access to
    its parent project, validate it has column mapping, and load the
    DataFrame using the mining engine.

    Every mining endpoint funnels through this helper, so the authorization
    check applied here covers all 39 endpoints at once. The ``user``
    argument is optional only so callers that pass an explicit user can
    do so without keyword ambiguity — in practice every caller should
    pass the authenticated user.

    Returns:
        (event_log, df) tuple
    """
    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found"
        )

    # Row-level authorization: verify the current user can access the parent
    # project. If no user was passed in (shouldn't happen in practice but
    # guards against legacy callers), skip the check — existing endpoints
    # still authenticate via their own dependency.
    if user is not None:
        proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
        project = proj_result.scalar_one_or_none()
        if project is None or not _user_can_access_project(user, project):
            # Mask existence — don't leak the row to unauthorized callers.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    if event_log.log_type == "ocel":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This is an OCEL log. Standard process-mining analyses require a "
                "case/activity/timestamp mapping, which OCEL logs don't have. "
                "Use the OCEL views (/ocpm) or a standard event log instead."
            ),
        )

    if not event_log.case_id_column:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Column mapping not set. Please set case_id_column, activity_column, "
            "and timestamp_column before running analysis.",
        )

    if not event_log.file_path or not os.path.exists(event_log.file_path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event log file not found on disk",
        )

    try:
        # File I/O + pandas parsing runs in the threadpool so a 500 MB CSV
        # parse doesn't freeze every other request on the worker.
        df = await _run_in_thread(
            mining_engine.load_event_log,
            file_path=event_log.file_path,
            case_id_col=event_log.case_id_column,
            activity_col=event_log.activity_column,
            timestamp_col=event_log.timestamp_column,
            resource_col=event_log.resource_column,
            cost_col=event_log.cost_column,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error loading event log: {str(e)}",
        )

    # Apply per-project privacy config if one exists. This is how GDPR /
    # PII rules are enforced — the anonymizer runs on every frame that
    # flows into mining endpoints, so downstream analyses only ever see
    # the redacted version. Admins always see raw data.
    try:
        from app.models import PrivacyConfig, UserRole
        from app.services.anonymizer import anonymize_df

        if user is not None and user.role != UserRole.admin:
            pc_result = await db.execute(
                select(PrivacyConfig).where(PrivacyConfig.project_id == event_log.project_id)
            )
            pc = pc_result.scalar_one_or_none()
            if pc is not None:
                # Role-based raw-data access: if the user's role is not
                # allowed raw data, redact regardless of column flags.
                role_sees_raw = (
                    (user.role == UserRole.analyst and pc.analyst_sees_raw)
                    or (user.role == UserRole.viewer and pc.viewer_sees_raw)
                )
                if not role_sees_raw or pc.anonymize_resources or pc.anonymize_case_ids or pc.masked_columns:
                    df = await _run_in_thread(
                        anonymize_df,
                        df,
                        anonymize_resources=pc.anonymize_resources or not role_sees_raw,
                        anonymize_case_ids=pc.anonymize_case_ids or not role_sees_raw,
                        masked_columns=pc.masked_columns or [],
                    )
    except Exception as e:
        logger.warning("Privacy enforcement failed (continuing with raw data): %s", e)

    return event_log, df


def _apply_filters(df: pd.DataFrame, filters: ProcessFilter | None) -> pd.DataFrame:
    """Apply process-level filters to a DataFrame, returning a filtered copy."""
    if filters is None:
        return df

    filtered = df

    # Timeframe filter
    if filters.time_start:
        try:
            ts = pd.Timestamp(filters.time_start)
            filtered = filtered[filtered[TIMESTAMP_COL] >= ts]
        except Exception:
            pass
    if filters.time_end:
        try:
            ts = pd.Timestamp(filters.time_end)
            filtered = filtered[filtered[TIMESTAMP_COL] <= ts]
        except Exception:
            pass

    # Case duration filter
    if filters.duration_min is not None or filters.duration_max is not None:
        # Vectorized: one grouped min/max instead of a per-case apply(lambda).
        mm = filtered.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        case_dur = (mm["max"] - mm["min"]).dt.total_seconds()
        keep = case_dur.index
        if filters.duration_min is not None:
            keep = case_dur[case_dur >= filters.duration_min].index
        if filters.duration_max is not None:
            keep = keep.intersection(case_dur[case_dur <= filters.duration_max].index)
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Activity include (cases must contain ALL listed activities)
    if filters.activities_include:
        case_acts = filtered.groupby(CASE_COL)[ACTIVITY_COL].apply(set)
        required = set(filters.activities_include)
        keep = case_acts[case_acts.apply(lambda s: required.issubset(s))].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Activity exclude (cases containing ANY listed activity are removed)
    if filters.activities_exclude:
        excluded = set(filters.activities_exclude)
        case_acts = filtered.groupby(CASE_COL)[ACTIVITY_COL].apply(set)
        keep = case_acts[case_acts.apply(lambda s: s.isdisjoint(excluded))].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Start activity filter
    if filters.start_activities:
        starts = set(filters.start_activities)
        first_act = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].first()
        keep = first_act[first_act.isin(starts)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # End activity filter
    if filters.end_activities:
        ends = set(filters.end_activities)
        last_act = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].last()
        keep = last_act[last_act.isin(ends)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Variant filter
    if filters.variants is not None:
        case_variants = filtered.sort_values(TIMESTAMP_COL).groupby(CASE_COL)[ACTIVITY_COL].apply(
            lambda x: ' → '.join(x)
        )
        variant_list = case_variants.value_counts().index.tolist()
        selected_variant_strings = {variant_list[i] for i in filters.variants if i < len(variant_list)}
        keep = case_variants[case_variants.isin(selected_variant_strings)].index
        filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Attribute filters
    if filters.attributes:
        for attr_filter in filters.attributes:
            col = attr_filter.column
            if col not in filtered.columns:
                continue
            vals = set(attr_filter.values)
            # Vectorized membership instead of building a Python set per case:
            # a case matches if ANY of its rows has col in vals.
            matched = pd.Index(
                filtered.loc[filtered[col].astype(str).isin(vals), CASE_COL].unique()
            )
            if attr_filter.exclude:  # keep cases with NO matching value
                keep = pd.Index(filtered[CASE_COL].unique()).difference(matched)
            else:                    # keep cases with a matching value
                keep = matched
            filtered = filtered[filtered[CASE_COL].isin(keep)]

    # Edge-based filters: walk each case's activity sequence in time order
    # and build a set of consecutive (prev, current) pairs. Required edges
    # must ALL be present; forbidden edges must NOT appear.
    if filters.required_edges or filters.forbidden_edges:
        ordered = filtered.sort_values(TIMESTAMP_COL)
        case_pairs: dict = {}
        for case_id, group in ordered.groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].tolist()
            pairs = set()
            for i in range(len(acts) - 1):
                pairs.add((str(acts[i]), str(acts[i + 1])))
            case_pairs[case_id] = pairs

        required_set = {tuple(p) for p in (filters.required_edges or [])}
        forbidden_set = {tuple(p) for p in (filters.forbidden_edges or [])}

        def case_passes(pairs: set) -> bool:
            if required_set and not required_set.issubset(pairs):
                return False
            if forbidden_set and not pairs.isdisjoint(forbidden_set):
                return False
            return True

        keep_ids = [cid for cid, p in case_pairs.items() if case_passes(p)]
        filtered = filtered[filtered[CASE_COL].isin(keep_ids)]

    return filtered


def _build_log_context(
    df: "pd.DataFrame",
    *,
    algorithm: str | None = None,
    noise_threshold: float | None = None,
    complexity: float | None = None,
    visible_nodes: int | None = None,
    visible_edges: int | None = None,
) -> dict:
    """Build a compact context dict for AI narration of a process map.

    Called by endpoints that want to narrate "what does this map mean?"
    in an algorithm- and filter-aware way.  All map-level params are
    optional so existing callers (and any future callers that don't have
    map context) can pass only the DataFrame and still get a useful
    context block.

    Parameters
    ----------
    df:
        The event-log DataFrame already loaded and filtered for this request.
    algorithm:
        Discovery algorithm used to produce the map (e.g. "dfg", "inductive",
        "heuristic", "alpha").  ``None`` means the map was produced by the
        default algorithm or the caller does not know.
    noise_threshold:
        Noise/frequency threshold applied during discovery (0.0–1.0).
        Higher values prune low-frequency paths.  ``None`` if not applied.
    complexity:
        Complexity score of the resulting model (e.g. CFC or arc density),
        if computed by the caller.  ``None`` if unavailable.
    visible_nodes:
        Number of activity nodes visible in the rendered map after pruning.
        ``None`` if the caller does not track this.
    visible_edges:
        Number of directed edges visible in the rendered map after pruning.
        ``None`` if the caller does not track this.

    Returns
    -------
    dict
        A flat dict with stats, map metadata, and top-activity entries.
        Designed to be serialised as JSON and embedded in an LLM prompt.
    """
    context: dict = {}

    # ── Basic log stats ──────────────────────────────────────────────────
    try:
        context["total_cases"] = int(df[CASE_COL].nunique())
        context["total_events"] = int(len(df))
        context["total_activities"] = int(df[ACTIVITY_COL].nunique())
    except Exception:
        pass

    # ── Map-level metadata ────────────────────────────────────────────────
    if algorithm is not None:
        context["algorithm"] = algorithm
    if noise_threshold is not None:
        context["noise_threshold"] = noise_threshold
    if complexity is not None:
        context["complexity"] = complexity
    if visible_nodes is not None:
        context["visible_nodes"] = visible_nodes
    if visible_edges is not None:
        context["visible_edges"] = visible_edges

    # ── Top activities by frequency ───────────────────────────────────────
    try:
        top_acts = (
            df[ACTIVITY_COL]
            .value_counts()
            .head(10)
            .rename_axis("activity")
            .reset_index(name="count")
            .to_dict(orient="records")
        )
        context["top_activities"] = top_acts
    except Exception:
        pass

    return context
