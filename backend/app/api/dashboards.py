"""
Dashboard router: CRUD operations and public sharing via share tokens.
"""

import uuid as uuid_mod
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Dashboard, User
from app.schemas.dashboard import DashboardCreate, DashboardResponse, DashboardUpdate
from app.api.deps import get_current_active_user, assert_project_access

router = APIRouter()


@router.get("", response_model=list[DashboardResponse])
async def list_dashboards(
    project_id: UUID | None = Query(default=None, description="Filter by project ID"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List dashboards, optionally filtered by project ID."""
    if project_id is not None:
        await assert_project_access(project_id, db, current_user)
    query = select(Dashboard)
    if project_id is not None:
        query = query.where(Dashboard.project_id == project_id)
    else:
        from app.models import Project
        from app.models import UserRole
        if current_user.role != UserRole.admin:
            accessible = select(Project.id).where(
                (Project.created_by == current_user.id)
                | (
                    (Project.team_id.is_not(None))
                    & (Project.team_id == current_user.team_id)
                )
            )
            query = query.where(Dashboard.project_id.in_(accessible))
    query = query.order_by(Dashboard.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    dashboards = result.scalars().all()
    return dashboards


@router.post("", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    body: DashboardCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new dashboard with a unique share token."""
    await assert_project_access(body.project_id, db, current_user)
    dashboard = Dashboard(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        created_by=current_user.id,
        share_token=uuid_mod.uuid4().hex,
    )
    db.add(dashboard)
    await db.commit()
    await db.refresh(dashboard)
    return dashboard


@router.get("/shared/{share_token}", response_model=DashboardResponse)
async def get_shared_dashboard(
    share_token: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Get a dashboard by its share token. No authentication required.
    This is the public sharing endpoint.
    """
    result = await db.execute(
        select(Dashboard).where(Dashboard.share_token == share_token)
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared dashboard not found",
        )

    if not dashboard.is_shared:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This dashboard is not currently shared",
        )

    return dashboard


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get a dashboard by ID."""
    result = await db.execute(
        select(Dashboard).where(Dashboard.id == dashboard_id)
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found"
        )
    await assert_project_access(dashboard.project_id, db, current_user)
    return dashboard


@router.put("/{dashboard_id}", response_model=DashboardResponse)
async def update_dashboard(
    dashboard_id: UUID,
    body: DashboardUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update a dashboard's name, description, layout, widgets, or sharing status."""
    result = await db.execute(
        select(Dashboard).where(Dashboard.id == dashboard_id)
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found"
        )
    await assert_project_access(dashboard.project_id, db, current_user)

    if body.name is not None:
        dashboard.name = body.name
    if body.description is not None:
        dashboard.description = body.description
    if body.layout is not None:
        dashboard.layout = body.layout
    if body.widgets is not None:
        dashboard.widgets = body.widgets
    if body.is_shared is not None:
        dashboard.is_shared = body.is_shared
        # Generate a new share token if enabling sharing and no token exists
        if body.is_shared and not dashboard.share_token:
            dashboard.share_token = uuid_mod.uuid4().hex

    await db.commit()
    await db.refresh(dashboard)
    return dashboard


@router.delete("/{dashboard_id}", status_code=status.HTTP_200_OK)
async def delete_dashboard(
    dashboard_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete a dashboard."""
    result = await db.execute(
        select(Dashboard).where(Dashboard.id == dashboard_id)
    )
    dashboard = result.scalar_one_or_none()
    if dashboard is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found"
        )
    await assert_project_access(dashboard.project_id, db, current_user)

    await db.delete(dashboard)
    await db.commit()

    return {"detail": "Dashboard deleted", "dashboard_id": str(dashboard_id)}
