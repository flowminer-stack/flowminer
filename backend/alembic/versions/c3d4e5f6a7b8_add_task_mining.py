"""add task mining tables

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-04-12
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "task_recordings",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("agent_version", sa.String(), nullable=True),
        sa.Column("hostname", sa.String(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("event_count", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_recordings_project_id", "task_recordings", ["project_id"])

    op.create_table(
        "task_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("recording_id", sa.UUID(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("application", sa.String(), nullable=True),
        sa.Column("window_title", sa.String(), nullable=True),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("details", postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(["recording_id"], ["task_recordings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_events_recording_id", "task_events", ["recording_id"])
    op.create_index("ix_task_events_ts", "task_events", ["ts"])

    op.create_table(
        "task_patterns",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("sequence", postgresql.JSON(astext_type=sa.Text()), nullable=False),
        sa.Column("frequency", sa.Integer(), nullable=True),
        sa.Column("avg_duration_sec", sa.Integer(), nullable=True),
        sa.Column("unique_users", sa.Integer(), nullable=True),
        sa.Column("automatable_score", sa.Integer(), nullable=True),
        sa.Column("sample_recording_ids", postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column("discovered_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_patterns_project_id", "task_patterns", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_task_patterns_project_id", table_name="task_patterns")
    op.drop_table("task_patterns")
    op.drop_index("ix_task_events_ts", table_name="task_events")
    op.drop_index("ix_task_events_recording_id", table_name="task_events")
    op.drop_table("task_events")
    op.drop_index("ix_task_recordings_project_id", table_name="task_recordings")
    op.drop_table("task_recordings")
