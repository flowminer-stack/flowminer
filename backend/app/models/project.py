import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id"), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    creator = relationship("User", back_populates="projects")
    event_logs = relationship(
        "EventLog", back_populates="project", cascade="all, delete-orphan"
    )
    dashboards = relationship(
        "Dashboard", back_populates="project", cascade="all, delete-orphan"
    )
    alerts = relationship(
        "Alert", back_populates="project", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Access-filter queries: created_by and team_id are both hot.
        Index("ix_projects_created_by", "created_by"),
        Index("ix_projects_team_id", "team_id"),
    )
