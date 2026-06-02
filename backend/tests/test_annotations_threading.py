"""Regression tests for annotation threading + assignment (audit findings).

Guards:
  * assign_annotation must reject an assignee who isn't a member of the
    annotation's project (was written straight to the FK from request input).
  * nest_replies pagination must not drop a reply whose parent is paginated —
    pagination applies to top-level threads, then all their replies are fetched.
"""

import uuid

import pytest

from tests.conftest import auth_header


async def _make_project_with_log(client, db_session, token):
    """Create a project (via API, owned by the token's user) + an event log row."""
    r = await client.post("/api/v1/projects", json={"name": "Annotations P"}, headers=auth_header(token))
    assert r.status_code == 201, r.text
    project_id = r.json()["id"]

    from app.models import EventLog
    event_log_id = uuid.uuid4()
    db_session.add(EventLog(id=event_log_id, project_id=uuid.UUID(project_id), name="log.csv"))
    await db_session.commit()
    return project_id, str(event_log_id)


@pytest.mark.asyncio
async def test_reply_not_dropped_when_parent_paginated(client, db_session, make_user):
    user_a, token_a = await make_user()
    project_id, event_log_id = await _make_project_with_log(client, db_session, token_a)

    # One top-level annotation + one reply on it.
    r = await client.post("/api/v1/annotations",
                          json={"project_id": project_id, "event_log_id": event_log_id, "content": "parent"},
                          headers=auth_header(token_a))
    assert r.status_code == 201, r.text
    parent_id = r.json()["id"]

    r = await client.post(f"/api/v1/annotations/{parent_id}/replies",
                          json={"content": "child"}, headers=auth_header(token_a))
    assert r.status_code == 201, r.text

    # limit=1: pre-fix the raw-row query would return only the (newer) reply and
    # then drop it for having no in-page parent. Post-fix we page top-level
    # threads and attach all replies.
    r = await client.get(
        f"/api/v1/annotations?event_log_id={event_log_id}&nest_replies=true&limit=1",
        headers=auth_header(token_a))
    assert r.status_code == 200, r.text
    threads = r.json()
    assert len(threads) == 1, threads
    assert len(threads[0]["replies"]) == 1, threads[0]


@pytest.mark.asyncio
async def test_assign_rejects_non_member(client, db_session, make_user):
    user_a, token_a = await make_user()
    user_c, _ = await make_user()  # not a member of A's project
    project_id, event_log_id = await _make_project_with_log(client, db_session, token_a)

    r = await client.post("/api/v1/annotations",
                          json={"project_id": project_id, "event_log_id": event_log_id, "content": "x"},
                          headers=auth_header(token_a))
    annotation_id = r.json()["id"]

    # Assign to a user who can't access the project → 400.
    r = await client.patch(f"/api/v1/annotations/{annotation_id}/assign",
                           json={"assignee_id": str(user_c.id)}, headers=auth_header(token_a))
    assert r.status_code == 400, r.text

    # Assign to a non-existent user → 404.
    r = await client.patch(f"/api/v1/annotations/{annotation_id}/assign",
                           json={"assignee_id": str(uuid.uuid4())}, headers=auth_header(token_a))
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_assign_to_self_succeeds_and_can_clear(client, db_session, make_user):
    user_a, token_a = await make_user()
    project_id, event_log_id = await _make_project_with_log(client, db_session, token_a)

    r = await client.post("/api/v1/annotations",
                          json={"project_id": project_id, "event_log_id": event_log_id, "content": "x"},
                          headers=auth_header(token_a))
    annotation_id = r.json()["id"]

    # Owner is a project member → assignment allowed.
    r = await client.patch(f"/api/v1/annotations/{annotation_id}/assign",
                           json={"assignee_id": str(user_a.id)}, headers=auth_header(token_a))
    assert r.status_code == 200, r.text
    assert r.json()["assignee_id"] == str(user_a.id)

    # Clearing (null) is allowed.
    r = await client.patch(f"/api/v1/annotations/{annotation_id}/assign",
                           json={"assignee_id": None}, headers=auth_header(token_a))
    assert r.status_code == 200, r.text
    assert r.json()["assignee_id"] is None
