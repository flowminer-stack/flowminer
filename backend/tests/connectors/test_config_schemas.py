"""Phase 2: declarative config schemas + the /registry endpoint.

Pins that every dispatchable connector has a config model, that secrets render
as password fields in the emitted JSON Schema, that validation is lenient about
the column-mapping keys the UI stores in config, and that the registry endpoint
serves every connector type (resolving before the /{connector_id} route).
"""

from __future__ import annotations

import pytest

from app.models import ConnectorType
from app.services.connectors import registered_ids
from app.services.connectors.config_schemas import (
    CONFIG_MODELS,
    get_config_model,
    validate_config,
)


def test_every_registered_connector_has_a_config_model():
    assert registered_ids() == set(CONFIG_MODELS), (
        "registry and config-schema map drifted: "
        f"{registered_ids() ^ set(CONFIG_MODELS)}"
    )


def test_every_config_model_emits_json_schema():
    for type_id, model in CONFIG_MODELS.items():
        schema = model.model_json_schema()
        assert schema.get("type") == "object", type_id
        assert "properties" in schema and schema["properties"], type_id


def test_secrets_render_as_password_fields():
    # SecretStr -> {"format": "password", "writeOnly": true} in JSON Schema.
    jira = get_config_model("jira").model_json_schema()["properties"]["api_token"]
    assert jira.get("format") == "password" and jira.get("writeOnly") is True
    db_pw = get_config_model("postgresql").model_json_schema()["properties"]["password"]
    assert db_pw.get("format") == "password"


def test_required_fields_are_marked_required():
    jira = get_config_model("jira").model_json_schema()
    for req in ("url", "email", "api_token", "project_key"):
        assert req in jira["required"], req


def test_validate_config_accepts_valid_and_extra_mapping_keys():
    ok, errors = validate_config(
        "jira",
        {
            "url": "https://x.atlassian.net",
            "email": "a@b.com",
            "api_token": "secret",
            "project_key": "PROJ",
            # column-mapping keys the UI tucks into config — must NOT fail.
            "case_id_column": "Issue Key",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
        },
    )
    assert ok, errors


def test_validate_config_rejects_missing_required():
    ok, errors = validate_config("jira", {"email": "a@b.com"})  # missing url, api_token, project_key
    assert not ok and errors


def test_validate_config_unknown_type_is_noop():
    ok, errors = validate_config("dynamics365", {"anything": 1})
    assert ok and errors == []


# ─── /registry endpoint ───────────────────────────────────────────────────────

REGISTRY_URL = "/api/v1/connectors/registry"


@pytest.mark.asyncio
async def test_registry_endpoint_lists_all_connector_types(client, make_user):
    from tests.conftest import auth_header

    _user, token = await make_user()
    resp = await client.get(REGISTRY_URL, headers=auth_header(token))
    assert resp.status_code == 200, resp.text
    entries = resp.json()

    ids = {e["id"] for e in entries}
    enum_ids = {ct.value for ct in ConnectorType} - {"dynamics365"}
    assert ids == enum_ids, f"registry endpoint missing/extra ids: {ids ^ enum_ids}"

    # Every entry carries a usable config schema + the UI hints.
    by_id = {e["id"]: e for e in entries}
    assert by_id["jira"]["mapping_mode"] == "auto"
    assert by_id["jira"]["config_schema"]["properties"]["api_token"]["format"] == "password"
    assert by_id["postgresql"]["category"] == "db"
    # The 4 DB dialects each appear as their own pickable entry.
    assert {"postgresql", "mysql", "sqlserver", "oracle"} <= ids


@pytest.mark.asyncio
async def test_registry_route_resolves_before_connector_id(client, make_user):
    """GET /connectors/registry must hit the registry handler, not be parsed as
    a connector UUID (which would 422)."""
    from tests.conftest import auth_header

    _user, token = await make_user()
    resp = await client.get(REGISTRY_URL, headers=auth_header(token))
    assert resp.status_code == 200
