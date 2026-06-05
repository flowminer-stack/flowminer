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


# ─── Dispatcher parity guard (Phase 0) ────────────────────────────────────────
# The scheduled-sync path (workers/tasks.py::sync_connector) carries its OWN,
# second connector dispatch that diverges from the API dispatcher above: it omits
# jira/github/odoo/zendesk/api_endpoint, so those connectors error on their cron
# schedule even though manual sync works. This guard makes that gap visible.
#
# It is xfail (non-strict) on purpose: the source-scan below cannot pass until
# Phase 1 unifies both paths onto a single registry, at which point this test is
# REPLACED by a registry-coverage assertion. Until then it keeps the gap on the
# record without turning the suite red.
import inspect


def _api_supported_types():
    """Connector types the API dispatcher can actually service."""
    supported = set()
    for ct in ConnectorType:
        try:
            _get_connector_service(ct)
            supported.add(ct)
        except HTTPException:
            pass  # explicit "unsupported type" branch (e.g. dynamics365)
        except ImportError:
            supported.add(ct)  # branch exists; optional client lib just absent
    return supported


@pytest.mark.xfail(
    reason="Phase 1: the Celery sync_connector dispatcher must cover the same "
    "connector types as the API dispatcher. jira/github/odoo/zendesk/api_endpoint "
    "are currently missing from the scheduled path. Replaced by a registry "
    "coverage test in Phase 1.",
    strict=False,
)
def test_celery_dispatcher_covers_api_connector_types():
    from app.workers import tasks

    src = inspect.getsource(tasks.sync_connector)
    api_types = _api_supported_types()
    missing = sorted(
        ct.name for ct in api_types if f"ConnectorType.{ct.name}" not in src
    )
    assert not missing, f"scheduled sync_connector is missing dispatch for: {missing}"
