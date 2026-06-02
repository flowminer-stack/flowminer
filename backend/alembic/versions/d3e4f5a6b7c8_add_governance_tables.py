"""add governance, capability, log_version tables

Revision ID: d3e4f5a6b7c8
Revises: e5f6a7b8c9d0
Create Date: 2026-04-13
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # [idempotent-guard] baseline create_all already builds this on fresh DBs; skip if present.
    if inspect(op.get_bind()).has_table("governance_entries"):
        return
    # Use raw SQL for the enum so we can make it idempotent — native
    # sa.Enum() is notoriously painful across repeated runs because
    # it emits CREATE TYPE without an IF NOT EXISTS guard. Postgres
    # needs a DO-block for that.
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            DO $$ BEGIN
                CREATE TYPE governancestatus AS ENUM
                    ('draft', 'review', 'approved', 'published', 'retired');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
            """
        )
    )
    gov_status = postgresql.ENUM(
        "draft", "review", "approved", "published", "retired",
        name="governancestatus",
        create_type=False,
    )

    op.create_table(
        "governance_entries",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("event_log_id", sa.UUID(), nullable=True),
        sa.Column("version", sa.String(), nullable=False, server_default="1.0"),
        sa.Column("status", gov_status, nullable=False, server_default="draft"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["event_log_id"], ["event_logs.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "governance_transitions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("entry_id", sa.UUID(), nullable=False),
        sa.Column("from_status", gov_status, nullable=True),
        sa.Column("to_status", gov_status, nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"], ["governance_entries.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "capabilities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("parent_id", sa.UUID(), nullable=True),
        sa.Column(
            "linked_event_log_ids",
            sa.JSON(),
            nullable=False,
            server_default="[]",
        ),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["capabilities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "log_versions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("event_log_id", sa.UUID(), nullable=False),
        sa.Column("parent_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("filter_payload", sa.JSON(), nullable=True),
        sa.Column("case_count", sa.String(), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["event_log_id"], ["event_logs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["log_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("log_versions")
    op.drop_table("capabilities")
    op.drop_table("governance_transitions")
    op.drop_table("governance_entries")
    sa.Enum(name="governancestatus").drop(op.get_bind(), checkfirst=True)
