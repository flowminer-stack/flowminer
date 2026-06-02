"""add mfa_secret and email_verified to users

Revision ID: a1b2c3d4e5f6
Revises: e7c727d8d5e9
Create Date: 2026-04-12
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "e7c727d8d5e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Idempotent guard — the regenerated baseline already defines these columns on
# the users table, so a fresh `alembic upgrade head` must skip them. Existing
# DBs stamped past this revision are unaffected.
def _has_column(table: str, name: str) -> bool:
    return any(c["name"] == name for c in inspect(op.get_bind()).get_columns(table))


def upgrade() -> None:
    if not _has_column("users", "mfa_secret"):
        op.add_column("users", sa.Column("mfa_secret", sa.String(), nullable=True))
    if not _has_column("users", "email_verified"):
        op.add_column(
            "users",
            sa.Column(
                "email_verified",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            ),
        )


def downgrade() -> None:
    if _has_column("users", "email_verified"):
        op.drop_column("users", "email_verified")
    if _has_column("users", "mfa_secret"):
        op.drop_column("users", "mfa_secret")
