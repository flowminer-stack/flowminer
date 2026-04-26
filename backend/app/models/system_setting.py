"""Single-row-per-key system settings table.

This is an intentionally small key/value table for things that:

* Need to survive restarts (unlike in-memory caches).
* Are cluster-wide / app-wide (unlike per-user settings).
* Are sensitive (values are Fernet-encrypted at rest).

The primary use today is the LLM provider configuration: the admin
sets an OpenRouter / Anthropic / OpenAI key from the Settings page
and it's stored here instead of burning it into ``.env``.
"""

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database import Base


class SystemSetting(Base):
    __tablename__ = "system_settings"

    # String primary key so we can write readable keys like
    # "llm.openrouter.api_key" rather than needing a separate
    # enum or id mapping.
    key = Column(String(128), primary_key=True)

    # Fernet-encrypted JSON payload. Use ``app.services.secret_box``
    # to read/write this column — never store plaintext credentials
    # here, even in development.
    value_encrypted = Column(Text, nullable=True)

    # Metadata — which admin last touched this key and when. Useful
    # for the audit log and for a "last updated" indicator in the UI.
    updated_by = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
    )
