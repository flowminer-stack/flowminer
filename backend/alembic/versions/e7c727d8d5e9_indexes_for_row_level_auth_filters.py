"""indexes for row-level auth filters

Revision ID: e7c727d8d5e9
Revises: c05b3a60914e
Create Date: 2026-04-12 10:03:19.192019

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e7c727d8d5e9"
down_revision: Union[str, None] = "c05b3a60914e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_event_logs_project_hidden_created",
        "event_logs",
        ["project_id", "hidden", "created_at"],
        unique=False,
    )
    op.create_index("ix_projects_created_by", "projects", ["created_by"], unique=False)
    op.create_index("ix_projects_team_id", "projects", ["team_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_projects_team_id", table_name="projects")
    op.drop_index("ix_projects_created_by", table_name="projects")
    op.drop_index("ix_event_logs_project_hidden_created", table_name="event_logs")
