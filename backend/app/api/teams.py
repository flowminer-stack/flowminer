"""Team management: CRUD endpoints + member invite flow.

Teams already exist as an ORM model but never had endpoints. Without this,
team-based authorization (the ``user.team_id`` path in
``_user_can_access_project``) can only be exercised by direct DB edits. With
this, admins can create teams, list them, add/remove members, and transfer
members between teams.

Non-admins can read the teams they belong to.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user, require_admin
from app.database import get_db
from app.models import Team, User, UserRole

router = APIRouter()


class TeamCreate(BaseModel):
    name: str


class TeamUpdate(BaseModel):
    name: str


class TeamMemberAdd(BaseModel):
    email: EmailStr


def _team_response(team: Team, member_count: int = 0) -> dict:
    return {
        "id": str(team.id),
        "name": team.name,
        "created_at": str(team.created_at) if team.created_at else None,
        "member_count": member_count,
    }


@router.get("")
async def list_teams(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List teams.

    - Admins see all teams
    - Other users see only the team they belong to (if any)
    """
    if current_user.role == UserRole.admin:
        result = await db.execute(
            select(Team).order_by(Team.created_at.desc()).limit(limit).offset(offset)
        )
        teams = result.scalars().all()
    elif current_user.team_id is not None:
        result = await db.execute(select(Team).where(Team.id == current_user.team_id))
        teams = result.scalars().all()
    else:
        teams = []

    # Member counts in a single query
    from sqlalchemy import func

    counts: dict[UUID, int] = {}
    if teams:
        count_rows = await db.execute(
            select(User.team_id, func.count(User.id))
            .where(User.team_id.in_([t.id for t in teams]))
            .group_by(User.team_id)
        )
        counts = {tid: n for tid, n in count_rows.all()}

    return [_team_response(t, counts.get(t.id, 0)) for t in teams]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_team(
    body: TeamCreate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    team = Team(name=body.name)
    db.add(team)
    await db.commit()
    await db.refresh(team)
    return _team_response(team, member_count=0)


@router.put("/{team_id}")
async def update_team(
    team_id: UUID,
    body: TeamUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    team = await db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    team.name = body.name
    await db.commit()
    await db.refresh(team)
    return _team_response(team)


@router.delete("/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_team(
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    team = await db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")

    # Un-assign any members before deleting so we don't cascade-delete users
    members_result = await db.execute(select(User).where(User.team_id == team_id))
    for member in members_result.scalars().all():
        member.team_id = None
    await db.delete(team)
    await db.commit()


@router.get("/{team_id}/members")
async def list_members(
    team_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    if current_user.role != UserRole.admin and current_user.team_id != team_id:
        raise HTTPException(status_code=404, detail="Team not found")
    result = await db.execute(select(User).where(User.team_id == team_id))
    members = result.scalars().all()
    return [
        {"id": str(u.id), "email": u.email, "full_name": u.full_name, "role": u.role.value if hasattr(u.role, "value") else str(u.role)}
        for u in members
    ]


@router.post("/{team_id}/members")
async def add_member(
    team_id: UUID,
    body: TeamMemberAdd,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    team = await db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail=f"No user with email {body.email}")
    user.team_id = team_id
    await db.commit()
    return {"status": "added", "user_id": str(user.id), "team_id": str(team_id)}


@router.delete("/{team_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    team_id: UUID,
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    user = await db.get(User, user_id)
    if user is None or user.team_id != team_id:
        raise HTTPException(status_code=404, detail="User is not a member of this team")
    user.team_id = None
    await db.commit()
