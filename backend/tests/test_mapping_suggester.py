"""Tests for the AI column-mapping suggester (service + endpoint).

Covers the deterministic heuristic (no LLM), the LLM path (mocked), validation
of hallucinated columns, graceful fallback, and the HTTP endpoint.
"""

from __future__ import annotations

import json

import pytest

from app.services.ai import llm
from app.services.ai import mapping_suggester as ms
from tests.conftest import auth_header

# preview_table-shaped profile of a typical order table.
_COLUMNS = [
    {"name": "order_id", "dtype": "int64", "kind": "numeric", "nunique": 1500, "null_ratio": 0.0},
    {"name": "status", "dtype": "object", "kind": "text", "nunique": 5, "null_ratio": 0.0},
    {"name": "created_at", "dtype": "datetime64[ns]", "kind": "datetime", "nunique": 1490, "null_ratio": 0.0},
    {"name": "assigned_to", "dtype": "object", "kind": "text", "nunique": 12, "null_ratio": 0.1},
    {"name": "amount", "dtype": "float64", "kind": "numeric", "nunique": 900, "null_ratio": 0.0},
]
_SAMPLES = [
    {"order_id": 1001, "status": "Created", "created_at": "2026-01-01T09:00:00", "assigned_to": "alice", "amount": 42.0},
    {"order_id": 1002, "status": "Approved", "created_at": "2026-01-02T10:00:00", "assigned_to": "bob", "amount": 88.5},
]


def test_heuristic_picks_sensible_columns():
    """No LLM configured (default in tests) -> heuristic answer."""
    assert not llm.is_llm_configured()  # null provider in the test env
    out = ms.suggest_mapping(_COLUMNS, _SAMPLES)
    assert out["source"] == "heuristic"
    assert out["case_id_column"] == "order_id"      # id-named, highest cardinality
    assert out["activity_column"] == "status"        # activity-ish, low cardinality
    assert out["timestamp_column"] == "created_at"   # datetime
    assert out["resource_column"] == "assigned_to"   # name hint
    assert 0.0 <= out["confidence"] <= 1.0


def test_empty_columns_returns_nulls():
    out = ms.suggest_mapping([], [])
    assert out["case_id_column"] is None
    assert out["source"] == "heuristic"


def test_llm_mapping_used_and_validated(monkeypatch):
    monkeypatch.setattr(llm, "is_llm_configured", lambda: True)
    monkeypatch.setattr(llm, "current_provider", lambda: "openai")

    payload = {
        "case_id_column": "order_id",
        "activity_column": "status",
        "timestamp_column": "created_at",
        "resource_column": "assigned_to",
        "object_type_columns": ["order_id"],
        "confidence": 0.93,
        "rationale": "order_id is the unique case key; status is the activity.",
    }
    monkeypatch.setattr(llm, "complete", lambda *a, **k: f"```json\n{json.dumps(payload)}\n```")

    out = ms.suggest_mapping(_COLUMNS, _SAMPLES, connector_type="postgresql")
    assert out["source"] == "llm"
    assert out["timestamp_column"] == "created_at"
    assert out["object_type_columns"] == ["order_id"]
    assert out["confidence"] == pytest.approx(0.93)


def test_llm_hallucinated_columns_dropped_and_backfilled(monkeypatch):
    monkeypatch.setattr(llm, "is_llm_configured", lambda: True)
    monkeypatch.setattr(llm, "current_provider", lambda: "openrouter")
    payload = {
        "case_id_column": "does_not_exist",   # hallucinated -> backfilled from heuristic
        "activity_column": "status",
        "timestamp_column": "created_at",
        "resource_column": "ghost_col",        # hallucinated -> dropped to None
        "object_type_columns": ["nope", "order_id"],
        "confidence": 0.7,
        "rationale": "x",
    }
    monkeypatch.setattr(llm, "complete", lambda *a, **k: json.dumps(payload))

    out = ms.suggest_mapping(_COLUMNS, _SAMPLES)
    assert out["case_id_column"] == "order_id"      # required field backfilled
    assert out["resource_column"] is None            # non-required hallucination dropped
    assert out["object_type_columns"] == ["order_id"]  # only the real one kept


def test_llm_failure_falls_back_to_heuristic(monkeypatch):
    monkeypatch.setattr(llm, "is_llm_configured", lambda: True)
    monkeypatch.setattr(llm, "current_provider", lambda: "openai")

    def _boom(*a, **k):
        raise RuntimeError("api down")

    monkeypatch.setattr(llm, "complete", _boom)
    out = ms.suggest_mapping(_COLUMNS, _SAMPLES)
    assert out["source"] == "heuristic"
    assert out["timestamp_column"] == "created_at"


def test_mapping_model_is_gpt_41_nano(monkeypatch):
    monkeypatch.setattr(llm, "current_provider", lambda: "openrouter")
    assert ms._mapping_model() == "openai/gpt-4.1-nano"
    monkeypatch.setattr(llm, "current_provider", lambda: "openai")
    assert ms._mapping_model() == "gpt-4.1-nano"


@pytest.mark.asyncio
async def test_suggest_mapping_endpoint(client, make_user):
    _user, token = await make_user()
    resp = await client.post(
        "/api/v1/log-builder/suggest-mapping",
        json={"columns": _COLUMNS, "sample_rows": _SAMPLES, "connector_type": "postgresql"},
        headers=auth_header(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["case_id_column"] == "order_id"
    assert data["timestamp_column"] == "created_at"
    assert data["llm_configured"] is False
    assert data["source"] == "heuristic"


@pytest.mark.asyncio
async def test_suggest_mapping_endpoint_requires_input(client, make_user):
    _user, token = await make_user()
    resp = await client.post(
        "/api/v1/log-builder/suggest-mapping", json={}, headers=auth_header(token),
    )
    assert resp.status_code == 400
