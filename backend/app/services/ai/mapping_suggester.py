"""LLM-assisted column-mapping suggestion for connector / upload onboarding.

Given a source table's column profile (the shape ``log_builder.preview_table``
returns: name, dtype, kind, nunique, null_ratio) plus a few sample values, this
proposes the process-mining column mapping — which column is the ``case_id``,
``activity``, ``timestamp`` and ``resource`` — with a confidence and a one-line
rationale, so connector onboarding is plug-and-play instead of a manual pick.

Design:
  * A deterministic heuristic (column kind + name hints) always runs and is the
    answer when no LLM is configured — so the feature degrades gracefully.
  * When an LLM is configured, it disambiguates the semantic calls a regex
    can't (is ``status`` the activity? which of three timestamps starts the
    case?). It is forced to a cheap, reliable model — **gpt-4.1-nano** — for
    this tiny structured task regardless of the app's main LLM model. The LLM's
    answer is validated against the real columns (hallucinated names are
    dropped) and any gap is back-filled from the heuristic.

Override the model with ``MAPPING_LLM_MODEL`` if you prefer another cheap one.
"""

from __future__ import annotations

import json
import logging
import os
import re

from app.services.ai import llm

logger = logging.getLogger(__name__)

# Cheap, reliable structured-JSON model for this classification task. Provider-
# appropriate id: OpenRouter wants the namespaced slug, OpenAI the bare name.
_MAPPING_MODEL_BY_PROVIDER = {
    "openrouter": "openai/gpt-4.1-nano",
    "openai": "gpt-4.1-nano",
}

_REQUIRED = ("case_id_column", "activity_column", "timestamp_column")
_DATETIME_KINDS = {"datetime", "datetime_like"}

# Name hints per role (substring match on the lowercased column name).
_CASE_HINTS = ("case", "id", "order", "number", "ticket", "key", "document",
               "incident", "claim", "request", "po", "invoice")
_ACTIVITY_HINTS = ("activity", "status", "event", "type", "state", "action",
                   "stage", "step", "operation", "task", "phase")
_TIME_HINTS = ("timestamp", "time", "date", "created", "start", "occurred", "at")
_RESOURCE_HINTS = ("resource", "user", "owner", "assign", "agent", "clerk",
                   "employee", "rep", "handler", "operator", "author", "by")


def _mapping_model() -> str | None:
    override = os.getenv("MAPPING_LLM_MODEL", "").strip()
    if override:
        return override
    return _MAPPING_MODEL_BY_PROVIDER.get(llm.current_provider())


def _has(name: str, hints: tuple[str, ...]) -> bool:
    low = str(name).lower()
    return any(h in low for h in hints)


def _heuristic_mapping(columns: list[dict]) -> dict:
    """A sensible default mapping from column kinds + name hints (no LLM)."""
    cols = [c for c in columns if c.get("name")]

    # timestamp: a datetime-ish column, preferring time-named ones.
    ts_cands = [c for c in cols if c.get("kind") in _DATETIME_KINDS]
    ts = next((c for c in ts_cands if _has(c["name"], _TIME_HINTS)), None) or (
        ts_cands[0] if ts_cands else None
    )

    # case id: highest-cardinality non-timestamp column, low null, id-ish name.
    non_ts = [c for c in cols if c.get("kind") not in _DATETIME_KINDS]
    id_named = [c for c in non_ts if _has(c["name"], _CASE_HINTS)]
    case_pool = id_named or non_ts
    case = max(
        case_pool,
        key=lambda c: (int(c.get("nunique") or 0), -float(c.get("null_ratio") or 0)),
        default=None,
    )

    # activity: a categorical text column (not the case), activity-ish name or
    # modest cardinality.
    text_cols = [c for c in cols if c.get("kind") == "text" and c is not case]
    act_named = [c for c in text_cols if _has(c["name"], _ACTIVITY_HINTS)]
    act_pool = act_named or [
        c for c in text_cols if 1 < int(c.get("nunique") or 0) <= 100
    ]
    activity = act_pool[0] if act_pool else None

    # resource: name hint only (low precision otherwise).
    resource = next((c for c in cols if _has(c["name"], _RESOURCE_HINTS)), None)

    name = lambda c: c["name"] if c else None  # noqa: E731
    return {
        "case_id_column": name(case),
        "activity_column": name(activity),
        "timestamp_column": name(ts),
        "resource_column": name(resource),
        "object_type_columns": [],
        "confidence": 0.5 if (case and ts) else 0.3,
        "rationale": "Heuristic guess from column types and names.",
    }


