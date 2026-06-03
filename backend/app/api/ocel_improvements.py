"""
OCPM improvement-report + LLM-narration router.

Split out of ``app.api.ocel`` (which kept the structural / analytical
OCEL query routes). This module owns the three improvement-report
endpoints and their helper symbols:

  * GET  /ocel/{ocel_id}/improvement-report
  * POST /ocel/{ocel_id}/improvement-report/narrate
  * POST /ocel/{ocel_id}/improvement-report/explain

The router mounts at the SAME ``/api/v1/ocel`` prefix as ``app.api.ocel``
(FastAPI allows multiple routers per prefix), so every route path and
response shape is byte-identical to before the split.

Shared OCEL access/store helpers (``_assert_ocel_access``,
``_get_ocel_or_404``, ``_compute_ocel_structural_insights``) still live in
``app.api.ocel`` and are imported lazily inside the handlers to avoid an
import-time cycle (``app.api.ocel`` imports the report/narrate handlers
from here for its ``/report`` HTML export).

External importers note: ``scripts/tune_ocpm_narrative.py`` historically
imported ``ImprovementReportResponse``, ``_NARRATE_SYSTEM_PROMPT`` and
``_summarise_findings_for_prompt`` from ``app.api.ocel``. Those symbols now
live here but remain re-exported from ``app.api.ocel`` for backward
compatibility.
"""

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from app.database import get_db
from app.models import EventLog, User
from app.api.deps import get_current_active_user

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Endpoint — GET /ocel/{ocel_id}/improvement-report
# Aggregates every insight available for an OCEL into one structured page.
# ---------------------------------------------------------------------------


class ImprovementFinding(BaseModel):
    severity: str  # critical / warning / info
    category: str
    title: str
    description: str
    recommendation: str | None = None
    metric_value: float | None = None
    impact_estimate: str | None = None
    related_activities: list[str] | None = None
    # The object type this finding came from (None for OCEL-level and
    # cross-object findings).
    object_type: str | None = None


class ObjectTypeSection(BaseModel):
    object_type: str
    total_cases: int
    total_events: int
    total_activities: int
    critical_count: int
    warning_count: int
    findings: list[ImprovementFinding]
    error: str | None = None


class ImprovementReportResponse(BaseModel):
    summary: str
    ocel_event_count: int
    ocel_object_count: int
    object_type_count: int
    total_findings: int
    critical_count: int
    warning_count: int
    ocel_findings: list[ImprovementFinding]
    per_object_type: list[ObjectTypeSection]
    cross_object_findings: list[ImprovementFinding]


# Cap per-object-type flattening cost: a large OCEL with 15 object
# types would otherwise run 15 full generate_insights passes. Sort
# object types by object count desc and take the top N.
_OCPM_MAX_OBJECT_TYPES = 8

# Skip object types with fewer than this many events — their
# flattened logs are too small to yield meaningful insights and
# just add noise to the report.
_OCPM_MIN_FLATTEN_EVENTS = 20

# If an object type has more than this many events per object (case),
# it's almost certainly a RESOURCE (shared asset used across many work
# units) and not a BUSINESS OBJECT (one-shot lifecycle). Examples:
# forklifts, trucks, and machines typically have thousands of events
# per unit; vehicles used for multiple shipments show dozens of events
# per unit; orders and shipments have a handful.
#
# Threshold notes
# ---------------
# Real-world business-object lifecycles rarely exceed ~15 events:
#   * order: 3-8 events (created, approved, packed, shipped, delivered)
#   * container: ~13 events through a warehouse lifecycle
#   * insurance claim: 5-20 events (filed, triaged, investigated, paid)
#   * patient visit: 5-15 events (admit, treat, discharge)
#
# Resources show 20+ events per case because they are reused across
# many work units within the log window:
#   * vehicle: 20-50 events per unit over a month
#   * machine: hundreds to thousands of cycles
#   * forklift / truck: thousands of moves
#
# A threshold of 20 catches vehicle-like borderline cases without
# sweeping up legitimate long-lifecycle business objects.
#
# The generic insight engine is built for business objects — it treats
# "activity repeats in a case" as rework, and "time between activities"
# as waiting waste. Neither of those interpretations is valid for a
# resource doing its normal job many times a day. We skip case-based
# insights entirely for resource-like object types and emit a single
# info-level marker instead, so the process owner still knows the
# perspective was examined without being told nonsense like "100% of
# forklift cases repeat work".
_OCPM_RESOURCE_EVENTS_PER_CASE = 20.0


