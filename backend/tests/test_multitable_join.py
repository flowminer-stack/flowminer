"""Regression tests for the multi-table Log Builder join path.

Guards two audit findings:
  * SECURITY — a join ``right_source`` given as an explicit string path must be
    confined to the staging dir (no path traversal).
  * CORRECTNESS — a non-unique (many-to-many) join key must be rejected, not
    silently fan out and multiply the event-log row count.
"""

import os

import pandas as pd
import pytest

from app.services.etl_executor import _join_table


def _write_csv(path, df):
    df.to_csv(path, index=False)
    return str(path)


def test_join_happy_path_unique_keys(tmp_path):
    left = pd.DataFrame({"order_id": [1, 2, 3], "created_at": ["t1", "t2", "t3"]})
    right_path = _write_csv(tmp_path / "lines.csv",
                            pd.DataFrame({"order_id": [1, 2, 3], "amount": [10, 20, 30]}))
    step = {"type": "join_table", "right_source": right_path,
            "left_on": ["order_id"], "right_on": ["order_id"], "how": "left"}
    out = _join_table(left, step)
    assert len(out) == 3                       # no row explosion
    assert "amount" in out.columns
    assert out.sort_values("order_id")["amount"].tolist() == [10, 20, 30]


def test_join_rejects_many_to_many(tmp_path):
    """Right table with duplicate keys would fan out left rows — must raise."""
    left = pd.DataFrame({"order_id": [1, 2], "created_at": ["t1", "t2"]})
    right_path = _write_csv(tmp_path / "dups.csv",
                            pd.DataFrame({"order_id": [1, 1, 2], "amount": [10, 11, 20]}))
    step = {"type": "join_table", "right_source": right_path,
            "left_on": ["order_id"], "right_on": ["order_id"], "how": "left"}
    with pytest.raises(Exception) as exc:   # ValueError pre-check or pandas MergeError
        _join_table(left, step)
    assert "order_id" in str(exc.value) or "many" in str(exc.value).lower() or "merge" in str(exc.value).lower()


def test_join_missing_left_key_raises(tmp_path):
    left = pd.DataFrame({"order_id": [1, 2]})
    right_path = _write_csv(tmp_path / "r.csv", pd.DataFrame({"k": [1, 2], "v": [9, 9]}))
    step = {"type": "join_table", "right_source": right_path,
            "left_on": ["does_not_exist"], "right_on": ["k"], "how": "left"}
    with pytest.raises(ValueError):
        _join_table(left, step)


def test_join_missing_right_source_raises():
    with pytest.raises(ValueError):
        _join_table(pd.DataFrame({"k": [1]}), {"type": "join_table", "left_on": ["k"]})


def test_staging_path_guard_rejects_traversal(tmp_path, monkeypatch):
    """The API-level staging guard must confine join sources to the staging dir."""
    from fastapi import HTTPException
    from app.config import settings
    from app.api import log_builder as lb

    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path), raising=False)

    # A real file that exists but lives OUTSIDE the _builder_staging subtree.
    outside = tmp_path / "outside.csv"
    outside.write_text("a,b\n1,2\n")
    with pytest.raises(HTTPException):
        lb._validate_staging_path(str(outside))

    # An absolute system path outside the staging dir must be rejected.
    with pytest.raises(HTTPException):
        lb._validate_staging_path("/etc/passwd")

    # A non-existent path under staging must be rejected (404).
    with pytest.raises(HTTPException):
        lb._validate_staging_path(str(tmp_path / "_builder_staging" / "nope.csv"))
