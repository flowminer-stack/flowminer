"""Verify row-level authorization: user A cannot touch user B's resources.

If any of these tests regress, someone has reintroduced an IDOR.
"""

import pytest

from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_user_cannot_read_anothers_project(client, make_user):
    user_a, token_a = await make_user()
    user_b, token_b = await make_user()

    # A creates a project
    r = await client.post(
        "/api/v1/projects",
        json={"name": "A private"},
        headers=auth_header(token_a),
    )
    assert r.status_code == 201, r.text
    project_id = r.json()["id"]

    # B cannot see it via direct GET
    r = await client.get(f"/api/v1/projects/{project_id}", headers=auth_header(token_b))
    assert r.status_code == 404

    # B cannot delete it
    r = await client.delete(f"/api/v1/projects/{project_id}", headers=auth_header(token_b))
    assert r.status_code == 404

    # B cannot update it
    r = await client.put(
        f"/api/v1/projects/{project_id}",
        json={"name": "hijacked"},
        headers=auth_header(token_b),
    )
    assert r.status_code == 404

    # A can still read it
    r = await client.get(f"/api/v1/projects/{project_id}", headers=auth_header(token_a))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_list_projects_is_row_filtered(client, make_user):
    user_a, token_a = await make_user()
    user_b, token_b = await make_user()

    # A and B each create a project
    await client.post("/api/v1/projects", json={"name": "A project"}, headers=auth_header(token_a))
    await client.post("/api/v1/projects", json={"name": "B project"}, headers=auth_header(token_b))

    r_a = await client.get("/api/v1/projects", headers=auth_header(token_a))
    r_b = await client.get("/api/v1/projects", headers=auth_header(token_b))

    assert r_a.status_code == 200 and r_b.status_code == 200
    a_names = [p["name"] for p in r_a.json()]
    b_names = [p["name"] for p in r_b.json()]
    assert "A project" in a_names
    assert "B project" not in a_names
    assert "B project" in b_names
    assert "A project" not in b_names


@pytest.mark.asyncio
async def test_admin_can_see_everything(client, make_user):
    from app.models import UserRole

    user_a, token_a = await make_user()
    admin, token_admin = await make_user(role=UserRole.admin)

    r = await client.post(
        "/api/v1/projects",
        json={"name": "A's thing"},
        headers=auth_header(token_a),
    )
    project_id = r.json()["id"]

    r = await client.get(f"/api/v1/projects/{project_id}", headers=auth_header(token_admin))
    assert r.status_code == 200
    assert r.json()["name"] == "A's thing"


@pytest.mark.asyncio
async def test_team_members_share_projects(client, make_user):
    import uuid
    from app.models import Team, UserRole
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    # Create a team, two users on it, one user off it
    from tests.conftest import test_engine  # noqa: F401 — fixture, but we build a session manually

    # Use the same engine via dependency, easier: create team via a user endpoint? teams have no API.
    # Bypass by writing directly via the client fixture's overridden session.
    # Simpler: create two users with team_id None, manually set them on a team by inserting a row
    # through the ORM in a side session (same in-memory engine).
    from app.database import Base
    from sqlalchemy.ext.asyncio import create_async_engine

    # Reuse the one engine — grabbing it from app state isn't straightforward, so build a user
    # with team_id matching another user. We can create a team through direct Session manipulation
    # by peeking at the client transport's app state — instead, just ensure the predicate is
    # exercised via two users sharing the same team_id.
    shared_team_id = uuid.uuid4()
    user_a, token_a = await make_user(team_id=shared_team_id)
    user_b, token_b = await make_user(team_id=shared_team_id)
    user_c, token_c = await make_user()  # no team

    # A creates a project
    r = await client.post("/api/v1/projects", json={"name": "team thing"}, headers=auth_header(token_a))
    project_id = r.json()["id"]

    # Note: the Project created this way has team_id=None by default; for the team-sharing
    # behavior to be tested we need to set it. Since PUT doesn't accept team_id, we patch via
    # direct ORM access — this keeps the test focused on the access-predicate semantics.
    from app.models import Project
    from sqlalchemy import update, select

    # Reach into the client's dependency override to grab a session.
    from app.database import get_db
    from app.main import app as fastapi_app

    get_db_override = fastapi_app.dependency_overrides[get_db]
    async for session in get_db_override():
        await session.execute(update(Project).where(Project.id == uuid.UUID(project_id)).values(team_id=shared_team_id))
        await session.commit()
        break

    # B (same team) should see it
    r = await client.get(f"/api/v1/projects/{project_id}", headers=auth_header(token_b))
    assert r.status_code == 200, f"Team member should see project but got {r.status_code}: {r.text}"

    # C (no team) should NOT
    r = await client.get(f"/api/v1/projects/{project_id}", headers=auth_header(token_c))
    assert r.status_code == 404
