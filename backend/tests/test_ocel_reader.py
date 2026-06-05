"""Regression test for OCEL reading + pm4py version drift.

The demo's "OCEL not found" outage was caused by ``app.services.ocel_store._read_ocel``
silently failing on the shipped OCEL 2.0 example log. Two things conspired:

  1. pm4py was UNPINNED, and the optional ``ocpa`` dependency hard-pins
     ``pm4py==2.2.32`` — a release that cannot read OCEL 2.0 at all (its
     reader returns ``None``). Image rebuilds drifted onto it.
  2. ``_read_ocel`` called ``pm4py.read_ocel_json`` as a fallback, which does
     not exist on older pm4py (``AttributeError``) and *raises* on OCEL 2.0
     input on newer pm4py — so the fallback never recovered; it just bubbled
     up as a 404 ("OCEL not found. Upload or convert a log first.").

These tests pin the two invariants that prevent a recurrence:
  * the shipped OCEL 2.0 example parses into a usable object via ``_read_ocel``; and
  * ``_read_ocel`` raises a clean ``ValueError`` (never ``AttributeError``) when
    no reader can parse a file — i.e. the reader chain degrades gracefully.

If pm4py is ever downgraded below OCEL-2.0 support, the first test fails loudly
instead of the demo silently 404-ing.
"""

from pathlib import Path

import pytest

from app.services.ocel_store import _BoundedOcelStore, _read_ocel

# docs/examples/ lives at the repo root, two levels above backend/tests/.
_EXAMPLE_OCEL = (
    Path(__file__).resolve().parents[2] / "docs" / "examples" / "container_logistics.json"
)


@pytest.mark.skipif(not _EXAMPLE_OCEL.exists(), reason="example OCEL not present")
def test_reads_shipped_ocel2_example():
    """The container-logistics OCEL 2.0 log must parse into a usable object.

    This is exactly the file the demo OCPM page loads; if pm4py can't read it,
    every OCPM request 404s.
    """
    import pm4py

    ocel = _read_ocel(str(_EXAMPLE_OCEL))
    assert ocel is not None

    object_types = list(pm4py.ocel_get_object_types(ocel))
    assert len(object_types) > 0, "OCEL 2.0 reader produced no object types"

    # Sanity-check the headline counts the demo surfaces are non-trivial.
    assert len(ocel.get_extended_table()) > 0


def test_unreadable_file_raises_valueerror_not_attributeerror(tmp_path):
    """A file no reader can parse must raise a clean ValueError.

    The original bug let an ``AttributeError`` from a missing pm4py function
    escape; the hardened reader must catch reader failures and surface a
    domain error instead.
    """
    junk = tmp_path / "not-really.jsonocel"
    junk.write_text("{ this is not valid ocel json ")

    with pytest.raises(ValueError):
        _read_ocel(str(junk))


def test_unsupported_extension_raises_valueerror(tmp_path):
    bad = tmp_path / "log.txt"
    bad.write_text("irrelevant")
    with pytest.raises(ValueError):
        _read_ocel(str(bad))


def test_bounded_store_clear_and_len():
    """``purge_demo_data`` calls ``_ocel_store.clear()``; the bounded store
    must actually support it (it previously had no such method, so the call
    raised AttributeError and was silently swallowed, leaking stale entries)."""
    store = _BoundedOcelStore(maxsize=4)
    store["a"] = object()
    store["b"] = object()
    assert len(store) == 2
    store.clear()
    assert len(store) == 0
    assert "a" not in store
