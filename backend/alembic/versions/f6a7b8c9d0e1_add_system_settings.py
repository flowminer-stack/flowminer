"""add system_settings table

Revision ID: f6a7b8c9d0e1
Revises: d3e4f5a6b7c8
Create Date: 2026-04-14 14:00:00.000000

"""
from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "f6a7b8c9d0e1"
down_revision = "d3e4f5a6b7c8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # [idempotent-guard] baseline create_all already builds this on fresh DBs; skip if present.
    if inspect(op.get_bind()).has_table("system_settings"):
        return
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(length=128), primary_key=True),
        sa.Column("value_encrypted", sa.Text(), nullable=True),
        sa.Column(
            "updated_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
    )


def downgrade() -> None:
    op.drop_table("system_settings")
