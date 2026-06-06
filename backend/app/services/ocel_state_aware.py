"""State-Aware OCPM pre-processor — enhances OCEL 2.0 with object state.

Implements Kretzschmann, Berti & van der Aalst (EDOC 2025) — adds two
new event types to an existing OCEL frame:

  1. **Object state transition events** — synthetic events emitted
     when an object attribute (the "state column") changes value.
     These appear in the OCEL alongside the originally captured
     business events, marked with a special activity label
     ``{object_type}::state→{new_state}``.
  2. **State-aware annotations** — every regular event is enriched
     with the current state of each related object at the moment the
     event occurred (``state_{object_type}`` attribute).

The result is backward-compatible with OCEL 2.0 readers and unlocks
lifecycle-driven analysis (inventory cycles, patient care pathways,
order lifecycle) on existing logs without custom preprocessing.

This file operates directly on pm4py's OCEL frame structure
(``ocel.events``, ``ocel.objects``, ``ocel.relations``) — the same
tables the rest of the backend uses.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)


def _pick_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    for c in candidates:
        if c in df.columns:
            return c
    # Case-insensitive fallback
    lower = {c.lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


def enrich_ocel_with_state_transitions(
    ocel: Any,
    state_column: str,
    object_type: str | None = None,
    materialize: bool = False,
) -> dict[str, Any]:
    """Enrich an OCEL frame with object-state-transition events.

    Parameters
    ----------
    ocel
        A ``pm4py.objects.ocel.obj.OCEL`` instance.
    state_column
        The attribute column on ``ocel.objects`` that carries the
        state label (e.g., ``"lifecycle_state"``, ``"status"``).
    object_type
        If set, only enrich objects of this type. Otherwise enrich
        all object types that have the state column.
    materialize
        When True, also build and return a NEW OCEL object (under the
        ``materialized_ocel`` key) whose ``events``/``relations`` tables contain
        the synthetic state-transition events and whose existing events carry
        the ``state_{type}`` annotation columns. This is what lets downstream
        OC-DFG / OPerA / improvement analyses actually *see* the transition
        events instead of running on the unenriched log. The key is omitted
        from the JSON-serialisable summary (the caller pops it).

    Returns
    -------
    A dict with:
        ``new_events_count`` — number of state-transition events generated
        ``annotated_events`` — how many existing events were state-annotated
        ``state_transitions`` — the full list of generated transition events
        ``distinct_states`` — unique states observed per object type
        ``method`` — "sa_ocpm_kretzschmann_berti_vanderaalst_2025"
        ``materialized_ocel`` — (only when ``materialize=True`` and at least
            one transition was generated) the enriched pm4py OCEL object
    """
    try:
        objects_df: pd.DataFrame = ocel.objects
        events_df: pd.DataFrame = ocel.events
        relations_df: pd.DataFrame = ocel.relations
    except Exception as e:
        raise ValueError(f"Not a valid OCEL frame: {e}") from e

    oid_col = _pick_column(objects_df, ["ocel:oid", "ocel_oid", "oid"])
    type_col = _pick_column(objects_df, ["ocel:type", "ocel_type", "type"])
    if oid_col is None or type_col is None:
        raise ValueError(
            "OCEL objects table must contain both an oid and a type column"
        )
    if state_column not in objects_df.columns:
        raise ValueError(
            f"State column '{state_column}' not present in OCEL objects table. "
            f"Available: {list(objects_df.columns)}"
        )

    eid_col = _pick_column(events_df, ["ocel:eid", "ocel_eid", "eid"])
    activity_col = _pick_column(events_df, ["ocel:activity", "concept:name", "activity"])
    ts_col = _pick_column(events_df, ["ocel:timestamp", "time:timestamp", "timestamp"])
    if eid_col is None or activity_col is None or ts_col is None:
        raise ValueError("OCEL events table must contain eid, activity, and timestamp columns")

    rel_oid_col = _pick_column(relations_df, ["ocel:oid", "ocel_oid", "oid"])
    rel_eid_col = _pick_column(relations_df, ["ocel:eid", "ocel_eid", "eid"])
    rel_type_col = _pick_column(relations_df, ["ocel:type", "ocel_type", "type"])

    # Restrict to target object type(s)
    if object_type is not None:
        objects_scope = objects_df[objects_df[type_col].astype(str) == object_type]
    else:
        objects_scope = objects_df

    # If objects table is lifecycle-shaped (one row per (oid, state)
    # snapshot), group by oid and order by an ordering column if one
    # exists. Otherwise, infer transitions by joining with the events
    # table via the relations table and ordering by event timestamp.
    ordering_col = _pick_column(
        objects_scope,
        ["ocel:time", "ocel:timestamp", "time:timestamp", "timestamp", "updated_at"],
    )

    state_transitions: list[dict[str, Any]] = []
    distinct_states: dict[str, set[str]] = {}
    current_state_by_oid: dict[str, str] = {}

    if ordering_col is not None and objects_scope[ordering_col].notna().any():
        # Mode 1: temporal object snapshots — vectorised transition detection
        sorted_objs = objects_scope.dropna(subset=[state_column]).sort_values(
            [ordering_col, oid_col]
        )
        # Convert oid/type to str once
        sorted_objs = sorted_objs.assign(
            _oid=sorted_objs[oid_col].astype(str),
            _otype=sorted_objs[type_col].astype(str),
            _state=sorted_objs[state_column].astype(str),
        )
        # Previous state within each object's history
        sorted_objs = sorted_objs.assign(
            _prev_state=sorted_objs.groupby("_oid")["_state"].shift(1)
        )
        # Keep only rows where state actually changed (or is the first snapshot)
        changed = sorted_objs[sorted_objs["_state"] != sorted_objs["_prev_state"]]
        for _, row in changed.iterrows():
            oid = row["_oid"]
            otype = row["_otype"]
            new_state_str = row["_state"]
            prev = None if pd.isna(row["_prev_state"]) else row["_prev_state"]
            distinct_states.setdefault(otype, set()).add(new_state_str)
            state_transitions.append({
                "oid": oid,
                "object_type": otype,
                "from_state": prev,
                "to_state": new_state_str,
                "timestamp": pd.to_datetime(row[ordering_col]),
                "activity": f"{otype}::state→{new_state_str}",
            })
            current_state_by_oid[oid] = new_state_str
    else:
        # Mode 2: object rows are terminal snapshots, so derive
        # "initial state" transitions at the first event of each
        # object (per relations). This still gives SA-OCPM its core
        # feature: every state change that's visible in the log is
        # materialized as an event.
        if rel_oid_col is None or rel_eid_col is None:
            logger.warning(
                "OCEL has no temporal object snapshots and no usable relations; "
                "cannot derive state transitions"
            )
            return {
                "new_events_count": 0,
                "annotated_events": 0,
                "state_transitions": [],
                "distinct_states": {},
                "method": "sa_ocpm_kretzschmann_berti_vanderaalst_2025",
                "note": "No temporal object history available",
            }

        # Join objects → relations → events to assign each object's
        # state to the timestamp of its first related event.
        #
        # pm4py's convert output puts ``ocel:timestamp`` AND ``ocel:type`` on
        # BOTH the relations and the objects/events tables, so an un-renamed
        # merge would suffix the collisions to ``_x``/``_y`` (or ``_rel``/
        # ``_obj``) and the subsequent reads/sorts would KeyError on the now-
        # absent original names. We rename every column we read off the
        # events/objects side to private, collision-free names BEFORE merging
        # so the reads below never depend on pandas' suffix behaviour.
        merged = relations_df.merge(
            events_df[[eid_col, ts_col]].rename(columns={ts_col: "_ev_ts"}),
            on=eid_col,
            how="inner",
        ).merge(
            objects_scope[[oid_col, type_col, state_column]].rename(
                columns={
                    oid_col: "_obj_oid",
                    type_col: "_obj_type",
                    state_column: "_obj_state",
                }
            ),
            left_on=rel_oid_col,
            right_on="_obj_oid",
            how="inner",
        )
        # Pick the earliest event per object as the "state appears" moment
        first_events = merged.sort_values("_ev_ts").drop_duplicates(
            subset=[rel_oid_col], keep="first"
        )
        for _, row in first_events.iterrows():
            oid = str(row[rel_oid_col])
            otype = str(row["_obj_type"])
            new_state = row["_obj_state"]
            if pd.isna(new_state):
                continue
            new_state_str = str(new_state)
            distinct_states.setdefault(otype, set()).add(new_state_str)
            state_transitions.append({
                "oid": oid,
                "object_type": otype,
                "from_state": None,
                "to_state": new_state_str,
                "timestamp": pd.to_datetime(row["_ev_ts"]) - timedelta(microseconds=1),
                "activity": f"{otype}::state={new_state_str}",
            })
            current_state_by_oid[oid] = new_state_str

    # State-aware annotation of regular events: for each event, look
    # up the current state (as of the event's timestamp) of every
    # object related to it, and write a new ``state_{type}`` column.
    annotated_events = 0
    if rel_oid_col and rel_eid_col:
        # Build a time-indexed state series per object for the merge
        state_by_oid: dict[str, list[tuple[pd.Timestamp, str]]] = {}
        for tr in state_transitions:
            state_by_oid.setdefault(tr["oid"], []).append((tr["timestamp"], tr["to_state"]))
        for oid in state_by_oid:
            state_by_oid[oid].sort(key=lambda x: x[0])

        def _state_at(oid: str, ts) -> str | None:
            history = state_by_oid.get(oid)
            if not history:
                return None
            last = None
            ts_parsed = pd.to_datetime(ts)
            for when, state in history:
                if when <= ts_parsed:
                    last = state
                else:
                    break
            return last

        # We don't mutate the OCEL frame in place here — instead we
        # return the annotations keyed by (event_id, object_type) so
        # callers can choose to materialize them as new columns.

        # Prebuild O(E) lookup: eid (str) → timestamp
        eid_to_ts: dict[str, Any] = {
            str(eid_val): ts_val
            for eid_val, ts_val in zip(
                events_df[eid_col], events_df[ts_col]
            )
        }
        # Prebuild O(O) lookup: oid (str) → object type (str)
        oid_to_type: dict[str, str] = {
            str(oid_val): str(type_val)
            for oid_val, type_val in zip(
                objects_df[oid_col], objects_df[type_col]
            )
        }

        event_state_annotations: dict[str, dict[str, str]] = {}
        for _, row in relations_df.iterrows():
            eid = str(row[rel_eid_col])
            oid = str(row[rel_oid_col])
            # O(1) timestamp lookup (was O(E) linear scan per relation)
            ts_val = eid_to_ts.get(eid)
            if ts_val is None:
                continue
            state = _state_at(oid, ts_val)
            if state is None:
                continue
            otype = None
            if rel_type_col and rel_type_col in relations_df.columns:
                otype = str(row[rel_type_col])
            if otype is None:
                # O(1) object-type lookup (was O(O) linear scan per relation)
                otype = oid_to_type.get(oid)
            if otype is None:
                continue
            event_state_annotations.setdefault(eid, {})[f"state_{otype}"] = state
            annotated_events += 1
    else:
        event_state_annotations = {}

    result: dict[str, Any] = {
        "new_events_count": len(state_transitions),
        "annotated_events": annotated_events,
        "state_transitions": [
            {
                **{k: v for k, v in tr.items() if k != "timestamp"},
                "timestamp": tr["timestamp"].isoformat() if hasattr(tr["timestamp"], "isoformat") else str(tr["timestamp"]),
            }
            for tr in state_transitions[:500]
        ],
        "distinct_states": {k: sorted(v) for k, v in distinct_states.items()},
        "annotations_by_event": event_state_annotations,
        "method": "sa_ocpm_kretzschmann_berti_vanderaalst_2025",
        "state_column": state_column,
        "object_type_filter": object_type,
    }

    if materialize and state_transitions:
        try:
            result["materialized_ocel"] = _materialize_enriched_ocel(
                ocel,
                events_df=events_df,
                objects_df=objects_df,
                relations_df=relations_df,
                eid_col=eid_col,
                activity_col=activity_col,
                ts_col=ts_col,
                rel_oid_col=rel_oid_col,
                rel_eid_col=rel_eid_col,
                rel_type_col=rel_type_col,
                oid_col=oid_col,
                type_col=type_col,
                state_transitions=state_transitions,
                event_state_annotations=event_state_annotations,
            )
        except Exception as e:  # never fail the whole request on materialisation
            logger.warning("State-aware materialisation failed; returning summary only: %s", e)

    return result


def _materialize_enriched_ocel(
    ocel: Any,
    *,
    events_df: pd.DataFrame,
    objects_df: pd.DataFrame,
    relations_df: pd.DataFrame,
    eid_col: str,
    activity_col: str,
    ts_col: str,
    rel_oid_col: str | None,
    rel_eid_col: str | None,
    rel_type_col: str | None,
    oid_col: str,
    type_col: str,
    state_transitions: list[dict[str, Any]],
    event_state_annotations: dict[str, dict[str, str]],
) -> Any:
    """Build a NEW pm4py OCEL with the synthetic state-transition events
    appended and the existing events annotated with object state.

    The synthetic events are regular OCEL events (distinguished activity name
    ``{type}::state…``) related to the single object whose state changed, so
    the result is backward-compatible with every OCEL 2.0 reader and shows up
    in OC-DFG / OPerA / improvement runs. Returns a brand-new ``OCEL`` instance
    (the input frames are never mutated in place).
    """
    from pm4py.objects.ocel.obj import OCEL

    new_events = events_df.copy()
    new_objects = objects_df.copy()
    new_relations = relations_df.copy()

    rel_has_activity = rel_eid_col is not None and "ocel:activity" in new_relations.columns
    rel_has_ts = rel_eid_col is not None and "ocel:timestamp" in new_relations.columns
    rel_has_qual = rel_eid_col is not None and "ocel:qualifier" in new_relations.columns

    # Stable, collision-free ids for the synthetic events.
    existing_eids = {str(v) for v in new_events[eid_col].tolist()}
    event_rows: list[dict[str, Any]] = []
    relation_rows: list[dict[str, Any]] = []
    for idx, tr in enumerate(state_transitions):
        eid = f"state::{idx}"
        while eid in existing_eids:
            eid = f"state::{idx}::{len(existing_eids)}"
        existing_eids.add(eid)

        ts = tr["timestamp"]
        activity = tr["activity"]
        event_rows.append({eid_col: eid, activity_col: activity, ts_col: ts})

        if rel_oid_col is not None and rel_eid_col is not None:
            rel_row: dict[str, Any] = {
                rel_eid_col: eid,
                rel_oid_col: tr["oid"],
            }
            if rel_type_col is not None:
                rel_row[rel_type_col] = tr["object_type"]
            if rel_has_activity:
                rel_row["ocel:activity"] = activity
            if rel_has_ts:
                rel_row["ocel:timestamp"] = ts
            if rel_has_qual:
                rel_row["ocel:qualifier"] = "state_transition"
            relation_rows.append(rel_row)

    if event_rows:
        new_events = pd.concat(
            [new_events, pd.DataFrame(event_rows)], ignore_index=True
        )
    if relation_rows:
        new_relations = pd.concat(
            [new_relations, pd.DataFrame(relation_rows)], ignore_index=True
        )

    # Annotate existing events with the current state of each related object.
    # event_state_annotations: eid -> {state_<type>: state}. Materialise each
    # distinct annotation key as a column on the events table.
    if event_state_annotations:
        ann_cols: set[str] = set()
        for ann in event_state_annotations.values():
            ann_cols.update(ann.keys())
        eid_str = new_events[eid_col].astype(str)
        for col in sorted(ann_cols):
            new_events[col] = eid_str.map(
                lambda e, _c=col: event_state_annotations.get(e, {}).get(_c)
            )

    # Normalise timestamps and ordering on the combined events table.
    new_events[ts_col] = pd.to_datetime(new_events[ts_col], errors="coerce", utc=True)
    new_events = new_events.sort_values(ts_col).reset_index(drop=True)
    if rel_has_ts:
        new_relations["ocel:timestamp"] = pd.to_datetime(
            new_relations["ocel:timestamp"], errors="coerce", utc=True
        )

    enriched = OCEL(
        events=new_events,
        objects=new_objects,
        relations=new_relations,
        globals=getattr(ocel, "globals", None),
    )
    return enriched
