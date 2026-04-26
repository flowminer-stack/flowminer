"""Project import / export manifest.

Exports a project's metadata, dashboards, alerts, KPIs, initiatives, and
action rules as a single JSON document. Event-log *files* are not embedded
— the manifest references them by checksum so the importer knows which
files to re-attach afterward.

Used for: migrating projects between instances, snapshotting demos, and
simple point-in-time backups.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_project_access, get_owned_project, get_current_active_user
from app.database import get_db
from app.models import (
    ActionRule,
    Alert,
    CustomKPI,
    Dashboard,
    EventLog,
    EventLogStatus,
    Initiative,
    LogType,
    Project,
    SourceType,
    User,
)

router = APIRouter()

_MANIFEST_VERSION = "1"


def _file_digest(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


@router.get("/{project_id}/export")
async def export_project(
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return a JSON manifest describing every child resource of a project."""
    async def _all(stmt):
        return (await db.execute(stmt)).scalars().all()

    event_logs = await _all(select(EventLog).where(EventLog.project_id == project.id))
    dashboards = await _all(select(Dashboard).where(Dashboard.project_id == project.id))
    alerts = await _all(select(Alert).where(Alert.project_id == project.id))
    kpis = await _all(select(CustomKPI).where(CustomKPI.project_id == project.id))
    initiatives = await _all(select(Initiative).where(Initiative.project_id == project.id))
    action_rules = await _all(select(ActionRule).where(ActionRule.project_id == project.id))

    return {
        "manifest_version": _MANIFEST_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "project": {
            "id": str(project.id),
            "name": project.name,
            "description": project.description,
            "created_at": str(project.created_at) if project.created_at else None,
        },
        "event_logs": [
            {
                "id": str(el.id),
                "name": el.name,
                "log_type": el.log_type if isinstance(el.log_type, str) else el.log_type.value,
                "source_type": el.source_type.value if hasattr(el.source_type, "value") else str(el.source_type),
                "case_id_column": el.case_id_column,
                "activity_column": el.activity_column,
                "timestamp_column": el.timestamp_column,
                "resource_column": el.resource_column,
                "cost_column": el.cost_column,
                "total_cases": el.total_cases,
                "total_events": el.total_events,
                "hidden": el.hidden,
                "file_sha256": _file_digest(el.file_path),
                "file_name_hint": os.path.basename(el.file_path) if el.file_path else None,
            }
            for el in event_logs
        ],
        "dashboards": [
            {
                "id": str(d.id),
                "name": d.name,
                "description": d.description,
                "layout": d.layout,
                "widgets": d.widgets,
                "is_shared": d.is_shared,
            }
            for d in dashboards
        ],
        "alerts": [
            {
                "id": str(a.id),
                "name": a.name,
                "description": a.description,
                "condition": a.condition.value if hasattr(a.condition, "value") else str(a.condition),
                "metric": getattr(a, "metric", None),
                "threshold": getattr(a, "threshold", None),
                "notification_channel": a.notification_channel.value if hasattr(a.notification_channel, "value") else str(a.notification_channel),
                "is_active": a.is_active,
            }
            for a in alerts
        ],
        "custom_kpis": [
            {
                "id": str(k.id),
                "name": k.name,
                "description": k.description,
                "metric": k.metric,
                "expression": k.expression,
                "filters": k.filters,
                "unit": k.unit,
                "target_value": k.target_value,
            }
            for k in kpis
        ],
        "initiatives": [
            {
                "id": str(i.id),
                "name": i.name,
                "description": i.description,
                "metric": i.metric,
                "unit": i.unit,
                "baseline_value": i.baseline_value,
                "target_value": i.target_value,
                "status": i.status,
            }
            for i in initiatives
        ],
        "action_rules": [
            {
                "id": str(r.id),
                "name": r.name,
                "description": r.description,
                "enabled": r.enabled,
                "condition": r.condition,
                "action": r.action,
            }
            for r in action_rules
        ],
    }


class ImportRequest(BaseModel):
    manifest: dict
    target_project_name: str | None = None


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_project(
    body: ImportRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> dict:
    """Create a new project from an exported manifest.

    Event log files are NOT imported — only the metadata. The caller is
    expected to re-upload the actual CSV/XES/Parquet files separately and
    match them by sha256 using ``event_logs[].file_sha256``.
    """
    manifest = body.manifest or {}
    if manifest.get("manifest_version") != _MANIFEST_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported manifest_version — expected '{_MANIFEST_VERSION}'",
        )

    src_project = manifest.get("project", {})
    project = Project(
        id=uuid4(),
        name=body.target_project_name or src_project.get("name", "Imported project"),
        description=src_project.get("description"),
        created_by=current_user.id,
    )
    db.add(project)
    await db.flush()

    # Minimal reconstruction of each child entity. Files are dropped —
    # the UI prompts the user to re-upload them and we match by checksum.
    stats = {
        "event_logs": 0,
        "dashboards": 0,
        "alerts": 0,
        "custom_kpis": 0,
        "initiatives": 0,
        "action_rules": 0,
    }

    for el_data in manifest.get("event_logs", []):
        event_log = EventLog(
            project_id=project.id,
            name=el_data.get("name", "imported"),
            file_path=None,
            source_type=SourceType.upload,
            log_type=(el_data.get("log_type") or "standard"),
            status=EventLogStatus.processing,
            case_id_column=el_data.get("case_id_column"),
            activity_column=el_data.get("activity_column"),
            timestamp_column=el_data.get("timestamp_column"),
            resource_column=el_data.get("resource_column"),
            cost_column=el_data.get("cost_column"),
            hidden=bool(el_data.get("hidden")),
        )
        db.add(event_log)
        stats["event_logs"] += 1

    for d in manifest.get("dashboards", []):
        db.add(Dashboard(
            project_id=project.id,
            name=d.get("name", "imported"),
            description=d.get("description"),
            layout=d.get("layout") or {},
            widgets=d.get("widgets") or [],
            is_shared=False,
            created_by=current_user.id,
        ))
        stats["dashboards"] += 1

    for k in manifest.get("custom_kpis", []):
        db.add(CustomKPI(
            project_id=project.id,
            name=k.get("name", "imported"),
            description=k.get("description"),
            metric=k.get("metric", "avg_case_duration"),
            expression=k.get("expression"),
            filters=k.get("filters"),
            unit=k.get("unit"),
            target_value=k.get("target_value"),
            created_by=current_user.id,
        ))
        stats["custom_kpis"] += 1

    for i in manifest.get("initiatives", []):
        db.add(Initiative(
            project_id=project.id,
            name=i.get("name", "imported"),
            description=i.get("description"),
            metric=i.get("metric", "avg_case_duration"),
            unit=i.get("unit"),
            baseline_value=i.get("baseline_value") or 0,
            target_value=i.get("target_value") or 0,
            status=i.get("status", "active"),
            created_by=current_user.id,
        ))
        stats["initiatives"] += 1

    for r in manifest.get("action_rules", []):
        db.add(ActionRule(
            project_id=project.id,
            name=r.get("name", "imported"),
            description=r.get("description"),
            enabled=bool(r.get("enabled", True)),
            condition=r.get("condition") or {},
            action=r.get("action") or {},
            created_by=current_user.id,
        ))
        stats["action_rules"] += 1

    await db.commit()
    return {
        "project_id": str(project.id),
        "imported": stats,
        "notice": "Event log files were not included in the manifest — re-upload them to attach.",
    }
