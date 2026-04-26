"""baseline — create all tables from the current ORM metadata

Why this isn't a vanilla autogen:
  FlowMiner's schema was historically created by ``Base.metadata.create_all``
  at startup, so there's no point writing out every CREATE TABLE by hand.
  This baseline simply asks the metadata to create whatever the model
  classes declare right now. Future revisions will be normal autogen diffs.

On an existing database that already has the tables, run
``alembic stamp head`` instead of ``upgrade`` so this migration is recorded
as applied without re-running it.

Revision ID: 252a7b6ad654
Revises:
Create Date: 2026-04-12
"""

from typing import Sequence, Union

from alembic import op

# Importing the Base + models registers every table on Base.metadata.
from app.database import Base  # noqa: F401
import app.models  # noqa: F401,E402

# revision identifiers, used by Alembic.
revision: str = "252a7b6ad654"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
