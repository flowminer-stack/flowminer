"""QW3: prebuilt process content packs (recipes) load, validate, map onto the
builder's BuilderEvent/BuilderJoin shape, and are served by /templates."""

from __future__ import annotations

import pytest

from app.api.log_builder import BuilderEvent, BuilderJoin
from app.services.log_builder_recipes import (
    ProcessRecipe,
    get_recipe,
    list_recipes,
    load_recipes,
)

EXPECTED_IDS = {"sap_p2p", "servicenow_incident", "salesforce_opportunity"}


def test_all_recipes_load_and_validate():
    recipes = load_recipes(force=True)
    assert set(recipes) == EXPECTED_IDS
    assert all(isinstance(r, ProcessRecipe) for r in recipes.values())


@pytest.mark.parametrize("rid", sorted(EXPECTED_IDS))
def test_recipe_shape(rid):
    r = get_recipe(rid)
    assert r is not None
    # exactly one primary table (enforced by the model, asserted here too)
    assert sum(t.role == "primary" for t in r.required_tables) == 1
    # joins reference declared tables
    names = {t.name for t in r.required_tables}
    for j in r.joins:
        assert j.left_table in names and j.right_table in names
    # events reference declared tables and carry an activity + timestamp
    for e in r.events:
        assert e.source_table in names
        assert e.activity_name and e.timestamp_column
    # the override escape hatch is present (mandatory per the design)
    assert r.additional_columns, f"{rid} must ship an additional_columns override layer"


@pytest.mark.parametrize("rid", sorted(EXPECTED_IDS))
def test_builder_events_map_onto_builder_event_model(rid):
    r = get_recipe(rid)
    for ev in r.builder_events():
        # Must validate against the real builder schema, i.e. recipes are
        # executable by the existing log builder with no new engine.
        BuilderEvent.model_validate(ev)


def test_recipe_joins_map_onto_builder_join_model():
    # SAP P2P has the multi-table joins; they must map to BuilderJoin (using the
    # additional-source index the frontend resolves logical table names to).
    sap = get_recipe("sap_p2p")
    assert sap.joins, "sap_p2p should declare header/line/history joins"
    for idx, j in enumerate(sap.joins):
        BuilderJoin.model_validate(
            {"right_source": idx + 1, "left_on": j.left_on, "right_on": j.right_on, "how": j.how}
        )


def test_list_recipes_filters_by_connector_type():
    assert {r.id for r in list_recipes(connector_type="sap")} == {"sap_p2p"}
    assert {r.id for r in list_recipes(connector_type="servicenow")} == {"servicenow_incident"}
    assert list_recipes(connector_type="nonexistent") == []


def test_get_recipe_unknown_is_none():
    assert get_recipe("does_not_exist") is None


# ─── /templates endpoint ──────────────────────────────────────────────────────

BASE = "/api/v1/log-builder/templates"


@pytest.mark.asyncio
async def test_templates_endpoint_lists_all(client, make_user):
    from tests.conftest import auth_header

    _u, token = await make_user()
    resp = await client.get(BASE, headers=auth_header(token))
    assert resp.status_code == 200, resp.text
    assert {r["id"] for r in resp.json()} == EXPECTED_IDS


@pytest.mark.asyncio
async def test_templates_endpoint_get_one_and_404(client, make_user):
    from tests.conftest import auth_header

    _u, token = await make_user()
    ok = await client.get(f"{BASE}/sap_p2p", headers=auth_header(token))
    assert ok.status_code == 200
    assert ok.json()["process_name"] == "SAP Purchase-to-Pay"

    missing = await client.get(f"{BASE}/nope", headers=auth_header(token))
    assert missing.status_code == 404
