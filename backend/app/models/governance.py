"""Models for the Wave 3 governance / EA / log-version features.

Three small tables live here rather than in their own files because
they share the same lifecycle (ship together, all optional, none
strongly coupled to pre-existing models):

  - ``GovernanceEntry``: a discovered or authored process model that
    moves through draft → review → approved → published → retired.
    Approval events go in ``GovernanceTransition`` for audit.
  - ``Capability``: a node in the user's enterprise-architecture
    capability tree. Each node can link one or more event logs.
  - ``LogVersion``: a named snapshot of a filter set applied to an
    event log — think "Q3 after the process change" as a reusable
    derived log without the file overhead.
"""

from __future__ import annotations

import enum
import uuid

from sqlalchemy import Column, DateTime, Enum as SQLEnum, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class GovernanceStatus(str, enum.Enum):
    draft = "draft"
    review = "review"
    approved = "approved"
    published = "published"
    retired = "retired"


class GovernanceEntry(Base):
    __tablename__ = "governance_entries"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    # Optional link to the event log or discovered model this entry
    # represents. Nullable so users can track an authored process
    # that has no log yet.
    event_log_id = Column(
        UUID(as_uuid=True), ForeignKey("event_logs.id"), nullable=True
    )
    version = Column(String, nullable=False, default="1.0")
    status = Column(
        SQLEnum(GovernanceStatus), nullable=False, default=GovernanceStatus.draft
    )
    notes = Column(Text, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class GovernanceTransition(Base):
    """Every state change on a governance entry — immutable audit log."""

    __tablename__ = "governance_transitions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id = Column(
        UUID(as_uuid=True),
        ForeignKey("governance_entries.id", ondelete="CASCADE"),
        nullable=False,
    )
    from_status = Column(SQLEnum(GovernanceStatus), nullable=True)
    to_status = Column(SQLEnum(GovernanceStatus), nullable=False)
    actor_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    comment = Column(Text, nullable=True)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Capability(Base):
    """Node in the user's EA capability tree.

    ``parent_id`` defines the hierarchy; ``linked_event_log_ids``
    stores a JSON array of event log ids rolled up under this
    capability. The UI renders the tree grid and pulls per-cell KPIs
    by aggregating the linked logs' stats.
    """

    __tablename__ = "capabilities"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    parent_id = Column(
        UUID(as_uuid=True),
        ForeignKey("capabilities.id", ondelete="CASCADE"),
        nullable=True,
    )
    # JSON list of event_log UUIDs linked to this capability. Kept as
    # JSON (rather than a join table) because the lookup is one-shot
    # per page render and the list is tiny.
    linked_event_log_ids = Column(JSON, default=list, nullable=False)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class LogVersion(Base):
    """Named filter snapshot on an event log.

    Not a materialised derived log — just a stored filter expression
    plus metadata the UI uses to render a version history tree. When
    a user wants to branch from another version, we capture the
    ``parent_id`` so the tree can reconstruct lineage.
    """

    __tablename__ = "log_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_log_id = Column(
        UUID(as_uuid=True),
        ForeignKey("event_logs.id", ondelete="CASCADE"),
        nullable=False,
    )
    parent_id = Column(
        UUID(as_uuid=True),
        ForeignKey("log_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # Filter state that defines this version — stored as the same
    # JSON shape the frontend filterStore.serialise() produces so
    # round-tripping is trivial.
    filter_payload = Column(JSON, nullable=True)
    case_count = Column(String, nullable=True)  # rough snapshot
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
