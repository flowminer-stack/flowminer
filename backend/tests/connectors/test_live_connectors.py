"""Live / cassette-replay tests for the connectors with real free dev orgs.

These hit a real, free, self-service account (GitHub PAT, Salesforce Developer
Edition, ServiceNow Personal Developer Instance, Jira Cloud free) — or replay a
previously recorded, credential-scrubbed cassette. They are the layer that
catches real API-shape drift that respx mocks cannot.

Safe by default: each test SKIPS unless its ``FLOWMINER_TEST_<ID>`` env var is
set, and ``vcr_config`` pins ``record_mode="none"`` so a normal run never
touches the network. They are also marked ``live`` so the default suite
(``pytest -m "not live and not integration"``) excludes them.

To RECORD a cassette once (then commit it for creds-free replay in CI):

    export FLOWMINER_TEST_GITHUB='{"token":"ghp_…","owner":"microsoft",
        "repo":"vscode","event_type":"issues","max_items":20}'
    pytest tests/connectors/test_live_connectors.py -m live --record-mode=once

The cassette is written under ``cassettes/`` with all secrets redacted (see the
``vcr_config`` fixture). Config blobs per connector:

  FLOWMINER_TEST_GITHUB      {"token","owner","repo","event_type","max_items"}
  FLOWMINER_TEST_SALESFORCE  {"instance_url","access_token"|oauth…,"object_type"|"soql_query"}
  FLOWMINER_TEST_SERVICENOW  {"instance_url","username","password","table","limit"}
  FLOWMINER_TEST_JIRA        {"url","email","api_token","project_key","max_results"}
"""

from __future__ import annotations

import json
import os

import pandas as pd
import pytest

vcr = pytest.importorskip("vcr")  # provided by pytest-recording; skip if absent

from app.services.connectors import get_connector  # noqa: E402

from .event_log_assertions import assert_valid_event_log  # noqa: E402

# connector id -> the env var holding its JSON config blob
_CONNECTORS = {
    "github": "FLOWMINER_TEST_GITHUB",
    "salesforce": "FLOWMINER_TEST_SALESFORCE",
    "servicenow": "FLOWMINER_TEST_SERVICENOW",
    "jira": "FLOWMINER_TEST_JIRA",
}


def _load_config(env_var: str) -> dict | None:
    raw = os.environ.get(env_var)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:  # pragma: no cover - operator error
        pytest.fail(f"{env_var} is not valid JSON: {e}")


def _read_event_log(path: str) -> pd.DataFrame:
    return pd.read_parquet(path) if path.endswith(".parquet") else pd.read_csv(path)


@pytest.mark.live
@pytest.mark.vcr
@pytest.mark.asyncio
@pytest.mark.parametrize("connector_id", list(_CONNECTORS))
async def test_live_connector_produces_event_log(connector_id, upload_dir):
    config = _load_config(_CONNECTORS[connector_id])
    if config is None:
        pytest.skip(f"set {_CONNECTORS[connector_id]} to record/replay this connector")

    connector = get_connector(connector_id)
    mapping = connector.get_default_column_mapping(config) or {}
    path = await connector.fetch_data(config, mapping)

    df = _read_event_log(path)
    assert len(df) > 0
    # Every auto-mapped connector must yield a mineable log under its own mapping.
    assert_valid_event_log(
        df,
        case_col=mapping["case_id_column"],
        activity_col=mapping["activity_column"],
        ts_col=mapping["timestamp_column"],
    )
