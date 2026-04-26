"""Task mining API — capture desktop events, mine patterns, expose them.

Endpoints:
    POST /task-mining/recordings       — Start a new recording (returns id)
    POST /task-mining/recordings/{id}/events  — Ingest a batch of events
    POST /task-mining/recordings/{id}/end     — Mark a recording complete
    GET  /task-mining/recordings       — List recordings in a project
    POST /task-mining/mine              — Run the pattern miner on a project
    GET  /task-mining/patterns          — List discovered patterns
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    assert_project_access,
    get_current_active_user,
    get_owned_project,
)
from app.database import get_db
from app.models import Project, User
from app.models.task_mining import TaskEvent, TaskPattern, TaskRecording
from app.services.task_mining import mine_patterns

router = APIRouter()


class RecordingCreate(BaseModel):
    project_id: UUID
    agent_version: str | None = None
    hostname: str | None = None
    notes: str | None = None


class EventBatch(BaseModel):
    events: list[dict]


@router.post("/recordings", status_code=status.HTTP_201_CREATED)
async def create_recording(
    body: RecordingCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    rec = TaskRecording(
        project_id=body.project_id,
        user_id=current_user.id,
        agent_version=body.agent_version,
        hostname=body.hostname,
        notes=body.notes,
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return {
        "id": str(rec.id),
        "project_id": str(rec.project_id),
        "started_at": str(rec.started_at) if rec.started_at else None,
    }


@router.post("/recordings/{recording_id}/events")
async def ingest_events(
    recording_id: UUID,
    body: EventBatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Ingest a batch of desktop events. Call repeatedly from the agent.

    The batch is capped at 5000 events per call to keep request sizes
    reasonable. Each event must have ``ts`` and ``event_type``; all other
    fields (application, window_title, url, details) are optional.
    """
    if not body.events:
        return {"ingested": 0}
    if len(body.events) > 5000:
        raise HTTPException(status_code=400, detail="Maximum 5000 events per batch")

    # Verify the recording belongs to a project the user can access
    result = await db.execute(select(TaskRecording).where(TaskRecording.id == recording_id))
    rec = result.scalar_one_or_none()
    if rec is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    await assert_project_access(rec.project_id, db, current_user)

    ingested = 0
    for ev in body.events:
        ts = ev.get("ts")
        if isinstance(ts, str):
            try:
                ts_parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                continue
        elif isinstance(ts, (int, float)):
            ts_parsed = datetime.fromtimestamp(ts, tz=timezone.utc)
        else:
            continue
        db.add(
            TaskEvent(
                recording_id=recording_id,
                ts=ts_parsed,
                event_type=str(ev.get("event_type", "unknown"))[:64],
                application=(ev.get("application") or None),
                window_title=(ev.get("window_title") or None),
                url=(ev.get("url") or None),
                details=ev.get("details"),
            )
        )
        ingested += 1

    rec.event_count = (rec.event_count or 0) + ingested
    await db.commit()
    return {"ingested": ingested, "total_on_recording": rec.event_count}


