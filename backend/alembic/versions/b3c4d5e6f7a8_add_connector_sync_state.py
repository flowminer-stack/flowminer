"""add connectors.sync_state

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-06-05 11:00:00.000000

"""
from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON


revision = "b3c4d5e6f7a8"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # [idempotent-guard] baseline create_all already builds this on fresh DBs.
    cols = {c["name"] for c in inspect(op.get_bind()).get_columns("connectors")}
    if "sync_state" in cols:
        return
    op.add_column("connectors", sa.Column("sync_state", JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("connectors", "sync_state")
