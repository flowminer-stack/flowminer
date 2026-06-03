"""
FastAPI dependency injection functions for authentication, authorization,
and JWT token management.
"""

import uuid
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User, UserRole
from app.services.infra.token_revocation import is_token_revoked

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def create_access_token(data: dict) -> str:
    """
    Create a signed JWT access token with an expiration claim.

    Every issued token gets a unique ``jti`` so the revocation list in
    Redis can target it individually (logout / admin force-invalidate).

    Args:
        data: Payload dictionary. Must include a "sub" key with the user identifier.

    Returns:
        Encoded JWT string.
    """
    to_encode = data.copy()
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({
        "exp": expire,
        "iat": now,
        "jti": uuid.uuid4().hex,
    })
    encoded_jwt = jwt.encode(
        to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM
    )
    return encoded_jwt


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Decode the bearer token and retrieve the corresponding user.

    Accepts two token shapes:
      1. A JWT access token issued by ``/auth/login`` (sub = user id)
      2. An API key prefixed with ``fmk_`` — looked up via SHA-256 hash
         in the ``api_keys`` table. The matching key's owner is returned
         and ``last_used_at`` is bumped.

    Raises HTTP 401 if neither path resolves to an active user.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    # ── API key path ────────────────────────────────────────────────────
    if token.startswith("fmk_"):
        import hashlib
        from datetime import datetime, timezone

        from app.models import ApiKey

        key_hash = hashlib.sha256(token.encode()).hexdigest()
        result = await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        api_key = result.scalar_one_or_none()
        if api_key is None or api_key.revoked_at is not None:
            raise credentials_exception
        api_key.last_used_at = datetime.now(timezone.utc)
        user_result = await db.execute(select(User).where(User.id == api_key.user_id))
        user = user_result.scalar_one_or_none()
        if user is None or not user.is_active:
            raise credentials_exception
        await db.commit()
        return user

    # ── JWT path ────────────────────────────────────────────────────────
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id_str: str | None = payload.get("sub")
        if user_id_str is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Reject any token that's on the revocation blocklist (logout /
    # admin force-invalidate). Password-reset and email-verify tokens
    # use the SECRET_KEY too but carry a `type` claim — they are
    # explicitly rejected here so a stolen reset token cannot be used
    # to authenticate against protected routes.
    if payload.get("type") is not None:
        raise credentials_exception
    jti = payload.get("jti")
    if jti and is_token_revoked(jti):
        raise credentials_exception

    try:
        user_id = UUID(user_id_str)
    except (ValueError, TypeError):
        raise credentials_exception

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None:
        raise credentials_exception

    return user


async def get_current_active_user(
    user: User = Depends(get_current_user),
) -> User:
    """
    Ensure the authenticated user's account is active.
    Raises HTTP 403 if the user has been deactivated.
    """
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Inactive user account",
        )
    return user


async def require_admin(
    user: User = Depends(get_current_active_user),
) -> User:
    """
    Require the authenticated user to have the admin role.
    Raises HTTP 403 if the user is not an admin.
    """
    if user.role != UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return user


async def require_analyst(
    user: User = Depends(get_current_active_user),
) -> User:
    """
    Require the authenticated user to have admin or analyst role.
    Raises HTTP 403 if the user is a viewer.
    """
    if user.role not in (UserRole.admin, UserRole.analyst):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Analyst or admin privileges required",
        )
    return user


# ─── Row-level resource ownership helpers ─────────────────────────────────────
#
# Every resource endpoint that takes an id-in-the-path (projects, event logs,
# dashboards, alerts, ...) needs to enforce that the authenticated user is
# actually allowed to see it. Before these dependencies existed, any logged-in
# user could read / mutate any resource by guessing its UUID (classic IDOR).
#
# The rule:
#   - Admins can access everything.
#   - If the resource has a project, the user must be the project creator, or
#     belong to the project's team if the project has a team_id.
#   - If the resource has no project link (rare, e.g. global templates), admins
#     only.


def _user_can_access_project(user: User, project) -> bool:
    """Pure predicate — used by the dependencies below AND when filtering list
    queries so we only return rows the caller is actually allowed to see."""
    from app.models import Project  # local to avoid circular import at module load

    if not isinstance(project, Project):
        return False
    if user.role == UserRole.admin:
        return True
    if project.created_by == user.id:
        return True
    if project.team_id is not None and user.team_id is not None and user.team_id == project.team_id:
        return True
    return False


async def get_owned_project(
    project_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """Fetch a project by id and verify the caller is allowed to access it.

    Raises 404 if the row doesn't exist (we do NOT leak existence to
    unauthorized users) and 403 only if the row exists but the user can't
    see it — the admin role is the only case where this distinction matters.
    """
    from sqlalchemy import select
    from app.models import Project

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if not _user_can_access_project(user, project):
        # Pretend the resource doesn't exist so we don't reveal its existence.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


async def get_accessible_event_log(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """Fetch an event log and verify the caller has access to its parent project."""
    from sqlalchemy import select
    from app.models import EventLog, Project

    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
    project = proj_result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")

    return event_log


async def assert_project_access(
    project_id: UUID,
    db: AsyncSession,
    user: User,
) -> None:
    """Imperative helper for endpoints that accept a project_id in the body
    rather than the URL path. Mirrors get_owned_project's semantics."""
    from sqlalchemy import select
    from app.models import Project

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")


async def assert_event_log_access(
    event_log_id: UUID,
    db: AsyncSession,
    user: User,
):
    """Imperative helper for endpoints that accept an event_log_id in the body."""
    from sqlalchemy import select
    from app.models import EventLog, Project

    result = await db.execute(select(EventLog).where(EventLog.id == event_log_id))
    event_log = result.scalar_one_or_none()
    if event_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")
    proj_result = await db.execute(select(Project).where(Project.id == event_log.project_id))
    project = proj_result.scalar_one_or_none()
    if project is None or not _user_can_access_project(user, project):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event log not found")
    return event_log
