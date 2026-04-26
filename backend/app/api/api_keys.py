"""API key management — create, list, revoke.

Keys are returned in cleartext exactly once, on create. After that only
the ``key_prefix`` is ever shown. The SDK passes the raw key as a bearer
token and ``get_current_user`` hashes it to look up the record.
"""

import hashlib
import secrets
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.database import get_db
from app.models import ApiKey, User

router = APIRouter()


class ApiKeyCreate(BaseModel):
    name: str


def _generate_key() -> tuple[str, str, str]:
    """Return (raw_key, key_hash, key_prefix)."""
    raw = "fmk_" + secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    prefix = raw[:12]
    return raw, key_hash, prefix


@router.get("")
async def list_api_keys(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """List the current user's API keys. Raw keys are never included."""
    result = await db.execute(
        select(ApiKey)
        .where(ApiKey.user_id == current_user.id)
        .order_by(ApiKey.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    keys = result.scalars().all()
    return [
        {
            "id": str(k.id),
            "name": k.name,
            "key_prefix": k.key_prefix,
            "created_at": str(k.created_at) if k.created_at else None,
            "last_used_at": str(k.last_used_at) if k.last_used_at else None,
            "revoked_at": str(k.revoked_at) if k.revoked_at else None,
        }
        for k in keys
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_api_key(
    body: ApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Issue a new API key for the current user. Raw key returned ONCE."""
    raw, key_hash, prefix = _generate_key()
    api_key = ApiKey(
        user_id=current_user.id,
        name=body.name,
        key_hash=key_hash,
        key_prefix=prefix,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)
    return {
        "id": str(api_key.id),
        "name": api_key.name,
        "key": raw,
        "key_prefix": prefix,
        "created_at": str(api_key.created_at),
        "notice": "Save this key now — it will never be shown again.",
    }


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Revoke (soft-delete) an API key."""
    result = await db.execute(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id)
    )
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    api_key.revoked_at = datetime.now(timezone.utc)
    await db.commit()
