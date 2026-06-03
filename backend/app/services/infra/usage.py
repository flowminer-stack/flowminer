"""Usage recording helper. Call from any code path that consumes
a billable resource (LLM tokens, mining minutes, connector syncs).

Fire-and-forget — writes a UsageEvent row via the async session.
"""

from __future__ import annotations

import logging
from uuid import UUID

from app.database import async_session
from app.models import UsageEvent, User

logger = logging.getLogger(__name__)


async def record_usage(
    user: User | None,
    kind: str,
    quantity: float,
    resource_type: str | None = None,
    resource_id: str | None = None,
) -> None:
    """Record a usage event. Never raises — logs and swallows failures."""
    try:
        async with async_session() as session:
            event = UsageEvent(
                team_id=getattr(user, "team_id", None) if user is not None else None,
                user_id=getattr(user, "id", None) if user is not None else None,
                kind=kind,
                quantity=quantity,
                resource_type=resource_type,
                resource_id=resource_id,
            )
            session.add(event)
            await session.commit()
    except Exception as e:
        logger.debug("record_usage failed (%s): %s", kind, e)
