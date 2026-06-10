"""Tests for connector write-back (create_external_record) feature.

Covers:
1. CONTRACT — every write-back-capable connector class overrides create_record
   and has a non-empty write_back_label.
2. dispatch_action dry_run for create_external_record — returns intent, no I/O.
3. dispatch_action real path — stub connector, write-back disabled connector.
4. Jira create_record happy-path with a mocked HTTP layer (respx).
5. GitHub create_record happy-path with a mocked HTTP layer (respx).
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import respx

# ── test env bootstrap (mirrors tests/conftest.py) ──────────────────────────
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("SYNC_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SECRET_KEY", "test-secret-key-at-least-sixteen-chars")
os.environ.setdefault("ENV", "development")

from app.services import action_engine
from app.services.connectors import all_connector_classes
from app.services.connectors.base import BaseConnector
from app.services.connectors.jira_connector import JiraConnector
from app.services.connectors.github_connector import GitHubConnector


# ── helpers ──────────────────────────────────────────────────────────────────

CASE = {
    "case_id": "CASE-42",
    "case_duration": 7200.0,
    "current_activity": "Waiting for approval",
    "time_on_activity": 3600.0,
    "event_count": 5,
    "rework_count": 1,
}


# ═══════════════════════════════════════════════════════════════════════════════
# 1. CONTRACT: write-back connectors must override create_record + have a label
# ═══════════════════════════════════════════════════════════════════════════════

def test_all_write_back_connectors_override_create_record():
    """Every connector that declares supports_write_back=True must provide
    its own create_record implementation (not BaseConnector's stub)."""
    violations = []
    for cls in all_connector_classes():
        if cls.meta and cls.meta.supports_write_back:
            if cls.create_record is BaseConnector.create_record:
                violations.append(cls.__name__)
    assert not violations, (
        f"These connectors declare supports_write_back=True but do NOT override "
        f"create_record: {violations}"
    )


def test_all_write_back_connectors_have_non_empty_label():
    """Every write-back connector must ship a non-empty write_back_label so the
    UI connector picker has something to display."""
    violations = []
    for cls in all_connector_classes():
        if cls.meta and cls.meta.supports_write_back:
            label = cls.meta.write_back_label
            if not label or not label.strip():
                violations.append(cls.__name__)
    assert not violations, (
        f"These connectors declare supports_write_back=True but have an empty "
        f"write_back_label: {violations}"
    )


def test_non_write_back_connectors_do_not_override_create_record():
    """Connectors that do NOT declare supports_write_back should still use
    the base NotImplementedError stub so callers get a clean error."""
    import asyncio

    for cls in all_connector_classes():
        if cls.meta and not cls.meta.supports_write_back:
            instance = cls.__new__(cls)  # don't call __init__
            # asyncio.run() creates and tears down its own loop, so this is safe
            # regardless of whether a prior async test left the thread without a
            # current event loop (Python 3.12 makes get_event_loop() raise then).
            with pytest.raises(NotImplementedError):
                asyncio.run(instance.create_record({}, {}))


# ═══════════════════════════════════════════════════════════════════════════════
# 2. dispatch_action dry_run — intent returned, no network/DB
# ═══════════════════════════════════════════════════════════════════════════════

async def test_create_external_record_dry_run_returns_intent():
    """dry_run=True must return the intent dict with the right keys without
    touching the network or a database session."""
    action = {
        "type": "create_external_record",
        "params": {
            "connector_id": str(uuid.uuid4()),
            "title": "Slow case {case_id} in {current_activity}",
            "description": "Duration: {case_duration}s",
        },
    }
    detail = await action_engine.dispatch_action(
        action, CASE, dry_run=True, db=None
    )
    assert detail["action"] == "create_external_record"
    assert "title" in detail
    # The title template should have been rendered against the case snapshot
    assert "CASE-42" in detail["title"]
    # No success key — dry_run never attempts the real path
    assert "success" not in detail
    # No external_id — nothing was actually created
    assert "external_id" not in detail


async def test_create_external_record_dry_run_with_no_connector_id():
    """dry_run must still return the intent dict even when no connector_id is
    provided — the validation of connector_id only fires on the real path."""
    action = {"type": "create_external_record", "params": {}}
    detail = await action_engine.dispatch_action(
        action, CASE, dry_run=True, db=None
    )
    assert detail["action"] == "create_external_record"
    assert "success" not in detail


# ═══════════════════════════════════════════════════════════════════════════════
# 3. dispatch_action real path — stub DB + stub connector
# ═══════════════════════════════════════════════════════════════════════════════

def _make_fake_db(connector_row):
    """Build a minimal AsyncSession-like object whose execute() returns a
    scalar_one_or_none() resolving to connector_row."""
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=connector_row)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=scalar_result)
    return db


