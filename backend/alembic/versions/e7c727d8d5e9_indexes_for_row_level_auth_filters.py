"""indexes for row-level auth filters

Revision ID: e7c727d8d5e9
Revises: c05b3a60914e
Create Date: 2026-04-12 10:03:19.192019

"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect

# revision identifiers, used by Alembic.
revision: str = "e7c727d8d5e9"
down_revision: Union[str, None] = "c05b3a60914e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Idempotent guards: the regenerated baseline already creates some of these
# objects (from the current ORM metadata), so a fresh `alembic upgrade head`
# must not fail on duplicates. DBs already stamped past this revision are
# unaffected — alembic never re-runs an applied migration.
def _has_index(table: str, name: str) -> bool:
    return any(ix["name"] == name for ix in inspect(op.get_bind()).get_indexes(table))


def upgrade() -> None:
    if not _has_index("event_logs", "ix_event_logs_project_hidden_created"):
        op.create_index(
            "ix_event_logs_project_hidden_created",
            "event_logs",
            ["project_id", "hidden", "created_at"],
            unique=False,
        )
    if not _has_index("projects", "ix_projects_created_by"):
        op.create_index("ix_projects_created_by", "projects", ["created_by"], unique=False)
    if not _has_index("projects", "ix_projects_team_id"):
        op.create_index("ix_projects_team_id", "projects", ["team_id"], unique=False)


def downgrade() -> None:
    if _has_index("projects", "ix_projects_team_id"):
        op.drop_index("ix_projects_team_id", table_name="projects")
    if _has_index("projects", "ix_projects_created_by"):
        op.drop_index("ix_projects_created_by", table_name="projects")
    if _has_index("event_logs", "ix_event_logs_project_hidden_created"):
        op.drop_index("ix_event_logs_project_hidden_created", table_name="event_logs")
