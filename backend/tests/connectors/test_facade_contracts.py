"""Contract guard for the "facade" connectors.

Workday, Coupa, Ariba and Oracle Fusion currently page one REST endpoint and
dump raw (often nested) JSON to parquet with NO event-log semantics: they do
not declare a default case/activity/timestamp mapping, so their output is not
mineable. This test encodes the contract every connector must meet and is
expected to FAIL until Phase 6 gives these connectors a real transform.

It is marked ``xfail(strict=True)`` so that the day Phase 6 makes a facade
declare its mapping, the test XPASSES, strict-mode flips it to a failure, and
we are forced to remove the xfail marker for that connector — i.e. the spec is
self-retiring.
"""

from __future__ import annotations

import pytest

from app.services.connectors.ariba_connector import AribaConnector
from app.services.connectors.coupa_connector import CoupaConnector
from app.services.connectors.oracle_fusion_connector import OracleFusionConnector
from app.services.connectors.workday_connector import WorkdayConnector

from .event_log_assertions import assert_declares_event_log_mapping

FACADES = [WorkdayConnector, CoupaConnector, AribaConnector, OracleFusionConnector]


@pytest.mark.xfail(
    strict=True,
    reason="Phase 6: facade connectors must declare a case/activity/timestamp "
    "mapping (or produces_event_log=False). Remove this marker per connector "
    "as Phase 6 lands its transform.",
)
@pytest.mark.parametrize("cls", FACADES, ids=lambda c: c.__name__)
def test_facade_declares_event_log_mapping(cls):
    mapping = cls().get_default_column_mapping({})
    assert_declares_event_log_mapping(mapping, who=cls.__name__)
