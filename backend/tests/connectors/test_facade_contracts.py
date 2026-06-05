"""Event-log contract for auto-mapped connectors.

Phase 0 shipped this as an xfail spec: Workday/Coupa/Ariba/OracleFusion produced
raw dumps with no case/activity/timestamp mapping. Phase 6 gave them a transform
+ default mapping, so the contract now holds — and is generalised to every
auto-mapped connector that claims to produce an event log.
"""

from __future__ import annotations

import pytest

from app.services.connectors import connector_registry, get_connector_class
from app.services.connectors.ariba_connector import AribaConnector
from app.services.connectors.coupa_connector import CoupaConnector
from app.services.connectors.oracle_fusion_connector import OracleFusionConnector
from app.services.connectors.workday_connector import WorkdayConnector

from .event_log_assertions import assert_declares_event_log_mapping

# The connectors that were "facades" in Phase 0 — pinned explicitly.
FACADES = [WorkdayConnector, CoupaConnector, AribaConnector, OracleFusionConnector]


@pytest.mark.parametrize("cls", FACADES, ids=lambda c: c.__name__)
def test_former_facade_declares_event_log_mapping(cls):
    assert_declares_event_log_mapping(cls().get_default_column_mapping({}), who=cls.__name__)


def test_every_auto_connector_declares_a_default_mapping():
    """A connector that auto-maps AND claims to produce an event log must give a
    default case/activity/timestamp mapping for an unconfigured (default-resource)
    connector — otherwise its output is a raw, un-mineable dump (the facade bug)."""
    offenders = []
    for meta in connector_registry():
        if meta.mapping_mode != "auto" or not meta.produces_event_log:
            continue
        mapping = get_connector_class(meta.id)().get_default_column_mapping({}) or {}
        if not all(
            mapping.get(k) for k in ("case_id_column", "activity_column", "timestamp_column")
        ):
            offenders.append(meta.id)
    assert not offenders, f"auto connectors with no default event-log mapping: {offenders}"
