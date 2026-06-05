"""Fixtures for connector tests.

These run fully offline: no live data sources, no Docker. HTTP-based connectors
are exercised with ``respx`` (mocked httpx), file/transform logic with in-memory
DataFrames, and any connector that writes to ``UPLOAD_DIR`` has that directory
redirected to a per-test ``tmp_path``.
"""

from __future__ import annotations

import pandas as pd
import pytest


@pytest.fixture
def upload_dir(tmp_path, monkeypatch):
    """Redirect every connector module's UPLOAD_DIR/CONNECTOR_DIR to tmp_path.

    Connectors read ``UPLOAD_DIR`` from the environment at import time into a
    module-level constant, so we patch the already-bound module attributes
    rather than the environment. Returns the temp dir path.
    """
    import importlib

    target = str(tmp_path)
    modules = [
        "app.services.connectors.sap_connector",
        "app.services.connectors.workday_connector",
        "app.services.connectors.coupa_connector",
        "app.services.connectors.ariba_connector",
        "app.services.connectors.oracle_fusion_connector",
        "app.services.connectors.database_connector",
        "app.services.connectors.jira_connector",
        "app.services.connectors.csv_connector",
    ]
    for mod_name in modules:
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            continue
        for attr in ("UPLOAD_DIR", "CONNECTOR_DIR"):
            if hasattr(mod, attr):
                # jira's CONNECTOR_DIR is UPLOAD_DIR/connectors; keep it nested.
                value = target if attr == "UPLOAD_DIR" else f"{target}/connectors"
                monkeypatch.setattr(mod, attr, value, raising=False)
    return tmp_path


@pytest.fixture
def synthetic_event_log_df() -> pd.DataFrame:
    """A small, deterministic P2P-style event log for generic assertions.

    5 purchase-order cases, 3 activities each, strictly increasing timestamps.
    """
    rows = []
    activities = ["Create PO", "Approve PO", "Receive Goods"]
    for c in range(1, 6):
        for a, act in enumerate(activities):
            rows.append(
                {
                    "case_id": f"PO-{c:03d}",
                    "activity": act,
                    "timestamp": f"2026-01-{c:02d}T{8 + a:02d}:00:00Z",
                    "resource": f"user{c % 3}",
                }
            )
    return pd.DataFrame(rows)
