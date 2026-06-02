"""Regression test for the SQL-sandbox cross-tenant data leak (audit SECURITY).

The staging-table loader used to accept any path under the shared UPLOAD_DIR
with no ownership check, so user B could register and read user A's uploaded
file (laid out as UPLOAD_DIR/<project_id>/<file>) as a SQL table. The fix
authorizes the caller against the owning project. We exercise the loader
directly so the test is hermetic.
"""

import os
import uuid

import pandas as pd
import pytest
from fastapi import HTTPException

from app.api.analytics import _load_staging_dataframe
from app.config import settings
from app.models import Project


async def _setup_project_file(db_session, tmp_path, owner):
    upload_root = os.path.realpath(str(tmp_path))
    project_id = uuid.uuid4()
    proj_dir = os.path.join(upload_root, str(project_id))
    os.makedirs(proj_dir, exist_ok=True)
    csv_path = os.path.join(proj_dir, "data.csv")
    pd.DataFrame({"case_id": [1, 2], "activity": ["A", "B"]}).to_csv(csv_path, index=False)

    db_session.add(Project(id=project_id, name="A's private data", created_by=owner.id))
    await db_session.commit()
    return upload_root, csv_path


@pytest.mark.asyncio
async def test_other_tenant_cannot_load_staging_file(db_session, make_user, tmp_path, monkeypatch):
    user_a, _ = await make_user()
    user_b, _ = await make_user()  # different user, no shared team
    upload_root, csv_path = await _setup_project_file(db_session, tmp_path, user_a)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_root, raising=False)

    # B must NOT be able to read A's project-scoped staging file.
    with pytest.raises(HTTPException) as exc:
        await _load_staging_dataframe(csv_path, db_session, user_b)
    assert exc.value.status_code in (403, 404)


@pytest.mark.asyncio
async def test_owner_can_load_own_staging_file(db_session, make_user, tmp_path, monkeypatch):
    user_a, _ = await make_user()
    upload_root, csv_path = await _setup_project_file(db_session, tmp_path, user_a)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_root, raising=False)

    df = await _load_staging_dataframe(csv_path, db_session, user_a)
    assert isinstance(df, pd.DataFrame)
    assert len(df) == 2


@pytest.mark.asyncio
async def test_path_outside_upload_dir_rejected(db_session, make_user, tmp_path, monkeypatch):
    user_a, _ = await make_user()
    upload_root, _ = await _setup_project_file(db_session, tmp_path, user_a)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_root, raising=False)

    with pytest.raises(HTTPException):
        await _load_staging_dataframe("/etc/passwd", db_session, user_a)
