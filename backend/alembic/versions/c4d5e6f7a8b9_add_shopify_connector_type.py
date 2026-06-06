"""add shopify connector type

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-06-06 12:00:00.000000

"""
from alembic import op


revision = "c4d5e6f7a8b9"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None

# Postgres cannot ADD VALUE to an enum inside a transaction block.  Alembic
# runs migrations in autocommit by default only when ``transaction_per_migration``
# is False AND the driver is psycopg2 with isolation_level=AUTOCOMMIT.  The
# safest cross-driver pattern is to issue the DDL via a raw DBAPI connection
# outside of any transaction, which is what op.get_context().autocommit_block()
# provides in Alembic ≥1.7.
def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE connectortype ADD VALUE IF NOT EXISTS 'shopify'")


def downgrade() -> None:
    # Postgres does not support DROP VALUE from an enum; downgrade is a no-op.
    # To fully reverse: DROP + RECREATE the type without 'shopify', then
    # ALTER each column using the old type.  Not implemented here because it
    # would require migrating data and is not needed in practice.
    pass
