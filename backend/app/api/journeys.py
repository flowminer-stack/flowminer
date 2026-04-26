"""Journey Modeler API — customer/employee journey CRUD."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_project_access, get_current_active_user, get_owned_project
from app.database import get_db
from app.models import Journey, Project, User

router = APIRouter()


class JourneyStage(BaseModel):
    id: str
    label: str
    sentiment: int = 50  # 0-100
    touchpoints: list[str] = []
    widgets: list[dict] = []


class JourneyCreate(BaseModel):
    project_id: UUID
    name: str
    description: str | None = None
    journey_type: str = "customer"
    stages: list[JourneyStage] = []


class JourneyUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    stages: list[JourneyStage] | None = None


def _to_dict(j: Journey) -> dict:
    return {
        "id": str(j.id),
        "project_id": str(j.project_id),
        "name": j.name,
        "description": j.description,
        "journey_type": j.journey_type,
        "stages": j.stages or [],
        "created_at": str(j.created_at) if j.created_at else None,
        "updated_at": str(j.updated_at) if j.updated_at else None,
    }


@router.get("")
async def list_journeys(
    project: Project = Depends(get_owned_project),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Journey)
        .where(Journey.project_id == project.id)
        .order_by(Journey.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [_to_dict(j) for j in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_journey(
    body: JourneyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    await assert_project_access(body.project_id, db, current_user)
    j = Journey(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        journey_type=body.journey_type,
        stages=[s.model_dump() for s in body.stages],
        created_by=current_user.id,
    )
    db.add(j)
    await db.commit()
    await db.refresh(j)
    return _to_dict(j)


@router.get("/{journey_id}")
async def get_journey(
    journey_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    j = await db.get(Journey, journey_id)
    if not j:
        raise HTTPException(status_code=404, detail="Journey not found")
    await assert_project_access(j.project_id, db, current_user)
    return _to_dict(j)


@router.put("/{journey_id}")
async def update_journey(
    journey_id: UUID,
    body: JourneyUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    j = await db.get(Journey, journey_id)
    if not j:
        raise HTTPException(status_code=404, detail="Journey not found")
    await assert_project_access(j.project_id, db, current_user)
    if body.name is not None:
        j.name = body.name
    if body.description is not None:
        j.description = body.description
    if body.stages is not None:
        j.stages = [s.model_dump() for s in body.stages]
    await db.commit()
    await db.refresh(j)
    return _to_dict(j)


@router.delete("/{journey_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journey(
    journey_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    j = await db.get(Journey, journey_id)
    if not j:
        raise HTTPException(status_code=404, detail="Journey not found")
    await assert_project_access(j.project_id, db, current_user)
    await db.delete(j)
    await db.commit()
