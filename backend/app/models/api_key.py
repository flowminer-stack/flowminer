"""API keys — long-lived bearer tokens for SDK / CI / automation use.

Design notes:
  - The raw key is shown to the user exactly once (on creation). We store
    only a SHA-256 hash of the key plus a short prefix (for display).
  - Keys inherit the creator's role — the SDK acts as the user who issued
    the key. This matches how `authz` decisions are made everywhere else.
  - Keys can be revoked by setting ``revoked_at``. We don't hard-delete so
    the audit log retains a handle to historical requests.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String, nullable=False)
    # SHA-256 hex digest of the raw key. The raw key is never stored.
    key_hash = Column(String, nullable=False, unique=True, index=True)
    # First 8 characters of the raw key, shown in the UI so users can
    # identify which key they're looking at without ever re-revealing it.
    key_prefix = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