def _extract_json(text: str) -> dict:
    """Parse a JSON object from an LLM response, tolerating ```json fences."""
    if not text:
        raise ValueError("empty response")
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    blob = fenced.group(1) if fenced else None
    if blob is None:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise ValueError("no JSON object in response")
        blob = text[start : end + 1]
    data = json.loads(blob)
    if not isinstance(data, dict):
        raise ValueError("response JSON is not an object")
    return data


_SYSTEM = (
    "You are a process-mining data engineer. Given a source table's columns "
    "(name, type, distinct-value count, null ratio) and a few sample values, "
    "identify the columns needed to build an event log. Reply with ONLY a JSON "
    "object, no prose, with these keys:\n"
    '  "case_id_column": the column identifying the process instance (a stable, '
    "high-cardinality id);\n"
    '  "activity_column": the column naming what happened (categorical, e.g. a '
    "status/step), or null if none fits;\n"
    '  "timestamp_column": the column for when the event occurred;\n'
    '  "resource_column": who performed it, or null;\n'
    '  "object_type_columns": array of entity-id columns for object-centric '
    "logs (e.g. customer_id, order_id, item_id), or [];\n"
    '  "confidence": a number 0-1;\n'
    '  "rationale": one short sentence.\n'
    "Only use column names that appear in the input."
)


def _llm_mapping(columns: list[dict], sample_rows: list[dict] | None,
                 connector_type: str | None) -> dict:
    profile = [
        {
            "name": c.get("name"),
            "type": c.get("kind"),
            "dtype": c.get("dtype"),
            "distinct": c.get("nunique"),
            "null_ratio": c.get("null_ratio"),
        }
        for c in columns
        if c.get("name")
    ]
    samples: dict[str, list[str]] = {}
    for c in columns[:40]:
        name = c.get("name")
        if not name:
            continue
        vals: list[str] = []
        for row in (sample_rows or [])[:5]:
            v = row.get(name)
            if v not in (None, ""):
                vals.append(str(v)[:60])
        if vals:
            samples[name] = vals[:3]

    user = json.dumps(
        {"connector_type": connector_type, "columns": profile, "samples": samples},
        default=str,
    )[:6000]
    text = llm.complete(_SYSTEM, user, temperature=0.0, model=_mapping_model())
    return _extract_json(text)


def suggest_mapping(
    columns: list[dict],
    sample_rows: list[dict] | None = None,
    connector_type: str | None = None,
) -> dict:
    """Suggest a case/activity/timestamp/resource mapping for a source table.

    ``columns`` is ``preview_table``-shaped: ``[{name, dtype, kind, nunique,
    null_ratio}, ...]``. Returns the mapping plus ``object_type_columns``,
    ``confidence`` (0-1), ``rationale`` and ``source`` ("llm" | "heuristic").
    Never raises — falls back to the heuristic on any LLM failure.
    """
    columns = [c for c in (columns or []) if isinstance(c, dict) and c.get("name")]
    if not columns:
        return {
            "case_id_column": None, "activity_column": None,
            "timestamp_column": None, "resource_column": None,
            "object_type_columns": [], "confidence": 0.0,
            "rationale": "No columns provided.", "source": "heuristic",
        }

    heuristic = _heuristic_mapping(columns)
    if not llm.is_llm_configured():
        return {**heuristic, "source": "heuristic"}

    try:
        suggestion = _llm_mapping(columns, sample_rows, connector_type)
    except Exception as e:
        logger.warning("mapping suggester: LLM failed (%s) — using heuristic", e)
        return {**heuristic, "source": "heuristic"}

    valid = {c["name"] for c in columns}
    out: dict = {}
    for key in ("case_id_column", "activity_column", "timestamp_column", "resource_column"):
        val = suggestion.get(key)
        out[key] = val if (isinstance(val, str) and val in valid) else None
    out["object_type_columns"] = [
        c for c in (suggestion.get("object_type_columns") or []) if c in valid
    ]
    # Back-fill any missing required field from the heuristic so the result is
    # always usable even if the model omitted one.
    for key in _REQUIRED:
        if not out.get(key):
            out[key] = heuristic.get(key)
    try:
        conf = float(suggestion.get("confidence"))
    except (TypeError, ValueError):
        conf = 0.6
    out["confidence"] = max(0.0, min(1.0, conf))
    out["rationale"] = str(suggestion.get("rationale") or "")[:300]
    out["source"] = "llm"
    return out
