"""Regression test for connector dispatcher / UI parity (audit finding).

'dynamics365' used to be selectable in ConnectorForm but had no branch in
_get_connector_service(), so creating it 400'd. The fix removed it from the
form. This pins the contract: the core connectors dispatch, and dynamics365 is
explicitly unsupported (so it must NOT be re-added to the UI form without a
backend branch).
"""

import pytest
from fastapi import HTTPException

from app.api.connectors import _get_connector_service
from app.models.connector import ConnectorType
from app.services.connectors.base import BaseConnector

# Connectors with no optional third-party client lib — always constructible here.
CORE_TYPES = [
    ConnectorType.postgresql, ConnectorType.mysql, ConnectorType.sqlserver,
    ConnectorType.oracle, ConnectorType.csv_watch, ConnectorType.api_endpoint,
    ConnectorType.jira, ConnectorType.github, ConnectorType.odoo, ConnectorType.zendesk,
]


@pytest.mark.parametrize("ctype", CORE_TYPES)
def test_core_connectors_dispatch(ctype):
    svc = _get_connector_service(ctype)
    assert isinstance(svc, BaseConnector)


def test_dynamics365_is_explicitly_unsupported():
    # If someone re-adds dynamics365 to the dispatcher OR the UI form without the
    # other side, this guard + the comment here flags the mismatch.
    with pytest.raises(HTTPException):
        _get_connector_service(ConnectorType.dynamics365)


def test_enterprise_types_are_not_the_unsupported_branch():
    """Enterprise connectors may ImportError if their optional lib is absent,
    but they must NOT hit the 'unsupported type' HTTPException."""
    enterprise = [
        ConnectorType.sap, ConnectorType.salesforce, ConnectorType.servicenow,
        ConnectorType.snowflake, ConnectorType.bigquery, ConnectorType.workday,
        ConnectorType.coupa, ConnectorType.ariba, ConnectorType.oracle_fusion,
    ]
    for ctype in enterprise:
        try:
            svc = _get_connector_service(ctype)
            assert isinstance(svc, BaseConnector)
        except HTTPException:
            pytest.fail(f"{ctype} hit the unsupported-type branch — dispatcher regressed")
        except ImportError:
            pass  # optional client lib not installed in this env — acceptable


# ─── Registry coverage (Phase 1) ──────────────────────────────────────────────
# The if/elif dispatchers (one in the API, one diverging copy in the Celery
# task) were replaced by a single self-registration registry. These guards pin
# that the registry covers every ConnectorType and that BOTH dispatch paths
# resolve through it — so "supported on manual sync but not on cron"
# (jira/github/odoo/zendesk/api_endpoint) can never recur.
import inspect


def test_registry_covers_all_enum_types_or_is_explicitly_unregistered():
    from app.services.connectors import (
        INTENTIONALLY_UNREGISTERED,
        registered_ids,
        validate_registry,
    )

    enum_ids = {ct.value for ct in ConnectorType}
    missing = enum_ids - registered_ids() - set(INTENTIONALLY_UNREGISTERED)
    assert not missing, f"ConnectorType(s) with no registered connector: {sorted(missing)}"
    # The boot-time guard must pass for the real connector set.
    validate_registry()


def test_dynamics365_is_the_only_intentionally_unregistered_type():
    from app.services.connectors import INTENTIONALLY_UNREGISTERED, registered_ids

    enum_ids = {ct.value for ct in ConnectorType}
    assert (enum_ids - registered_ids()) == set(INTENTIONALLY_UNREGISTERED) == {"dynamics365"}


def test_api_and_celery_dispatch_share_the_registry():
    """Both the API (_get_connector_service) and the Celery sync_connector task
    resolve connectors through get_connector_class — they cannot diverge."""
    from pathlib import Path

    from app.api import connectors as api_connectors

    assert "get_connector_class" in inspect.getsource(api_connectors._get_connector_service)

    # Read tasks.py from disk rather than importing it: app.workers.tasks builds
    # a sync SQLAlchemy engine at import time with pool args the sqlite test DB
    # rejects, so importing it here would fail for reasons unrelated to dispatch.
    # get_connector_class appears only in sync_connector, so a file-level check
    # is sufficient.
    tasks_src = (
        Path(__file__).resolve().parents[1] / "app" / "workers" / "tasks.py"
    ).read_text()
    assert "get_connector_class" in tasks_src