# Activity name keywords that typically describe a LEGITIMATE WAIT —
# a duration that looks like a process bottleneck but is actually a
# normal business pattern the analyzer mis-labels as waste:
#
#   * inventory dwell (items sitting in stock awaiting demand)
#   * work-in-progress buffers (items curing, cooling, aging)
#   * approval or review queues (documents awaiting sign-off)
#   * legitimate waiting states (patient recovery, observation,
#     document clearance)
#   * resource reservation / allocation holds
#   * asynchronous external dependencies
#
# This list is intentionally broad and cross-domain — warehousing,
# manufacturing, healthcare, finance, customer service — because the
# false-positive tax for the process owner is high. If a legitimate
# wait shows up in a brief framed as "cut this in half to save X
# days", the reader will chase the wrong optimization.
#
# This is a fast safety net. The narrator prompt ALSO does a
# semantic critical-thinking pass using the LLM's broader domain
# knowledge, so anything this list misses should still get caught.
_DWELL_ACTIVITY_KEYWORDS = (
    # warehousing / logistics
    "place in stock", "place on stock", "in stock", "in storage",
    "store", "storage", "warehouse", "stockpile", "yard",
    "park", "parked", "dock",
    # manufacturing / process industry
    "cure", "curing", "dry", "drying", "cool", "cooling",
    "age", "aging", "wip", "in-process", "in process",
    "batch", "fermentation", "settle", "settling",
    # review / approval / governance
    "approval", "approve", "review", "awaiting review",
    "pending", "sign-off", "sign off", "signoff", "clearance",
    "audit", "check in", "check-in",
    # healthcare / services
    "admit", "admitted", "recovery", "observation",
    "triage", "discharge", "monitoring", "consult",
    # generic wait / queue / hold / buffer
    "hold", "holding", "on hold", "buffer", "backlog",
    "queue", "queued", "await", "awaiting", "wait for",
    "escalat", "deferred", "parked", "on ice",
    "scheduled", "reserved", "allocated",
)


def _is_resource_object_type(events: int, cases: int) -> bool:
    """Heuristic: a reusable resource shows thousands of events per
    case because the same asset handles many work units over time.

    Business objects show ~1-20 events per case (a case is the
    lifecycle of one order / shipment / container).
    """
    if cases <= 0:
        return False
    return (events / cases) > _OCPM_RESOURCE_EVENTS_PER_CASE


def _looks_like_legitimate_wait(name: str | None) -> bool:
    """Return True when the activity name matches a "legitimate wait"
    keyword (see ``_DWELL_ACTIVITY_KEYWORDS``) — i.e. a duration that
    is probably a normal business pattern (dwell, queue, approval,
    curing, review) rather than reducible process waste.

    Case-insensitive, substring-based, intentionally generous on
    false positives because the cost of quoting a bogus "cut the wait
    in half" fix line to the reader is much higher than the cost of
    mentioning a real wait as context.
    """
    if not name:
        return False
    lowered = name.lower()
    return any(kw in lowered for kw in _DWELL_ACTIVITY_KEYWORDS)


