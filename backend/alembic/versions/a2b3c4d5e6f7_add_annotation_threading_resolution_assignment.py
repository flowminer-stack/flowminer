"""add annotation threading, resolution, and assignment columns

Revision ID: a2b3c4d5e6f7
Revises: f6a7b8c9d0e1
Create Date: 2026-06-02 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # [idempotent-guard] baseline create_all already adds these columns on fresh DBs; skip if present.
    _insp = inspect(op.get_bind())
    if _insp.has_table("annotations") and any(c["name"] == "parent_id" for c in _insp.get_columns("annotations")):
        return
    # Self-referential FK for threaded replies
    op.add_column(
        "annotations",
        sa.Column("parent_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_annotations_parent_id",
        "annotations",
        "annotations",
        ["parent_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # Resolution tracking
    op.add_column(
        "annotations",
        sa.Column(
            "resolved",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.add_column(
        "annotations",
        sa.Column("resolved_by", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_annotations_resolved_by",
        "annotations",
        "users",
        ["resolved_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "annotations",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Assignment
    op.add_column(
        "annotations",
        sa.Column("assignee_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_annotations_assignee_id",
        "annotations",
        "users",
        ["assignee_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_annotations_assignee_id", "annotations", type_="foreignkey")
    op.drop_column("annotations", "assignee_id")

    op.drop_column("annotations", "resolved_at")
    op.drop_constraint("fk_annotations_resolved_by", "annotations", type_="foreignkey")
    op.drop_column("annotations", "resolved_by")
    op.drop_column("annotations", "resolved")

    op.drop_constraint("fk_annotations_parent_id", "annotations", type_="foreignkey")
    op.drop_column("annotations", "parent_id")
