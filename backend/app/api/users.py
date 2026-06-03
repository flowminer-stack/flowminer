"""
User management router: list, retrieve, update, and deactivate users.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User, UserRole
from app.schemas.user import PasswordChange, UserResponse, UserUpdate
from app.api.deps import get_current_active_user, require_admin
from app.services.infra.password_policy import assert_strong_password


# --- Admin-only request bodies ---

class UpdateRoleRequest(BaseModel):
    role: str  # "admin", "analyst", "viewer"


class UpdateStatusRequest(BaseModel):
    is_active: bool

router = APIRouter()


@router.get("/me", response_model=UserResponse)
async def get_me(
    current_user: User = Depends(get_current_active_user),
):
    """Return the currently authenticated user's profile.

    Convenience alias so the frontend doesn't need its own user id —
    used by the Settings page.
    """
    return current_user


@router.patch("/me", response_model=UserResponse)
async def update_me(
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update the current user's own profile (name + email).

    Role and is_active changes are rejected for self-service — those
    require admin via ``PUT /{id}/role`` and ``PUT /{id}/status``.
    """
    if body.full_name is not None:
        current_user.full_name = body.full_name

    if body.email is not None and body.email != current_user.email:
        existing = await db.execute(select(User).where(User.email == body.email))
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="An account with this email already exists",
            )
        current_user.email = body.email

    if body.role is not None or body.is_active is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Role and active-status changes require admin",
        )

    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/me/change-password")
async def change_my_password(
    body: PasswordChange,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Change the current user's password.

    Requires the current password for verification. The new password
    is bcrypt-hashed through the same CryptContext used at registration.
    """
    from app.api.auth import _hash_password, _verify_password

    if not _verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must differ from the current password",
        )

    assert_strong_password(
        body.new_password,
        hint_fields=(current_user.email, current_user.full_name),
    )
    current_user.password_hash = _hash_password(body.new_password)
    await db.commit()
    return {"detail": "Password updated successfully"}


@router.get("", response_model=list[UserResponse])
async def list_users(
    team_id: UUID | None = Query(default=None, description="Filter by team ID"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """List all users. Admin only. Optionally filter by team_id."""
    query = select(User)
    if team_id is not None:
        query = query.where(User.team_id == team_id)
    query = query.order_by(User.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(query)
    users = result.scalars().all()
    return users


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get a user by ID.

    Non-admins may only look up their own record — otherwise this
    endpoint would enumerate every user's email / role for anyone
    holding any JWT (IDOR, security audit finding).
    """
    is_admin = current_user.role == UserRole.admin
    if not is_admin and current_user.id != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only look up your own user record",
        )
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    return user


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: UUID,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Update a user. Admins can update any user. Non-admins can only update
    themselves and cannot change their own role.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    is_admin = current_user.role == UserRole.admin
    is_self = current_user.id == user.id

    if not is_admin and not is_self:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only update your own profile",
        )

    if body.full_name is not None:
        user.full_name = body.full_name

    if body.role is not None:
        if not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admins can change user roles",
            )
        try:
            user.role = UserRole(body.role)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid role: {body.role}. Must be one of: admin, analyst, viewer",
            )

    if body.is_active is not None:
        if not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admins can change active status",
            )
        user.is_active = body.is_active

    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_200_OK)
async def deactivate_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Deactivate a user account. Admin only."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    user.is_active = False
    await db.commit()

    return {"detail": "User deactivated", "user_id": str(user_id)}


@router.put("/{user_id}/role", response_model=UserResponse)
async def update_user_role(
    user_id: UUID,
    body: UpdateRoleRequest,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """
    Update a user's role. Admin only.
    Valid roles: admin, analyst, viewer.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    try:
        user.role = UserRole(body.role)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid role '{body.role}'. Must be one of: admin, analyst, viewer",
        )

    await db.commit()
    await db.refresh(user)
    return user


@router.put("/{user_id}/status", response_model=UserResponse)
async def toggle_user_status(
    user_id: UUID,
    body: UpdateStatusRequest,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """
    Activate or deactivate a user account. Admin only.
    Pass is_active=true to re-activate a deactivated account.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    user.is_active = body.is_active
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}/permanent", status_code=status.HTTP_200_OK)
async def delete_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """
    Permanently delete a user account from the database. Admin only.
    This is irreversible — use PUT /{user_id}/status to deactivate instead
    if you want to preserve the record.
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    await db.delete(user)
    await db.commit()

    return {"detail": "User permanently deleted", "user_id": str(user_id)}
