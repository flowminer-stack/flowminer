"""add user activation token columns

Supports bootstrap-admin-from-env + POST /auth/activate (managed-cloud §9 / OSS
self-host operators). DDL only — no data inserts.

Revision ID: f7a8b9c0d1e2
Revises: c4d5e6f7a8b9
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa

revision = "f7a8b9c0d1e2"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "activation_token_hash" not in cols:
        op.add_column("users", sa.Column("activation_token_hash", sa.String(), nullable=True))
        op.create_index("ix_users_activation_token_hash", "users", ["activation_token_hash"])
    if "activation_token_expires_at" not in cols:
        op.add_column(
            "users",
            sa.Column("activation_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_index("ix_users_activation_token_hash", table_name="users")
    op.drop_column("users", "activation_token_expires_at")
    op.drop_column("users", "activation_token_hash")
