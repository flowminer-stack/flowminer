"""Bootstrap the first admin from environment variables.

Public-safe, useful to self-hosters: instead of "register then promote via SQL",
an operator (or the managed-cloud control plane) sets
``FLOWMINER_BOOTSTRAP_ADMIN_EMAIL`` + ``FLOWMINER_BOOTSTRAP_TOKEN_HASH`` and the
app creates that admin in a *pending* state on first boot. The raw activation
token lives only with whoever set the hash; they email the ``/activate?token=…``
link. Idempotent and modelled on ``demo_seeder`` — never logs the hash.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import User, UserRole

logger = logging.getLogger(__name__)

# Unusable password hash — login is impossible until /activate sets a real one.
_PENDING_PLACEHOLDER = "!pending-activation!"


async def bootstrap_admin_from_env(db: AsyncSession) -> None:
    """Create the bootstrap admin if configured and no admin exists yet.

    No-ops (logging at INFO) when:
      * the env vars aren't both set, or
      * any admin user already exists, or
      * a user with the bootstrap email already exists.
    """
    email = (settings.BOOTSTRAP_ADMIN_EMAIL or "").strip().lower()
    token_hash = (settings.BOOTSTRAP_TOKEN_HASH or "").strip()
    if not email or not token_hash:
        return

    admin_exists = (
        await db.execute(
            select(func.count()).select_from(User).where(User.role == UserRole.admin)
        )
    ).scalar() or 0
    if admin_exists:
        logger.info("bootstrap-admin: an admin already exists — skipping")
        return

    existing = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        logger.info("bootstrap-admin: a user with the bootstrap email already exists — skipping")
        return

    user = User(
        email=email,
        password_hash=_PENDING_PLACEHOLDER,
        full_name=email.split("@", 1)[0] or "Administrator",
        role=UserRole.admin,
        is_active=False,
        email_verified=False,
        activation_token_hash=token_hash,
        activation_token_expires_at=datetime.now(timezone.utc)
        + timedelta(hours=settings.BOOTSTRAP_TOKEN_EXPIRES_HOURS),
    )
    db.add(user)
    await db.commit()
    # Deliberately do NOT log the token hash.
    logger.info("bootstrap-admin: created pending admin %s (awaiting activation)", email)