@router.post("/recordings/{recording_id}/end")
async def end_recording(
    recording_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    result = await db.execute(select(TaskRecording).where(TaskRecording.id == recording_id))
    rec = result.scalar_one_or_none()
    if rec is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    await assert_project_access(rec.project_id, db, current_user)
    rec.ended_at = datetime.now(timezone.utc)
    await db.commit()
    return {"id": str(rec.id), "ended_at": str(rec.ended_at)}


@router.get("/recordings")
async def list_recordings(
    project: Project = Depends(get_owned_project),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(TaskRecording)
        .where(TaskRecording.project_id == project.id)
        .order_by(TaskRecording.started_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [
        {
            "id": str(r.id),
            "agent_version": r.agent_version,
            "hostname": r.hostname,
            "started_at": str(r.started_at) if r.started_at else None,
            "ended_at": str(r.ended_at) if r.ended_at else None,
            "event_count": r.event_count or 0,
        }
        for r in result.scalars().all()
    ]


class MineRequest(BaseModel):
    project_id: UUID
    min_frequency: int = 3
    min_sequence_length: int = 3
    max_sequence_length: int = 8


@router.post("/mine")
async def mine(
    body: MineRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run the pattern miner across every recording in the project.

    Deletes old patterns for the project and writes the newly mined set.
    The miner scales to ~100k events on a single worker; beyond that
    we'd want a Celery background task.
    """
    await assert_project_access(body.project_id, db, current_user)

    # Pull all events for recordings in this project
    rec_ids = (
        await db.execute(
            select(TaskRecording.id).where(TaskRecording.project_id == body.project_id)
        )
    ).scalars().all()
    if not rec_ids:
        return {"patterns": 0, "message": "No recordings to mine"}

    events = (
        await db.execute(
            select(TaskEvent).where(TaskEvent.recording_id.in_(rec_ids)).order_by(TaskEvent.ts)
        )
    ).scalars().all()
    events_dicts = [
        {
            "ts": e.ts,
            "event_type": e.event_type,
            "application": e.application,
            "recording_id": e.recording_id,
            "user_id": None,
        }
        for e in events
    ]

    import asyncio as _asyncio

    patterns = await _asyncio.to_thread(
        mine_patterns,
        events_dicts,
        min_sequence_length=body.min_sequence_length,
        max_sequence_length=body.max_sequence_length,
        min_frequency=body.min_frequency,
    )

    # Replace existing patterns for this project
    existing = (
        await db.execute(select(TaskPattern).where(TaskPattern.project_id == body.project_id))
    ).scalars().all()
    for p in existing:
        await db.delete(p)

    for i, p in enumerate(patterns[:200]):
        name = " → ".join(step[0] for step in p["sequence"])[:120]
        db.add(
            TaskPattern(
                project_id=body.project_id,
                name=name or f"Pattern {i+1}",
                sequence=p["sequence"],
                frequency=p["frequency"],
                avg_duration_sec=p["avg_duration_sec"],
                unique_users=p["unique_users"],
                automatable_score=int(p["automatable_score"] * 100),
                sample_recording_ids=p["sample_recording_ids"],
            )
        )

    await db.commit()
    return {"patterns": len(patterns), "stored": min(200, len(patterns))}


@router.get("/patterns")
async def list_patterns(
    project: Project = Depends(get_owned_project),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(TaskPattern)
        .where(TaskPattern.project_id == project.id)
        .order_by(TaskPattern.frequency.desc())
        .limit(limit)
        .offset(offset)
    )
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "sequence": p.sequence,
            "frequency": p.frequency,
            "avg_duration_sec": p.avg_duration_sec,
            "unique_users": p.unique_users,
            "automatable_score": (p.automatable_score or 0) / 100,
            "discovered_at": str(p.discovered_at) if p.discovered_at else None,
        }
        for p in result.scalars().all()
    ]


# ─── Cross-link: task patterns ↔ process activities ────────────────────────

class CrossLinkRequest(BaseModel):
    project_id: UUID
    event_log_id: UUID
    min_similarity: float = 0.5


@router.post("/cross-link")
async def cross_link_patterns_to_process(
    body: CrossLinkRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Match each task pattern to the process activities it most resembles.

    For every task pattern in the project, compute string similarity
    between each canonical step (``app::event_type``) and every unique
    activity name in the referenced event log. Returns, per pattern, the
    top 3 best-matching activities with similarity scores.

    This is the feature nobody in the market ships — the join between
    desktop task capture and discovered process activities. It makes
    task mining actually actionable: "this 6-step click sequence is
    what 'Approve invoice' actually looks like in practice."
    """
    from difflib import SequenceMatcher
    from app.models import EventLog
    from app.services.ingestion import ACTIVITY_COL
    from app.api.mining import _load_event_log_and_df, _assert_event_log_access

    await assert_project_access(body.project_id, db, current_user)
    await _assert_event_log_access(body.event_log_id, db, current_user)

    # Belt-and-braces: ensure the event log belongs to the same project
    el_row = (
        await db.execute(select(EventLog).where(EventLog.id == body.event_log_id))
    ).scalar_one_or_none()
    if el_row is None:
        raise HTTPException(status_code=404, detail="Event log not found")
    if el_row.project_id != body.project_id:
        raise HTTPException(
            status_code=400,
            detail="Event log does not belong to the specified project",
        )

    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)
    if ACTIVITY_COL not in df.columns:
        raise HTTPException(
            status_code=400,
            detail="Event log has no activity column — cannot cross-link",
        )

    activities = sorted({str(a) for a in df[ACTIVITY_COL].dropna().unique().tolist()})
    if not activities:
        return {"cross_links": [], "activities_considered": 0, "patterns_considered": 0}

    patterns = (
        await db.execute(
            select(TaskPattern)
            .where(TaskPattern.project_id == body.project_id)
            .order_by(TaskPattern.frequency.desc())
        )
    ).scalars().all()

    def _canonical(step) -> str:
        """Turn a [app, event_type] step into a human-readable probe."""
        if isinstance(step, (list, tuple)) and len(step) >= 2:
            app = str(step[0] or "").lower().replace("_", " ")
            ev = str(step[1] or "").lower().replace("_", " ")
            # Drop common noise tokens
            for junk in ("click", "key press", "key release", "text input", "mouse down", "mouse up"):
                ev = ev.replace(junk, "").strip()
            return f"{app} {ev}".strip()
        return str(step).lower()

    def _score(probe: str, activity: str) -> float:
        # SequenceMatcher is O(n*m) but activities are short — fine at
        # the scales we care about (a few hundred activities × a few
        # hundred steps). Takes ~50ms for 500×500.
        if not probe or not activity:
            return 0.0
        return SequenceMatcher(None, probe, activity.lower()).ratio()

    cross_links = []
    for p in patterns:
        sequence = p.sequence or []
        if not sequence:
            continue

        # Score each step against every activity and keep the best hit
        # per step. Then roll those up into a pattern-level match.
        per_step_best: list[tuple[str, str, float]] = []
        activity_scores: dict[str, float] = {}
        for step in sequence:
            probe = _canonical(step)
            best_activity = None
            best_score = 0.0
            for activity in activities:
                s = _score(probe, activity)
                if s > best_score:
                    best_score = s
                    best_activity = activity
            if best_activity is not None:
                per_step_best.append((probe, best_activity, best_score))
                # Accumulate per-activity scores so the top roll-up
                # reflects coverage, not just one lucky match.
                activity_scores[best_activity] = activity_scores.get(best_activity, 0.0) + best_score

        if not per_step_best:
            continue

        # Pattern-level top-3 activities by aggregate score
        top_activities = sorted(
            activity_scores.items(), key=lambda x: -x[1]
        )[:3]
        filtered = [
            {"activity": act, "score": round(score / len(sequence), 3)}
            for act, score in top_activities
            if (score / len(sequence)) >= body.min_similarity
        ]

        overall = (
            sum(s for _, _, s in per_step_best) / len(per_step_best)
            if per_step_best
            else 0.0
        )

        cross_links.append({
            "pattern_id": str(p.id),
            "pattern_name": p.name,
            "frequency": p.frequency,
            "automatable_score": (p.automatable_score or 0) / 100,
            "step_count": len(sequence),
            "overall_similarity": round(overall, 3),
            "top_activities": filtered,
            "per_step": [
                {"probe": probe, "best_match": act, "score": round(score, 3)}
                for probe, act, score in per_step_best[:8]
            ],
        })

    return {
        "cross_links": cross_links,
        "activities_considered": len(activities),
        "patterns_considered": len(patterns),
    }