def _rewrite_legitimate_wait_finding(
    finding: "ImprovementFinding",
) -> "ImprovementFinding":
    """Reshape a waiting_time / bottleneck finding that's almost
    certainly a legitimate wait pattern so the narrator can't repeat
    the misleading ``impact_estimate``.

    The re-write:
      * drops the severity to ``info`` (was critical/warning)
      * changes the category to ``legitimate_wait``
      * drops ``impact_estimate`` — cutting a legitimate wait in half
        isn't a process win, it's a different operational trade-off
        (inventory / batch / approval policy).
      * rewrites ``recommendation`` to tell the narrator explicitly
        that this is NOT reducible process waste.
      * leaves the raw duration in the description so the reader can
        still see the number, just under honest framing.
    """
    recommendation = (
        "This duration is likely a legitimate wait pattern "
        "(inventory dwell, batch window, approval / review queue, "
        "curing / cooling, observation / recovery, or scheduled "
        "external dependency) rather than reducible process waste. "
        "Treat the number as context for capacity planning, not as "
        "a backlog to shrink. Only investigate if the distribution "
        "has a long tail that suggests forgotten or aged cases."
    )
    return ImprovementFinding(
        severity="info",
        category="legitimate_wait",
        title=finding.title,
        description=finding.description,
        recommendation=recommendation,
        metric_value=finding.metric_value,
        impact_estimate=None,
        related_activities=finding.related_activities,
        object_type=finding.object_type,
    )


