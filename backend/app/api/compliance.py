"""
Compliance router: SLA-aware Timed-Declare conformance.

Evaluates time-bounded DECLARE-style constraints (an SLA window T per
constraint) over an event log: response/precedence within T plus
existence/absence within T of the case start, with an optional Mon–Fri
business-days duration mode.

Mounts at ``/api/v1/compliance`` (see ``app.main._routers``). Results are
cached in-memory/Redis keyed by (event_log_id, "timed_declare",
params_hash) where the params hash includes the constraints JSON, so two
different constraint sets on the same log don't collide.

This router deliberately does NOT import from ``app.api.mining`` — it reuses
the shared mining helpers from ``app.api._mining_deps`` (auth, df loading,
threadpool dispatch, result cache) like every other mining-adjacent router.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._mining_deps import (
    _assert_event_log_access,
    _get_cached,
    _load_event_log_and_df,
    _run_in_thread,
    _set_cached,
)
from app.api.deps import get_current_active_user
from app.database import get_db
from app.models import User
from app.schemas.formal_methods import TimedDeclareRequest, TimedDeclareResponse
from app.services.mining_engine import mining_engine

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/timed-declare/{event_log_id}", response_model=TimedDeclareResponse)
async def check_timed_declare(
    event_log_id: UUID,
    body: TimedDeclareRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run SLA-aware Timed-Declare conformance on an event log.

    The request body carries a list of time-bounded constraints. Each is
    evaluated against every (activating) case; the response returns a
    per-constraint violation_rate, a bounded sample of violating_case_ids,
    and time-to-violation distribution stats.
    """
    # Serialize constraints for the cache key so distinct constraint sets
    # produce distinct cache entries (params_hash hashes this dict).
    constraints = [c.model_dump() for c in body.constraints]
    cache_params = {"constraints": constraints}

    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "timed_declare", cache_params)
    if cached is not None:
        return TimedDeclareResponse(**cached)

    if not constraints:
        # Nothing to evaluate — return an empty result without loading the log.
        empty = {"total_cases": 0, "results": []}
        return TimedDeclareResponse(**empty)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        result = await _run_in_thread(
            mining_engine.check_timed_declare, df, constraints
        )
    except Exception as e:
        logger.error(f"Timed-declare conformance failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Timed-declare conformance failed: {str(e)}",
        )

    _set_cached(event_log_id, "timed_declare", result, cache_params)
    return TimedDeclareResponse(**result)
