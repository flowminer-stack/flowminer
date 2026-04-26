"""Task mining — desktop-level event capture and pattern discovery.

The workflow:
  1. A lightweight desktop agent (out of scope for this repo, but
     documented) captures window/application events on the user's
     machine and POSTs them to ``/api/v1/task-mining/events``.
  2. Events are stored in ``task_events``, keyed by a ``TaskRecording``.
  3. Periodically, the ``mine_task_patterns`` job groups similar
     sequences into candidate "tasks" stored in ``task_patterns``.
  4. The frontend task-mining page shows both the raw recordings and
     the discovered patterns.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.sql import func

from app.database import Base


class TaskRecording(Base):
    __tablename__ = "task_recordings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    agent_version = Column(String, nullable=True)
    hostname = Column(String, nullable=True)
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    ended_at = Column(DateTime(timezone=True), nullable=True)
    event_count = Column(Integer, default=0)
    notes = Column(Text, nullable=True)


class TaskEvent(Base):
    __tablename__ = "task_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id = Column(
        UUID(as_uuid=True),
        ForeignKey("task_recordings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Event timestamp on the capturing machine (not server time).
    ts = Column(DateTime(timezone=True), nullable=False, index=True)
    # What kind of event — "window_focus", "key", "click", "copy", "paste",
    # "app_launch", "url_visit", "file_open", "clipboard", ...
    event_type = Column(String, nullable=False)
    application = Column(String, nullable=True)  # chrome.exe, Excel, ...
    window_title = Column(String, nullable=True)
    url = Column(String, nullable=True)
    # Structured payload — varies by event_type
    details = Column(JSON, nullable=True)


class TaskPattern(Base):
    __tablename__ = "task_patterns"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    # Canonical sequence (list of app/event descriptors) stored as JSON
    sequence = Column(JSON, nullable=False)
    frequency = Column(Integer, default=0)
    avg_duration_sec = Column(Integer, default=0)
    unique_users = Column(Integer, default=0)
    # A 0-1 "automatable" score the miner assigns based on how
    # deterministic the sequence is (low branching = high score).
    automatable_score = Column(Integer, default=0)
    # Example recording ids where this pattern was found
    sample_recording_ids = Column(JSON, default=[])
    discovered_at = Column(DateTime(timezone=True), server_default=func.now())