@router.get("/{ocel_id}/improvement-report", response_model=ImprovementReportResponse)
async def get_ocpm_improvement_report(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Aggregate every insight available for an OCEL into one page.

    The response is built in three passes:

      1. OCEL-level structural rules (reuses ``_compute_ocel_structural_insights``).
      2. Per-object-type flatten → ``mining_engine.generate_insights``,
         capped at ``_OCPM_MAX_OBJECT_TYPES`` by object count so a log
         with a dozen auxiliary object types doesn't explode the runtime.
      3. Cross-object pattern detection: activities that show up as
         bottlenecks or rework hotspots in multiple object types. These
         are the findings you can only see by comparing flattened
         perspectives, and they're the whole reason this report exists.

    Everything is cached under ``improvement_report`` in the event-log
    cache so the page can reload fast once it's been computed.
    """
    import pandas as pd
    import pm4py

    from app.api._mining_deps import _get_cached, _set_cached
    from app.services.mining_engine import mining_engine
    from app.api.ocel import (
        _assert_ocel_access,
        _get_ocel_or_404,
        _compute_ocel_structural_insights,
    )

    await _assert_ocel_access(ocel_id, db, current_user)
    ocel_obj = _get_ocel_or_404(ocel_id)

    cached = _get_cached(ocel_id, "improvement_report")
    if cached is not None:
        return ImprovementReportResponse(**cached)

    # ── 1. OCEL-level findings ───────────────────────────────────────
    ocel_raw, meta = _compute_ocel_structural_insights(ocel_obj)
    ocel_findings = [
        ImprovementFinding(
            severity=i.get("severity", "info"),
            category=i.get("category", "ocel"),
            title=i.get("title", ""),
            description=i.get("description", ""),
            recommendation=i.get("recommendation"),
            metric_value=i.get("metric_value"),
            related_activities=i.get("related_activities"),
            object_type=None,
        )
        for i in ocel_raw
    ]

    # ── 2. Per-object-type flattened findings ───────────────────────
    # Pick the N largest object types by object count. If counts are
    # unavailable (older OCEL), fall back to pm4py's reported list.
    object_types: list[str] = meta.get("object_types") or []
    type_counts: dict[str, int] = meta.get("type_counts") or {}
    if type_counts:
        ranked = sorted(object_types, key=lambda t: type_counts.get(t, 0), reverse=True)
    else:
        ranked = list(object_types)
    selected_types = ranked[:_OCPM_MAX_OBJECT_TYPES]

    per_type_sections: list[ObjectTypeSection] = []
    for ot in selected_types:
        section = ObjectTypeSection(
            object_type=ot,
            total_cases=0,
            total_events=0,
            total_activities=0,
            critical_count=0,
            warning_count=0,
            findings=[],
        )
        try:
            flat_df = pm4py.ocel_flattening(ocel_obj, ot)
        except Exception as e:
            section.error = f"Flattening failed: {e}"
            per_type_sections.append(section)
            continue

        if flat_df is None or flat_df.empty:
            section.error = "Flattened log is empty."
            per_type_sections.append(section)
            continue

        # Normalise to pm4py-standard column names so mining_engine
        # can run without per-type hints.
        rename_map: dict[str, str] = {}
        for col in flat_df.columns:
            low = str(col).lower()
            if col == "case:concept:name":
                continue
            if col == "concept:name":
                continue
            if col == "time:timestamp":
                continue
            if "case" in low and "case:concept:name" not in flat_df.columns:
                rename_map[col] = "case:concept:name"
            elif low == "concept:name":
                rename_map[col] = "concept:name"
        if rename_map:
            flat_df = flat_df.rename(columns=rename_map)

        try:
            flat_df["time:timestamp"] = pd.to_datetime(
                flat_df["time:timestamp"], errors="coerce", utc=True
            )
        except Exception:
            pass

        if len(flat_df) < _OCPM_MIN_FLATTEN_EVENTS:
            section.error = (
                f"Only {len(flat_df)} events after flattening — too small "
                "for reliable analysis."
            )
            per_type_sections.append(section)
            continue

        section.total_cases = int(flat_df["case:concept:name"].nunique())
        section.total_events = int(len(flat_df))
        section.total_activities = int(flat_df["concept:name"].nunique())

        # ── Resource guard ────────────────────────────────────────────
        # Forklifts, trucks, and other reusable assets show thousands
        # of events per case because each unit handles many shipments.
        # Running the generic case-based insight engine against them
        # emits nonsense findings ("100% of cases involve rework"
        # because of course the same forklift does "Bring to Loading
        # Bay" hundreds of times). Short-circuit here and emit one
        # honest marker instead.
        if _is_resource_object_type(section.total_events, section.total_cases):
            ratio = section.total_events / max(section.total_cases, 1)
            section.findings.append(
                ImprovementFinding(
                    severity="info",
                    category="resource_marker",
                    title=f"{ot} is a reusable resource — case-based analysis skipped",
                    description=(
                        f"{ot} has {section.total_cases} units handling "
                        f"{section.total_events:,} events "
                        f"({ratio:.0f} events per unit). Reusable resources "
                        f"repeat the same activities hundreds of times by "
                        f"design — running rework or bottleneck detection "
                        f"on them would mis-label normal utilization as a "
                        f"problem. Focus resource analysis on utilization, "
                        f"queue depth, and throughput rather than case "
                        f"duration or repetition."
                    ),
                    recommendation=None,
                    metric_value=ratio,
                    impact_estimate=None,
                    related_activities=None,
                    object_type=ot,
                )
            )
            section.critical_count = 0
            section.warning_count = 0
            per_type_sections.append(section)
            continue

        try:
            result = mining_engine.generate_insights(flat_df)
            raw_findings = result.get("insights", []) if isinstance(result, dict) else []
        except Exception as e:
            section.error = f"Insight generation failed: {type(e).__name__}: {str(e)[:120]}"
            per_type_sections.append(section)
            continue

        for i in raw_findings:
            finding = ImprovementFinding(
                severity=i.get("severity", "info"),
                category=i.get("category", "other"),
                title=i.get("title", ""),
                description=i.get("description", ""),
                recommendation=i.get("recommendation"),
                metric_value=i.get("metric_value"),
                impact_estimate=i.get("impact_estimate"),
                related_activities=i.get("related_activities"),
                object_type=ot,
            )
            # ── Legitimate-wait reclassification ──────────────────────
            # Waiting_time and bottleneck findings rooted on legitimate
            # wait patterns (inventory dwell, curing, approval queue,
            # recovery, batch windows) get reshaped so the narrator
            # can't quote the misleading "cut the wait in half" impact
            # estimate. See _DWELL_ACTIVITY_KEYWORDS for the full list
            # of cross-domain patterns we detect here.
            if finding.category in {"waiting_time", "bottleneck"}:
                related = finding.related_activities or []
                if any(_looks_like_legitimate_wait(a) for a in related):
                    finding = _rewrite_legitimate_wait_finding(finding)
            section.findings.append(finding)
        section.critical_count = sum(1 for f in section.findings if f.severity == "critical")
        section.warning_count = sum(1 for f in section.findings if f.severity == "warning")
        per_type_sections.append(section)

    # ── 3. Cross-object patterns ────────────────────────────────────
    # An activity that's a bottleneck in several object types is almost
    # always a coordination point that deserves priority attention. Same
    # for rework hotspots. We compute these by bucketing findings from
    # step 2 by activity name.
    activity_hits: dict[tuple[str, str], list[str]] = {}
    # (activity_name, finding_category) -> [object_types it appeared in]
    for section in per_type_sections:
        seen_in_section: set[tuple[str, str]] = set()
        for f in section.findings:
            if f.category not in {"bottleneck", "waiting_time", "rework", "automation"}:
                continue
            for act in f.related_activities or []:
                key = (str(act), f.category)
                if key in seen_in_section:
                    continue
                seen_in_section.add(key)
                activity_hits.setdefault(key, []).append(section.object_type)

    cross_object: list[ImprovementFinding] = []
    for (activity, cat), types in activity_hits.items():
        if len(types) < 2:
            continue
        sev = "critical" if len(types) >= 3 else "warning"
        if cat == "bottleneck":
            title = f'"{activity}" is a bottleneck across {len(types)} object types'
            desc = (
                f'"{activity}" appears as a bottleneck in the flattened '
                f'perspectives of {", ".join(types)}. A single fix here '
                'will compound across every object view.'
            )
            rec = (
                f'Prioritise "{activity}" over per-type bottlenecks — '
                'work done on it pays off across the whole OCPM.'
            )
        elif cat == "waiting_time":
            title = f'Handoffs near "{activity}" wait across {len(types)} object types'
            desc = (
                f'Waiting time around "{activity}" is flagged in '
                f'{", ".join(types)}. The transition is idle, not working.'
            )
            rec = 'Check whether this handoff is a shared queue, an email ping, or a capacity cap.'
        elif cat == "rework":
            title = f'"{activity}" is reworked across {len(types)} object types'
            desc = (
                f'"{activity}" is flagged as a rework hotspot in '
                f'{", ".join(types)}. A correctness issue here touches every '
                'downstream object stream.'
            )
            rec = 'Root-cause the rework on this activity once — the fix will land in multiple perspectives.'
        else:  # automation
            title = f'"{activity}" is an automation candidate across {len(types)} object types'
            desc = (
                f'"{activity}" scored as a high-frequency / low-complexity '
                f'automation target in {", ".join(types)}.'
            )
            rec = 'Automating a shared activity compounds the savings across every affected object type.'
        cross_object.append(
            ImprovementFinding(
                severity=sev,
                category=f"cross_object_{cat}",
                title=title,
                description=desc,
                recommendation=rec,
                metric_value=float(len(types)),
                related_activities=[activity],
                object_type=None,
            )
        )

    # ── Rollup & summary ────────────────────────────────────────────
    all_findings: list[ImprovementFinding] = []
    all_findings.extend(ocel_findings)
    for section in per_type_sections:
        all_findings.extend(section.findings)
    all_findings.extend(cross_object)

    critical = sum(1 for f in all_findings if f.severity == "critical")
    warning = sum(1 for f in all_findings if f.severity == "warning")

    pieces = [
        f"{meta['event_count']:,} events across {len(object_types)} object types "
        f"({meta['object_count']:,} objects)."
    ]
    if critical or warning:
        pieces.append(
            f"Found {critical} critical and {warning} warning findings across "
            f"{len(selected_types)} analysed perspective{'s' if len(selected_types) != 1 else ''}."
        )
    else:
        pieces.append("No critical issues detected across any perspective.")
    if cross_object:
        pieces.append(
            f"{len(cross_object)} cross-object pattern"
            f"{'s' if len(cross_object) != 1 else ''} span multiple perspectives."
        )
    summary_text = " ".join(pieces)

    severity_order = {"critical": 0, "warning": 1, "info": 2}
    cross_object.sort(key=lambda f: (severity_order.get(f.severity, 9), -(f.metric_value or 0)))
    for section in per_type_sections:
        section.findings.sort(key=lambda f: severity_order.get(f.severity, 9))

    response = ImprovementReportResponse(
        summary=summary_text,
        ocel_event_count=int(meta["event_count"]),
        ocel_object_count=int(meta["object_count"]),
        object_type_count=len(object_types),
        total_findings=len(all_findings),
        critical_count=critical,
        warning_count=warning,
        ocel_findings=ocel_findings,
        per_object_type=per_type_sections,
        cross_object_findings=cross_object,
    )
    _set_cached(ocel_id, "improvement_report", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint — GET /ocel/{ocel_id}/improvement-report/narrate
# LLM-polished executive narrative over the structured improvement
# report. Keeps the rule engine as the truth source — the LLM only
# rewrites the findings into readable prose; it never invents numbers.
# ---------------------------------------------------------------------------


class NarrativeResponse(BaseModel):
    narrative: str
    llm_configured: bool


def _summarise_findings_for_prompt(report: "ImprovementReportResponse") -> str:
    """Turn a structured improvement report into a compact JSON block
    the LLM can consume.

    Design notes
    ------------
    The LLM doesn't need every finding; it needs the highest-signal
    subset with enough fields to make sharp claims without re-deriving
    things. Concretely, we now include:

      * ``category`` — lets the model group findings without parsing
        prose titles.
      * ``related_activities`` — lets the model name activities without
        regex-extracting them out of the description string.
      * ``impact_estimate`` (already present, renamed to a clearer
        ``estimated_impact``) — pre-baked fix outcome the model can
        repeat verbatim instead of inventing one.

    We also expose a deterministic ``top_findings`` cross-source
    ranking so the model doesn't have to traverse three buckets to
    figure out what matters most.
    """
    def _reduce(finding: ImprovementFinding) -> dict:
        return {
            "severity": finding.severity,
            "category": finding.category,
            "title": finding.title,
            "description": finding.description,
            "recommendation": finding.recommendation,
            "estimated_impact": finding.impact_estimate,
            "related_activities": finding.related_activities,
            "object_type": finding.object_type,
        }

    # Severity priority — used both for in-bucket sorting and as the
    # base signal for the cross-source top_findings ranking.
    _SEV = {"critical": 0, "warning": 1, "info": 2}

    def _priority(f: ImprovementFinding) -> int:
        return _SEV.get(f.severity, 9)

    # Composite impact score — used to rank top_findings across all
    # sources. Higher is worse. Components:
    #   * severity (critical=10, warning=3, info=1)
    #   * +5 bonus if the finding spans multiple object types
    #     (cross_object_findings entries always carry related_activities)
    #   * +len(related_activities) — broader-scope findings score higher
    #   * +1 if there's a baked-in impact estimate (a pre-quantified
    #     finding is more actionable than one without)
    def _impact_score(f: ImprovementFinding, *, is_cross: bool) -> float:
        sev = {"critical": 10, "warning": 3, "info": 1}.get(f.severity, 0)
        cross_bonus = 5 if is_cross else 0
        rel = len(f.related_activities or [])
        impact_bonus = 1 if f.impact_estimate else 0
        return sev + cross_bonus + rel + impact_bonus

    # ── Per-object-type sections (kept so the model can also report
    #    healthy perspectives as counterpoint) ─────────────────────────
    per_type = []
    for section in report.per_object_type:
        sorted_findings = sorted(section.findings, key=_priority)[:8]
        per_type.append({
            "object_type": section.object_type,
            "cases": section.total_cases,
            "events": section.total_events,
            "critical": section.critical_count,
            "warning": section.warning_count,
            "findings": [_reduce(f) for f in sorted_findings],
        })

    # ── Top findings cross-source ranking ────────────────────────────
    scored: list[tuple[float, str, ImprovementFinding]] = []
    for f in report.ocel_findings:
        scored.append((_impact_score(f, is_cross=False), "ocel", f))
    for f in report.cross_object_findings:
        scored.append((_impact_score(f, is_cross=True), "cross_object", f))
    for section in report.per_object_type:
        for f in section.findings:
            scored.append((_impact_score(f, is_cross=False), "per_object_type", f))
    scored.sort(key=lambda t: -t[0])
    top_findings = []
    for score, source, f in scored[:12]:
        entry = _reduce(f)
        entry["source"] = source
        entry["impact_score"] = round(score, 1)
        top_findings.append(entry)

    # ── Existing per-bucket lists (kept so the model can still
    #    distinguish OCEL-level findings from cross-cutting ones) ─────
    ocel = sorted(report.ocel_findings, key=_priority)[:15]
    cross = sorted(report.cross_object_findings, key=_priority)[:15]

    compact = {
        "summary_line": report.summary,
        "totals": {
            "object_types": report.object_type_count,
            "objects": report.ocel_object_count,
            "events": report.ocel_event_count,
            "findings": report.total_findings,
            "critical": report.critical_count,
            "warning": report.warning_count,
        },
        "top_findings": top_findings,
        "ocel_structural": [_reduce(f) for f in ocel],
        "cross_object_patterns": [_reduce(f) for f in cross],
        "per_object_type": per_type,
    }
    return json.dumps(compact, default=str, indent=2)


def _load_narrate_prompt() -> str:
    """Load the production narration system prompt from disk so the
    same file can be edited by the tuning script and reloaded on
    backend restart without a code change.

    The prompt lives in ``backend/scripts/prompts/v6_cot_full.md`` —
    that's the version that won the v3 → v6 A/B run on a real OCEL.
    Falls back to a baked-in copy if the file is missing (so the
    backend still boots in stripped-down deploys).
    """
    import pathlib
    candidate = pathlib.Path(__file__).resolve().parent.parent.parent / "scripts" / "prompts" / "v6_cot_full.md"
    try:
        return candidate.read_text().strip()
    except OSError:
        return _NARRATE_SYSTEM_PROMPT_FALLBACK


# Minimal fallback used only if the prompt file is missing on disk —
# keeps the endpoint working but with a much weaker prompt.
_NARRATE_SYSTEM_PROMPT_FALLBACK = (
    "You are FlowMiner's process-mining analyst. Given a structured "
    "improvement report for an object-centric event log as JSON, write "
    "a 200-word executive brief for a process owner. Every number must "
    "come verbatim from the JSON. Lead with severity and headline "
    "counts. Quote any estimated_impact strings verbatim. Close with "
    "one specific imperative action naming an object type + activity. "
    "Output GitHub-flavoured markdown using only ## headings, - bullets, "
    "and **bold** for object types and activities."
)

_NARRATE_SYSTEM_PROMPT = _load_narrate_prompt()


@router.post("/{ocel_id}/improvement-report/narrate", response_model=NarrativeResponse)
async def narrate_improvement_report(
    ocel_id: str,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a plain-English narrative over the cached improvement
    report. If no report is cached we compute one on the fly first.

    The LLM pass is cached alongside the structured report so repeat
    loads are free. Caching uses the same cache utility as the mining
    endpoints so Redis invalidation (on log edit, re-upload, etc.)
    already drops both the report and its narrative together.
    """
    from app.api._mining_deps import _get_cached, _set_cached
    from app.services.ai import llm as llm_service
    from app.api.ocel import _assert_ocel_access

    await _assert_ocel_access(ocel_id, db, current_user)

    cached_narr = _get_cached(ocel_id, "improvement_narrative")
    if cached_narr is not None:
        return NarrativeResponse(**cached_narr)

    # Load (or compute) the structured report.
    cached_report = _get_cached(ocel_id, "improvement_report")
    if cached_report is not None:
        report = ImprovementReportResponse(**cached_report)
    else:
        # Fall through to the same computation path the GET endpoint
        # uses so the narrative is never out of sync with its source.
        report = await get_ocpm_improvement_report(ocel_id, current_user, db)

    prompt_json = _summarise_findings_for_prompt(report)
    user_prompt = (
        "Structured improvement report (JSON):\n\n"
        f"{prompt_json}\n\n"
        "Write the executive summary now."
    )

    import asyncio as _asyncio
    text = await _asyncio.to_thread(
        llm_service.complete,
        _NARRATE_SYSTEM_PROMPT,
        user_prompt,
        temperature=0.2,
    )

    # If the prompt asked for chain-of-thought separated by ===BRIEF===,
    # the model returns scratch first then the brief. Strip the scratch.
    if "===BRIEF===" in text:
        text = text.split("===BRIEF===", 1)[1]

    response = NarrativeResponse(
        narrative=text.strip(),
        llm_configured=llm_service.is_llm_configured(),
    )
    _set_cached(ocel_id, "improvement_narrative", response.model_dump())
    return response


# ---------------------------------------------------------------------------
# Endpoint — POST /ocel/{ocel_id}/improvement-report/explain
# Takes one finding as a body and returns a deeper plain-English
# explanation with 3 concrete next steps.
# ---------------------------------------------------------------------------


class ExplainFindingRequest(BaseModel):
    finding: ImprovementFinding
    ocel_context: bool = True  # include the compact report for grounding


class ExplainFindingResponse(BaseModel):
    explanation: str
    llm_configured: bool


_EXPLAIN_SYSTEM_PROMPT = (
    "You are FlowMiner's process-mining analyst. You will be given one "
    "structured finding from an improvement report, optionally with the "
    "full report as context. Your job is to explain the finding in "
    "plain business English and give three concrete next steps. Rules:\n"
    "  1. Ground every claim in the structured data. Never invent a "
    "number or a new activity name.\n"
    "  2. Lead with a one-sentence explanation of WHY this finding "
    "matters to someone who owns the process.\n"
    "  3. Follow with 3 concrete next steps as a numbered list. Each "
    "step must be something a person can do this week — not vague "
    "advice like 'investigate'.\n"
    "  4. If the finding references an object type or specific "
    "activity, mention it explicitly.\n"
    "  5. Plain text. No markdown headings. Keep it under 200 words."
)


@router.post("/{ocel_id}/improvement-report/explain", response_model=ExplainFindingResponse)
async def explain_improvement_finding(
    ocel_id: str,
    body: ExplainFindingRequest,
    current_user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Expand a single finding into plain-English prose with next steps.

    Not cached — users only call this on demand and the input is the
    finding itself, so there's nothing stable to key on.
    """
    from app.api._mining_deps import _get_cached
    from app.services.ai import llm as llm_service
    from app.api.ocel import _assert_ocel_access

    await _assert_ocel_access(ocel_id, db, current_user)

    # Compact context (if available + requested) helps the LLM ground
    # its explanation in the surrounding findings.
    context_json = ""
    if body.ocel_context:
        cached_report = _get_cached(ocel_id, "improvement_report")
        if cached_report is not None:
            try:
                report = ImprovementReportResponse(**cached_report)
                context_json = _summarise_findings_for_prompt(report)
            except Exception as e:
                logger.warning("explain-finding: context build failed: %s", e)
                context_json = ""

    user_prompt = (
        f"Finding:\n{body.finding.model_dump_json(indent=2)}\n\n"
        + (f"Full report context (JSON):\n{context_json}\n\n" if context_json else "")
        + "Explain this finding and give 3 concrete next steps."
    )

    import asyncio as _asyncio
    text = await _asyncio.to_thread(
        llm_service.complete,
        _EXPLAIN_SYSTEM_PROMPT,
        user_prompt,
        temperature=0.2,
    )

    return ExplainFindingResponse(
        explanation=text.strip(),
        llm_configured=llm_service.is_llm_configured(),
    )
