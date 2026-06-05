"""Tier-0 unit tests: pure transform/parse logic, no I/O.

Covers the connector logic that is most worth pinning because it is security-
sensitive (the DB identifier guard) or is the only real raw->event-log
transform we have today (Jira issue -> events). Runs in milliseconds.
"""

from __future__ import annotations

import pandas as pd
import pytest

from app.services.connectors.database_connector import _assert_safe_ident
from app.services.connectors.jira_connector import JiraConnector

from .event_log_assertions import assert_valid_event_log


# ─── Jira: issue -> event rows ────────────────────────────────────────────────


def _issue(key="PROJ-1", with_changelog=True, resolved=True):
    issue = {
        "key": key,
        "fields": {
            "issuetype": {"name": "Bug"},
            "priority": {"name": "High"},
            "creator": {"displayName": "Alice"},
            "created": "2026-01-01T09:00:00.000+0000",
            "assignee": {"displayName": "Bob"},
            "resolutiondate": "2026-01-03T17:00:00.000+0000" if resolved else None,
        },
    }
    if with_changelog:
        issue["changelog"] = {
            "histories": [
                {
                    "author": {"displayName": "Bob"},
                    "created": "2026-01-02T10:00:00.000+0000",
                    "items": [
                        {"field": "status", "toString": "In Progress"},
                        {"field": "assignee", "toString": "Bob"},  # ignored: not status
                    ],
                },
                {
                    "author": {"displayName": "Bob"},
                    "created": "2026-01-03T16:00:00.000+0000",
                    "items": [{"field": "status", "toString": "Done"}],
                },
            ]
        }
    return issue


def test_jira_extract_events_full_lifecycle():
    events = JiraConnector._extract_events(_issue())
    activities = [e["Activity"] for e in events]
    # Created + 2 status transitions + Resolved; the non-status changelog item
    # ("assignee") must be dropped.
    assert activities == ["Created", "In Progress", "Done", "Resolved"]
    assert all(e["Issue Key"] == "PROJ-1" for e in events)
    assert events[0]["Resource"] == "Alice"  # creator
    assert events[-1]["Resource"] == "Bob"  # assignee on resolution

    df = pd.DataFrame(events)
    assert_valid_event_log(
        df,
        case_col="Issue Key",
        activity_col="Activity",
        ts_col="Timestamp",
        min_cases=1,
        min_activities=3,
    )


def test_jira_extract_events_minimal_issue():
    # No changelog, never resolved -> exactly one Created event.
    events = JiraConnector._extract_events(
        _issue(with_changelog=False, resolved=False)
    )
    assert len(events) == 1
    assert events[0]["Activity"] == "Created"


def test_jira_default_mapping_matches_extracted_columns():
    mapping = JiraConnector().get_default_column_mapping({})
    cols = set(JiraConnector._extract_events(_issue())[0].keys())
    for key in ("case_id_column", "activity_column", "timestamp_column"):
        assert mapping[key] in cols


# ─── Database: SQL identifier injection guard ─────────────────────────────────


@pytest.mark.parametrize(
    "value",
    ["events", "public.events", "schema_1.table_2", "_private", "Orders"],
)
def test_assert_safe_ident_accepts_plain_identifiers(value):
    assert _assert_safe_ident(value, "table name") == value


@pytest.mark.parametrize(
    "value",
    [
        "events; DROP TABLE users",
        "1=1 UNION SELECT username,password,NULL FROM users--",
        'a"b',
        "has space",
        "schema.table.extra",  # only one dot allowed
        "table--comment",
        "",
        "9starts_with_digit",
    ],
)
def test_assert_safe_ident_rejects_injection(value):
    with pytest.raises(ValueError):
        _assert_safe_ident(value, "table name")


def test_assert_safe_ident_rejects_non_string():
    with pytest.raises(ValueError):
        _assert_safe_ident(123, "table name")  # type: ignore[arg-type]


# ─── Meta-test: the event-log validator actually catches bad logs ─────────────


def test_assert_valid_event_log_catches_null_case(synthetic_event_log_df):
    # Sanity: the clean fixture passes.
    assert_valid_event_log(
        synthetic_event_log_df,
        case_col="case_id",
        activity_col="activity",
        ts_col="timestamp",
        min_cases=5,
        min_activities=3,
    )
    # Inject a null case id -> must raise.
    bad = synthetic_event_log_df.copy()
    bad.loc[0, "case_id"] = None
    with pytest.raises(AssertionError):
        assert_valid_event_log(
            bad, case_col="case_id", activity_col="activity", ts_col="timestamp"
        )


def test_assert_valid_event_log_catches_unparseable_timestamp(synthetic_event_log_df):
    bad = synthetic_event_log_df.copy()
    bad.loc[0, "timestamp"] = "not-a-date"
    with pytest.raises(AssertionError):
        assert_valid_event_log(
            bad, case_col="case_id", activity_col="activity", ts_col="timestamp"
        )