async def test_dispatch_create_external_record_success(monkeypatch):
    """Real path: stub connector returns external_id; detail.success is True
    and external_id/external_url propagate."""
    connector_id = uuid.uuid4()
    project_id = uuid.uuid4()

    # Build a fake Connector DB row
    fake_row = MagicMock()
    fake_row.id = connector_id
    fake_row.project_id = project_id
    fake_row.connector_type = MagicMock()
    fake_row.connector_type.value = "jira"
    fake_row.config = {
        "url": "https://example.atlassian.net",
        "email": "user@example.com",
        "api_token": "token",
        "project_key": "PM",
    }

    # Stub out decrypt_connector_config to pass config through unchanged
    monkeypatch.setattr(
        "app.services.action_engine.decrypt_connector_config",
        lambda cfg: cfg,
        raising=False,
    )
    # We need to patch the import path used inside dispatch_action
    import app.services.action_engine as ae_mod
    monkeypatch.setattr(
        ae_mod,
        "decrypt_connector_config",
        lambda cfg: cfg,
        raising=False,
    )

    # Stub get_connector to return a connector whose create_record is a no-op
    stub_conn = MagicMock()
    stub_conn.meta = MagicMock()
    stub_conn.meta.supports_write_back = True
    stub_conn.create_record = AsyncMock(
        return_value={"external_id": "PM-99", "url": "https://example.atlassian.net/browse/PM-99", "raw": {}}
    )

    monkeypatch.setattr(
        "app.services.connectors.get_connector",
        lambda type_id: stub_conn,
        raising=False,
    )

    db = _make_fake_db(fake_row)

    action = {
        "type": "create_external_record",
        "params": {
            "connector_id": str(connector_id),
            "title": "Slow case {case_id}",
        },
    }
    detail = await action_engine.dispatch_action(
        action, CASE,
        dry_run=False,
        db=db,
        project_id=project_id,
    )

    assert detail["success"] is True, detail
    assert detail["external_id"] == "PM-99"
    assert detail["external_url"] == "https://example.atlassian.net/browse/PM-99"


async def test_dispatch_create_external_record_no_write_back_support(monkeypatch):
    """If the connector does NOT support write-back, success must be False and
    the error message must mention 'write-back'."""
    connector_id = uuid.uuid4()
    project_id = uuid.uuid4()

    fake_row = MagicMock()
    fake_row.id = connector_id
    fake_row.project_id = project_id
    fake_row.connector_type = MagicMock()
    fake_row.connector_type.value = "csv_watch"
    fake_row.config = {}

    monkeypatch.setattr(
        "app.services.connectors.get_connector",
        lambda type_id: MagicMock(meta=MagicMock(supports_write_back=False)),
        raising=False,
    )

    db = _make_fake_db(fake_row)

    action = {
        "type": "create_external_record",
        "params": {"connector_id": str(connector_id)},
    }
    detail = await action_engine.dispatch_action(
        action, CASE,
        dry_run=False,
        db=db,
        project_id=project_id,
    )

    assert detail["success"] is False
    assert "write-back" in detail.get("error", "").lower()


async def test_dispatch_create_external_record_connector_not_found(monkeypatch):
    """If the DB lookup returns None (unknown connector_id), success must be
    False with an appropriate error."""
    connector_id = uuid.uuid4()
    project_id = uuid.uuid4()

    db = _make_fake_db(None)  # scalar_one_or_none returns None

    action = {
        "type": "create_external_record",
        "params": {"connector_id": str(connector_id)},
    }
    detail = await action_engine.dispatch_action(
        action, CASE,
        dry_run=False,
        db=db,
        project_id=project_id,
    )

    assert detail["success"] is False
    assert "not found" in detail.get("error", "").lower()


async def test_dispatch_create_external_record_missing_connector_id():
    """When connector_id is absent, success must be False immediately."""
    action = {"type": "create_external_record", "params": {}}
    db = AsyncMock()  # should never be hit
    detail = await action_engine.dispatch_action(
        action, CASE,
        dry_run=False,
        db=db,
    )
    assert detail["success"] is False


async def test_dispatch_create_external_record_no_db():
    """When db is None on the real path, success must be False."""
    action = {
        "type": "create_external_record",
        "params": {"connector_id": str(uuid.uuid4())},
    }
    detail = await action_engine.dispatch_action(
        action, CASE,
        dry_run=False,
        db=None,
    )
    assert detail["success"] is False


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Jira create_record happy-path with respx
# ═══════════════════════════════════════════════════════════════════════════════

