"""Privacy and data anonymization configuration per project."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.models.privacy_config import PrivacyConfig
from app.api.deps import get_current_active_user, assert_project_access

router = APIRouter()


class PrivacyConfigUpdate(BaseModel):
    anonymize_resources: bool | None = None
    anonymize_case_ids: bool | None = None
    masked_columns: list[str] | None = None
    viewer_sees_raw: bool | None = None
    analyst_sees_raw: bool | None = None


def _to_response(c: PrivacyConfig) -> dict:
    return {
        "id": str(c.id),
        "project_id": str(c.project_id),
        "anonymize_resources": c.anonymize_resources,
        "anonymize_case_ids": c.anonymize_case_ids,
        "masked_columns": c.masked_columns or [],
        "viewer_sees_raw": c.viewer_sees_raw,
        "analyst_sees_raw": c.analyst_sees_raw,
        "updated_at": str(c.updated_at) if c.updated_at else "",
    }


@router.get("/{project_id}")
async def get_privacy_config(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(project_id, db, current_user)
    result = await db.execute(select(PrivacyConfig).where(PrivacyConfig.project_id == project_id))
    config = result.scalar_one_or_none()
    if not config:
        # Return defaults
        return {
            "project_id": str(project_id),
            "anonymize_resources": False,
            "anonymize_case_ids": False,
            "masked_columns": [],
            "viewer_sees_raw": True,
            "analyst_sees_raw": True,
        }
    return _to_response(config)


@router.put("/{project_id}")
async def update_privacy_config(
    project_id: UUID,
    body: PrivacyConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    # Verify project access first (apply same 404-for-unauthorized rule)
    await assert_project_access(project_id, db, current_user)
    # Only admins can change privacy settings
    if hasattr(current_user, 'role') and current_user.role and current_user.role.value != 'admin':
        raise HTTPException(status_code=403, detail="Only admins can modify privacy settings")

    result = await db.execute(select(PrivacyConfig).where(PrivacyConfig.project_id == project_id))
    config = result.scalar_one_or_none()

    if not config:
        config = PrivacyConfig(project_id=project_id, created_by=current_user.id)
        db.add(config)

    for field, val in body.model_dump(exclude_none=True).items():
        setattr(config, field, val)

    await db.commit()
    await db.refresh(config)
    return _to_response(config)