@respx.mock
@pytest.mark.asyncio
async def test_jira_create_record_posts_to_correct_url_and_returns_key():
    """JiraConnector.create_record must POST to /rest/api/3/issue and return
    the issue key as external_id with the correct browse URL."""
    jira_base = "https://myorg.atlassian.net"
    issue_url = f"{jira_base}/rest/api/3/issue"

    route = respx.post(issue_url).mock(
        return_value=httpx.Response(
            201,
            json={"id": "10042", "key": "PM-7", "self": f"{jira_base}/rest/api/3/issue/10042"},
        )
    )

    config = {
        "url": jira_base,
        "email": "user@example.com",
        "api_token": "my-api-token",
        "project_key": "PM",
    }
    payload = {
        "title": "Slow purchase order CASE-42",
        "description": "Duration exceeded threshold.",
        "priority": "high",
        "case_id": "CASE-42",
        "case": CASE,
        "fields": {"issue_type": "Bug"},
        "rule_id": None,
    }

    result = await JiraConnector().create_record(config, payload)

    assert route.called, "Expected a POST to the Jira issues endpoint"
    assert result["external_id"] == "PM-7"
    assert result["url"] == f"{jira_base}/browse/PM-7"
    assert "raw" in result

    # Verify request body contains the expected project key and summary
    request_body = route.calls[0].request
    import json
    body = json.loads(request_body.content)
    assert body["fields"]["project"]["key"] == "PM"
    assert "CASE-42" in body["fields"]["summary"]
    assert body["fields"]["issuetype"]["name"] == "Bug"


@respx.mock
@pytest.mark.asyncio
async def test_jira_create_record_raises_on_http_error():
    """JiraConnector.create_record must raise RuntimeError on non-2xx."""
    jira_base = "https://myorg.atlassian.net"
    respx.post(f"{jira_base}/rest/api/3/issue").mock(
        return_value=httpx.Response(403, text="Forbidden")
    )

    config = {
        "url": jira_base,
        "email": "user@example.com",
        "api_token": "bad-token",
        "project_key": "PM",
    }
    payload = {"title": "Test", "description": "Test", "case_id": "X", "case": {}, "fields": {}}

    with pytest.raises(RuntimeError, match="403"):
        await JiraConnector().create_record(config, payload)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. GitHub create_record happy-path with respx
# ═══════════════════════════════════════════════════════════════════════════════

@respx.mock
@pytest.mark.asyncio
async def test_github_create_record_posts_to_issues_endpoint():
    """GitHubConnector.create_record must POST to the correct GitHub issues
    endpoint and return '#<number>' as external_id with the html_url."""
    owner = "myorg"
    repo = "flowminer"
    issues_url = f"https://api.github.com/repos/{owner}/{repo}/issues"

    route = respx.post(issues_url).mock(
        return_value=httpx.Response(
            201,
            json={
                "number": 42,
                "html_url": f"https://github.com/{owner}/{repo}/issues/42",
                "title": "Slow case CASE-42",
                "state": "open",
            },
        )
    )

    config = {
        "token": "ghp_test_token",
        "owner": owner,
        "repo": repo,
    }
    payload = {
        "title": "Slow case CASE-42",
        "description": "Case has exceeded the duration threshold.",
        "priority": None,
        "case_id": "CASE-42",
        "case": CASE,
        "fields": {"labels": ["process-alert"], "assignees": ["engineer1"]},
        "rule_id": None,
    }

    result = await GitHubConnector().create_record(config, payload)

    assert route.called, "Expected a POST to the GitHub issues endpoint"
    assert result["external_id"] == "#42"
    assert result["url"] == f"https://github.com/{owner}/{repo}/issues/42"
    assert "raw" in result

    # Verify the request body forwarded labels and assignees
    import json
    body = json.loads(route.calls[0].request.content)
    assert body["title"] == payload["title"]
    assert "process-alert" in body["labels"]
    assert "engineer1" in body["assignees"]


@respx.mock
@pytest.mark.asyncio
async def test_github_create_record_raises_on_http_error():
    """GitHubConnector.create_record must raise RuntimeError on non-2xx."""
    owner, repo = "myorg", "flowminer"
    respx.post(f"https://api.github.com/repos/{owner}/{repo}/issues").mock(
        return_value=httpx.Response(422, json={"message": "Unprocessable Entity"})
    )

    config = {"token": "bad", "owner": owner, "repo": repo}
    payload = {"title": "Test", "description": "Test", "case_id": "X", "case": {}, "fields": {}}

    with pytest.raises(RuntimeError, match="422"):
        await GitHubConnector().create_record(config, payload)
