"""LLM-backed conversational AI endpoints.

The conversational / narrative AI routes live here; the structured
"AI tools" routes (text-to-bpmn, agent/run, explain-variant, explain,
extract-log) live in :mod:`app.api.ai_tools`, which mounts at the same
``/api/v1/ai`` prefix.

Provides the following conversational capabilities, all layered on the
same LLM abstraction in ``app.services.ai.llm``:

  1. POST /ai/chat              — Chat about a specific event log; the
                                  server assembles context (summary,
                                  top bottlenecks, insights) and streams
                                  an answer.
  2. GET  /ai/chat-suggestions/{id} — Data-anchored chat starters built
                                  deterministically from the log's
                                  findings (no LLM call).
  3. GET  /ai/narrate/{id}      — Generate a Markdown document describing
                                  a discovered process, ready to paste
                                  into Confluence / Notion.
  4. GET  /ai/suggest-best-practice/{id} — Compare the discovered model
                                  against a small library of best-practice
                                  BPMN snippets and return the top matches.

This module also owns the shared ``_SYSTEM_PROMPT`` and the context
builders (``_build_log_context``, ``_build_ocel_context``,
``_is_ocel_log``) that other modules (e.g. ``app.mcp.server``) import.

All endpoints work end-to-end without credentials thanks to the null
provider in ``llm.py`` — they return a templated fallback instead.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.api._mining_deps import _assert_event_log_access, _load_event_log_and_df
from app.database import get_db
from app.models import User
from app.services.ai import llm
from app.services.mining_engine import mining_engine

router = APIRouter()
logger = logging.getLogger(__name__)


_SYSTEM_PROMPT = (
    "You are FlowMiner's analyst assistant. Answer process-mining "
    "questions clearly, cite specific numbers from the provided context, "
    "and offer one concrete next step. Be concise. If the user asks about "
    "something the context doesn't cover, say so explicitly.\n\n"
    "Output format: GitHub-flavoured Markdown. Your reply is rendered "
    "with a markdown parser in the chat panel, so:\n"
    "  - Use **bold** for activity names, metric names, and the single "
    "most important number in a sentence.\n"
    "  - Use `backticks` for column names, identifiers, and code-like "
    "tokens.\n"
    "  - Use bulleted lists (`- item`) when listing more than two "
    "items — do not cram them into one sentence.\n"
    "  - Use `## Heading` if you are emitting more than one section; "
    "skip headings for short answers.\n"
    "  - Do NOT use code fences (``` blocks) — the renderer only "
    "supports inline backticks.\n"
    "  - Do NOT use tables or HTML.\n"
    "Keep answers under ~180 words unless the user explicitly asks "
    "for a long write-up."
)


async def _is_ocel_log(event_log_id: UUID, db: AsyncSession) -> bool:
    """Cheap lookup: is the event_log row marked as OCEL? Used by the
    chat endpoint to route to the OCEL-aware context builder instead
    of calling ``_load_event_log_and_df`` which rejects OCEL logs."""
    from sqlalchemy import select as _select

    from app.models import EventLog as _EventLog

    result = await db.execute(
        _select(_EventLog.log_type).where(_EventLog.id == event_log_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        return False
    return (row.value if hasattr(row, "value") else str(row)) == "ocel"


async def _build_ocel_context(event_log_id: UUID, db: AsyncSession, user: User) -> str:
    """OCEL-aware equivalent of ``_build_log_context``.

    Pulls the cached improvement_report (the enriched one with
    cross-object patterns, per-object-type findings, resource markers,
    and legitimate_wait reclassification) and flattens it into a
    compact text context the LLM can read. Falls back to a minimal
    summary block if the report isn't cached yet.
    """
    from app.api._mining_deps import _assert_event_log_access
    from app.services.infra.result_cache import cache_get

    # Authorization — same check the mining endpoints apply.
    await _assert_event_log_access(event_log_id, db, user)

    report = cache_get(str(event_log_id), "improvement_report", "none")

    lines: list[str] = ["This is an OCEL (object-centric event log)."]
    if not report:
        lines.append(
            "No improvement report is cached yet — visit the OCPM "
            "improvements tab once to populate it, then ask again "
            "for richer grounding."
        )
        return "\n".join(lines)

    lines.append(report.get("summary") or "")
    lines.append(
        f"Totals: {report.get('ocel_event_count', 0):,} events across "
        f"{report.get('ocel_object_count', 0):,} objects and "
        f"{report.get('object_type_count', 0)} object types. "
        f"{report.get('critical_count', 0)} critical / "
        f"{report.get('warning_count', 0)} warning findings."
    )

    def _fmt_finding(f: dict) -> str:
        sev = f.get("severity", "info")
        cat = f.get("category", "other")
        ot = f.get("object_type")
        scope = f" [{ot}]" if ot else ""
        title = f.get("title", "")
        desc = (f.get("description") or "")[:200]
        imp = f.get("estimated_impact") or f.get("impact_estimate")
        imp_suffix = f" Impact: {imp}" if imp else ""
        return f"  - [{sev}/{cat}]{scope} {title} — {desc}{imp_suffix}"

    ocel_findings = (report.get("ocel_findings") or [])[:5]
    if ocel_findings:
        lines.append("\nOCEL-level findings:")
        for f in ocel_findings:
            lines.append(_fmt_finding(f))

    cross = (report.get("cross_object_findings") or [])[:6]
    if cross:
        lines.append("\nCross-object patterns (highest leverage):")
        for f in cross:
            lines.append(_fmt_finding(f))

    per_type = report.get("per_object_type") or []
    if per_type:
        lines.append("\nPer-object-type findings (top):")
        for section in per_type[:6]:
            ot = section.get("object_type", "?")
            cases = section.get("total_cases", 0)
            events = section.get("total_events", 0)
            crit = section.get("critical_count", 0)
            warn = section.get("warning_count", 0)
            lines.append(
                f"  {ot}: {cases:,} cases / {events:,} events / "
                f"{crit} critical, {warn} warning"
            )
            top_findings = (section.get("findings") or [])[:3]
            for f in top_findings:
                lines.append(_fmt_finding(f))

    return "\n".join(lines)


async def _build_log_context(
    event_log_id: UUID,
    db: AsyncSession,
    user: User,
    *,
    algorithm: str | None = None,
    noise_threshold: float | None = None,
    complexity: int | None = None,
    visible_nodes: int | None = None,
    visible_edges: int | None = None,
) -> str:
    """Assemble the compact context block fed to the LLM for a chat turn.

    For standard event logs: summary stats, top 5 variants, top 5
    bottlenecks, top 5 insights. For OCEL logs: delegate to the
    OCEL-aware context builder because ``_load_event_log_and_df``
    rejects OCEL rows.

    The optional ``algorithm`` / ``noise_threshold`` / ``complexity`` /
    ``visible_nodes`` / ``visible_edges`` params describe the process map
    the user is currently looking at (the narrate endpoint passes them so
    the report reflects the chosen discovery algorithm, noise filtering,
    and how aggressively the complexity slider trimmed the rendered
    graph). They are all optional so chat / best-practice callers that
    only know about the raw log keep working unchanged.

    Best-effort — any fetch that fails is dropped instead of
    throwing.
    """
    if await _is_ocel_log(event_log_id, db):
        return await _build_ocel_context(event_log_id, db, user)

    _event_log, df = await _load_event_log_and_df(event_log_id, db, user)
    import asyncio as _asyncio

    def _safe(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:
            return None

    # Run the read-only calls in the threadpool to avoid blocking.
    stats = await _asyncio.to_thread(_safe, mining_engine.compute_statistics, df)
    variants = await _asyncio.to_thread(_safe, mining_engine.run_variant_analysis, df)
    bottlenecks = await _asyncio.to_thread(_safe, mining_engine.run_bottleneck_analysis, df)
    insights = await _asyncio.to_thread(_safe, mining_engine.generate_insights, df)

    lines: list[str] = []
    if stats:
        lines.append(f"Total cases: {stats.get('total_cases', '?')}")
        lines.append(f"Total events: {stats.get('total_events', '?')}")
        lines.append(f"Unique activities: {stats.get('total_activities', '?')}")
        if 'avg_case_duration_seconds' in stats:
            secs = stats['avg_case_duration_seconds']
            lines.append(f"Avg case duration: {secs/3600:.1f} hours")

    # Map-level metadata describing the rendered graph the user is
    # looking at, so the narration reflects the chosen algorithm / noise
    # filtering / complexity trim instead of just the raw log.
    map_lines: list[str] = []
    if algorithm is not None:
        map_lines.append(f"  - Discovery algorithm: {algorithm}")
    if noise_threshold is not None:
        map_lines.append(
            f"  - Noise filter threshold: {noise_threshold*100:.0f}% "
            "(prunes infrequent paths)"
        )
    if complexity is not None:
        map_lines.append(
            f"  - Complexity slider: {complexity}% of edges kept"
        )
    if visible_nodes is not None:
        map_lines.append(f"  - Visible activity nodes: {visible_nodes}")
    if visible_edges is not None:
        map_lines.append(f"  - Visible directed edges: {visible_edges}")
    if map_lines:
        lines.append("\nCurrently displayed process map:")
        lines.extend(map_lines)

    if variants and variants.get("variants"):
        lines.append("\nTop variants:")
        for v in variants["variants"][:5]:
            path = " → ".join(v.get("activities", [])[:8])
            lines.append(f"  - {path} ({v.get('case_count', 0)} cases)")

    if bottlenecks and bottlenecks.get("bottlenecks"):
        lines.append("\nTop bottlenecks:")
        for b in bottlenecks["bottlenecks"][:5]:
            lines.append(
                f"  - {b.get('activity', '?')}: avg {b.get('avg_duration', 0):.0f}s, "
                f"{b.get('frequency', 0)} occurrences"
            )

    if insights and insights.get("insights"):
        lines.append("\nGenerated insights:")
        for ins in insights["insights"][:5]:
            sev = ins.get("severity", "info")
            lines.append(f"  - [{sev}] {ins.get('title', '')}: {ins.get('description', '')[:200]}")

    if not lines:
        return "(event log has no discoverable content)"
    return "\n".join(lines)


# ─── 1. Chat ──────────────────────────────────────────────────────────────


class ChatRequest(BaseModel):
    event_log_id: UUID
    question: str
    stream: bool = True
    # When true (default) and the provider supports it, run the chat
    # through the tool-use loop so the LLM can request charts, filter
    # proposals, and aggregated metrics. When false, fall through to
    # the plain streaming path — useful for the simple non-streaming
    # JSON client and for providers that don't support tool calls.
    use_tools: bool = True


@router.post("/chat")
async def ai_chat(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Chat about a specific event log. Server assembles context and
    streams the LLM's response back as newline-delimited JSON chunks.

    When ``use_tools=True`` and the provider supports function calls
    (openai / openrouter paths currently), the LLM can request tool
    calls that return charts / filter proposals inline. The streaming
    envelope grows ``tool_start`` and ``tool_result`` message types
    for those cases. Older clients that only listen for ``type=chunk``
    still see all the text — they just don't render the rich widgets.
    """
    from app.services.ai import chat_tools

    await _assert_event_log_access(body.event_log_id, db, current_user)
    context = await _build_log_context(body.event_log_id, db, current_user)
    is_ocel = await _is_ocel_log(body.event_log_id, db)

    user_prompt = (
        f"Context for the event log the user is asking about:\n\n{context}\n\n"
        f"User question: {body.question}"
    )

    # Chat + agent loop is workload A — route to the chat/agent workhorse
    # model if the operator configured one (else the base model). Resolved
    # once here and reused across the stream / non-stream paths below.
    chat_model = llm.model_for("chat")

    if not body.stream:
        with llm.usage_context(
            user=current_user,
            resource_id=str(body.event_log_id),
            resource_type="event_log",
        ):
            text = llm.complete(_SYSTEM_PROMPT, user_prompt, model=chat_model)
        return {"answer": text, "llm_configured": llm.is_llm_configured()}

    # For tool use the user prompt stays the same, but we beef up the
    # system prompt so the LLM knows it has tools and what the user
    # will see inline.
    _TOOL_SYSTEM_PROMPT = (
        "You are FlowMiner's analyst assistant. You have tools you can "
        "call to fetch charts and filter proposals that the user sees "
        "rendered inline in the chat. When the user asks about "
        "bottlenecks, rework, variants, throughput over time, or wants "
        "to narrow the view to a subset of cases — use the relevant "
        "tool rather than trying to answer from memory.\n\n"
        "Rules:\n"
        "  1. Call tools when they would help, then write a short "
        "plain-English answer that references the chart the user just "
        "saw. Don't restate every number — the chart already shows "
        "them; point out the top 1-2 insights.\n"
        "  2. Numbers must come from the tool results or the context "
        "block — never invent.\n"
        "  3. If the user asks a question the tools cannot answer, "
        "give a text answer grounded in the context block and say "
        "explicitly that a deeper dive would need more data.\n"
        "  4. Keep text responses under ~150 words. The chart carries "
        "the detail; your prose carries the interpretation and the "
        "one-line 'what to do about it'.\n"
        "  5. Prefer ONE or TWO tool calls per turn, not five. Stop "
        "when you have enough to answer.\n\n"
        "Output format: GitHub-flavoured Markdown. Your prose is "
        "rendered with a markdown parser, so:\n"
        "  - Use **bold** for activity names and the single most "
        "important number per sentence.\n"
        "  - Use `backticks` for column or identifier names.\n"
        "  - Use bulleted lists (`- item`) when listing more than two "
        "things.\n"
        "  - Do NOT use code fences (``` blocks) — inline backticks "
        "only.\n"
        "  - Do NOT use tables or HTML."
    )

    # For standard (non-OCEL) logs, load the dataframe once up-front
    # so the sync tool runner can close over it. OCEL logs don't have
    # a standard dataframe — the chat_tools catalogue is case-based
    # and won't make sense on an OCEL anyway — so we fall back to
    # plain streaming for OCEL logs and let the OCEL context (pulled
    # from the cached improvement report) carry the grounding.
    df = None
    if not is_ocel:
        _event_log, df = await _load_event_log_and_df(
            body.event_log_id, db, current_user
        )

    def _tool_runner(name: str, args: dict) -> dict:
        if df is None:
            return {
                "data": None,
                "render": None,
                "summary": "Tool unavailable: this is an OCEL log.",
                "error": "ocel_tools_unsupported",
            }
        return chat_tools.run_tool(name, args, df)

    # Decide whether tool-use is possible. OCEL logs skip tool-use
    # because the case-based tool catalogue doesn't apply to them;
    # the rich OCEL improvement-report context in ``_build_ocel_context``
    # already carries enough grounding for plain streaming answers.
    tool_capable = (
        body.use_tools
        and not is_ocel
        and llm.is_llm_configured()
        and llm._provider() in ("openai", "openrouter")
    )

    # The generators are consumed by the ASGI server after this handler
    # returns, so we set the usage-attribution contextvar inside them
    # (it must be active while the LLM stream actually runs, which is when
    # llm.py's central metering hook fires).
    async def _gen_tools():
        import logging as _log
        _logger = _log.getLogger(__name__)
        with llm.usage_context(
            user=current_user,
            resource_id=str(body.event_log_id),
            resource_type="event_log",
        ):
            try:
                async for event in llm.stream_with_tools(
                    _TOOL_SYSTEM_PROMPT,
                    user_prompt,
                    chat_tools.CHAT_TOOL_SCHEMAS,
                    _tool_runner,
                    temperature=0.2,
                    max_turns=5,
                    model=chat_model,
                ):
                    kind = event.get("kind")
                    if kind == "text":
                        yield json.dumps({"type": "chunk", "text": event["text"]}) + "\n"
                    elif kind == "tool_start":
                        yield json.dumps({
                            "type": "tool_start",
                            "id": event.get("id"),
                            "name": event.get("name"),
                            "args": event.get("args") or {},
                        }) + "\n"
                    elif kind == "tool_result":
                        yield json.dumps({
                            "type": "tool_result",
                            "id": event.get("id"),
                            "name": event.get("name"),
                            "result": event.get("result") or {},
                        }, default=str) + "\n"
                    elif kind == "tool_warning":
                        yield json.dumps({
                            "type": "warning",
                            "message": event.get("text", ""),
                        }) + "\n"
                    elif kind == "done":
                        yield json.dumps({"type": "done"}) + "\n"
            except Exception as e:
                _logger.exception("ai_chat tool stream failed")
                yield json.dumps({
                    "type": "error",
                    "message": f"{type(e).__name__}: {str(e)[:300]}",
                }) + "\n"

    async def _gen_plain():
        with llm.usage_context(
            user=current_user,
            resource_id=str(body.event_log_id),
            resource_type="event_log",
        ):
            try:
                async for chunk in llm.stream(
                    _SYSTEM_PROMPT, user_prompt, model=chat_model
                ):
                    yield json.dumps({"type": "chunk", "text": chunk}) + "\n"
                yield json.dumps({"type": "done"}) + "\n"
            except Exception as e:
                import logging as _log
                _log.getLogger(__name__).exception("ai_chat stream failed")
                yield json.dumps({
                    "type": "error",
                    "message": f"{type(e).__name__}: {str(e)[:300]}",
                }) + "\n"

    _gen = _gen_tools if tool_capable else _gen_plain

    # X-Accel-Buffering: no tells nginx (and any compatible reverse
    # proxy) not to buffer this response, so the client sees chunks
    # as they are generated instead of after the upstream closes.
    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# ─── 1b. Data-anchored chat suggestions ────────────────────────────────
#
# When the user opens the Ask-AI panel the frontend used to show three
# hardcoded questions ("What are the top bottlenecks?"). Those are
# generic and don't reference anything about the current log, so the
# user rightly perceives them as canned. This endpoint replaces them
# with up to three questions generated deterministically from the
# log's actual findings, so each suggestion names a specific activity
# / object type / duration. No LLM call involved — it's fast, cheap
# and grounded by construction.


class ChatSuggestionFinding(BaseModel):
    severity: str
    title: str
    description: str


class ChatSuggestionsResponse(BaseModel):
    suggestions: list[str]
    # Top 3 findings, returned alongside the suggestions so the chat
    # panel can render them as click-to-explain cards without a
    # second round-trip.
    top_findings: list[ChatSuggestionFinding]


def _suggestion_for_finding(finding: dict) -> str | None:
    """Write one natural-language question about a single finding.

    Returns ``None`` if the finding's category doesn't have a good
    template — the caller skips it and picks the next-highest one.
    Every returned string names a specific activity / object type /
    metric from the finding so the user can tell it's about THEIR
    log, not a generic question.
    """
    category = (finding.get("category") or "").lower()
    related = finding.get("related_activities") or []
    object_type = finding.get("object_type")
    scope = f" for {object_type}" if object_type else ""

    if category == "bottleneck" and related:
        return f'Why does "{related[0]}" take so long{scope}?'
    if category == "waiting_time" and len(related) >= 2:
        return (
            f'Why do cases wait between "{related[0]}" and '
            f'"{related[1]}"{scope}?'
        )
    if category == "waiting_time" and related:
        return f'Why are cases waiting at "{related[0]}"{scope}?'
    if category == "rework" and related:
        return f'What causes "{related[0]}" to be reworked{scope}?'
    if category == "rework":
        return f"What's driving the rework in this process{scope}?"
    if category == "variant":
        return "Why are there so many different execution paths?"
    if category == "conformance":
        return "Which process deviations should I worry about first?"
    if category == "duration":
        return "Why do some cases take so much longer than others?"
    if category in {"cross_object_rework", "cross_object_bottleneck"}:
        if related:
            return (
                f'Why is "{related[0]}" a problem across multiple '
                "object types?"
            )
    return None


_GENERIC_SUGGESTION_DEFAULTS = [
    "Summarise the health of this process in three bullets.",
    "What are the top bottlenecks and why?",
    "Where should we focus automation first?",
]


def _build_chat_suggestions(insights: list[dict]) -> tuple[list[str], list[dict]]:
    """Pick the top-3 findings by severity and write a suggestion for
    each. Returns ``(suggestions, top_findings_for_cards)``.

    Generic defaults pad the list so the caller always gets 3 entries
    even if the log has no flagged findings. The top_findings list
    only contains real findings — never the generic defaults.
    """
    _sev_rank = {"critical": 0, "warning": 1, "info": 2}
    ranked = sorted(insights, key=lambda f: _sev_rank.get(f.get("severity"), 9))

    suggestions: list[str] = []
    top_findings: list[dict] = []
    seen_categories: set[str] = set()

    for finding in ranked:
        if len(suggestions) >= 3:
            break
        # Don't double up on the same category — spread the suggestions
        # across different angles so the user has more to click.
        cat = finding.get("category") or "other"
        if cat in seen_categories:
            continue
        s = _suggestion_for_finding(finding)
        if s is None:
            continue
        suggestions.append(s)
        top_findings.append(finding)
        seen_categories.add(cat)

    # Pad with generic defaults if we didn't find enough.
    for fallback in _GENERIC_SUGGESTION_DEFAULTS:
        if len(suggestions) >= 3:
            break
        if fallback not in suggestions:
            suggestions.append(fallback)

    return suggestions[:3], top_findings[:3]


@router.get("/chat-suggestions/{event_log_id}")
async def ai_chat_suggestions(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
) -> ChatSuggestionsResponse:
    """Return up to three data-anchored chat starters for this log.

    The chat panel shows these on open so the user can see questions
    that actually reference their own findings instead of canned text.
    For OCPM logs we reach into the cached ``improvement_report`` if
    it exists, otherwise we compute standard mining insights once and
    cache the suggestion response in Redis for 12 hours.
    """
    await _assert_event_log_access(event_log_id, db, current_user)

    from app.api._mining_deps import _get_cached, _set_cached
    from app.services.infra.result_cache import cache_get as _raw_cache_get
    import hashlib as _hashlib

    # Reuse the mining result cache so opening the same log twice in
    # a row costs one Redis GET.
    cached = _get_cached(event_log_id, "chat_suggestions")
    if cached is not None:
        return ChatSuggestionsResponse(**cached)

    # First, try the OCPM improvement report — if the log has one
    # cached we can pull a much richer set of findings including
    # cross-object patterns, which yield the most interesting
    # suggestions.
    ocpm_cache = _raw_cache_get(str(event_log_id), "improvement_report", "none")
    findings: list[dict] = []
    if ocpm_cache is not None:
        findings.extend(ocpm_cache.get("ocel_findings") or [])
        findings.extend(ocpm_cache.get("cross_object_findings") or [])
        for section in ocpm_cache.get("per_object_type") or []:
            findings.extend(section.get("findings") or [])
    elif await _is_ocel_log(event_log_id, db):
        # OCEL log without a cached improvement report yet — fall
        # through with empty findings so we return generic defaults.
        # The user will see real suggestions after visiting the OCPM
        # improvements tab once.
        findings = []
    else:
        # Standard flat-log path — run the generic insight engine.
        try:
            _event_log, df = await _load_event_log_and_df(
                event_log_id, db, current_user
            )
            import asyncio as _asyncio
            result = await _asyncio.to_thread(
                mining_engine.generate_insights, df
            )
            findings = (
                result.get("insights", []) if isinstance(result, dict) else []
            )
        except Exception as e:
            logger.warning(
                "chat-suggestions fallback to defaults for %s: %s",
                event_log_id, e,
            )
            findings = []

    suggestions, top_raw = _build_chat_suggestions(findings)

    response = ChatSuggestionsResponse(
        suggestions=suggestions,
        top_findings=[
            ChatSuggestionFinding(
                severity=f.get("severity", "info"),
                title=f.get("title", ""),
                description=(f.get("description") or "")[:240],
            )
            for f in top_raw
        ],
    )
    _set_cached(event_log_id, "chat_suggestions", response.model_dump())
    return response


# ─── 2. Narrate (Markdown doc generation) ────────────────────────────────


@router.get("/narrate/{event_log_id}")
async def ai_narrate(
    event_log_id: UUID,
    algorithm: str | None = Query(None),
    noise_threshold: float | None = Query(None),
    complexity: int | None = Query(None),
    visible_nodes: int | None = Query(None),
    visible_edges: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Produce a Markdown document describing the discovered process,
    suitable for pasting into Confluence or Notion.

    The optional query params describe the process map the user is
    currently viewing (the chosen discovery ``algorithm``, the
    ``noise_threshold`` applied, the ``complexity`` slider position, and
    the number of ``visible_nodes`` / ``visible_edges`` after pruning) so
    the narration reflects what's on screen rather than just the raw log.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    context = await _build_log_context(
        event_log_id,
        db,
        current_user,
        algorithm=algorithm,
        noise_threshold=noise_threshold,
        complexity=complexity,
        visible_nodes=visible_nodes,
        visible_edges=visible_edges,
    )

    system = (
        "You write concise process-mining reports in Markdown. Use "
        "## headings for Overview, Bottlenecks, Variants, Insights, "
        "Next steps. Cite specific numbers from the context. 500 "
        "words or fewer."
    )
    user_prompt = f"Write a report on this process from the data below.\n\n{context}"
    with llm.usage_context(
        user=current_user,
        resource_id=str(event_log_id),
        resource_type="event_log",
    ):
        # Report narration is grounded writing (workload D).
        text = llm.complete(system, user_prompt, model=llm.model_for("writing"))
    return {"markdown": text, "llm_configured": llm.is_llm_configured()}


# ─── 3. Suggest best-practice ────────────────────────────────────────────


_BEST_PRACTICES = [
    {"name": "Dual approval for high-value orders",
     "description": "Orders above a threshold require two independent approvers before dispatch."},
    {"name": "SLA recovery escalation",
     "description": "Cases waiting more than 80% of SLA trigger a reminder and a manager hand-off."},
    {"name": "Supplier validation gate",
     "description": "Before PO creation, supplier must be validated against a master list and risk flag."},
    {"name": "Four-eyes principle",
     "description": "Initiator and approver must be different; system rejects same-user approval."},
    {"name": "Exception routing",
     "description": "Cases with rework loops > 2 automatically route to a specialist queue."},
    {"name": "Automated reminders",
     "description": "Stale cases (no activity > N days) receive reminders to the assigned resource."},
    {"name": "Rejection feedback loop",
     "description": "Rejected requests get a templated explanation and a clear path to resubmit."},
    {"name": "Quality check before handoff",
     "description": "Every handoff between teams requires a completeness check."},
    {"name": "Priority queue by customer tier",
     "description": "Platinum customers' cases jump the queue based on a pre-defined tier list."},
    {"name": "Self-service retry path",
     "description": "For specific failure modes, the customer can retry without opening a new case."},
]


@router.get("/suggest-best-practice/{event_log_id}")
async def ai_suggest_best_practice(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Ask the LLM which best-practice patterns would most improve the
    discovered process. Returns ranked suggestions with rationale."""
    await _assert_event_log_access(event_log_id, db, current_user)
    context = await _build_log_context(event_log_id, db, current_user)

    practices_str = "\n".join(
        f"- {p['name']}: {p['description']}" for p in _BEST_PRACTICES
    )
    system = (
        "You match best-practice process patterns to discovered process "
        "data. Given a set of candidate practices and the current "
        "process stats, rank the top 3 most applicable practices. "
        "Respond with JSON: "
        '{"recommendations": [{"name": "...", "why": "...", "expected_impact": "..."}]}'
    )
    user_prompt = (
        f"Candidate practices:\n{practices_str}\n\n"
        f"Current process data:\n{context}\n\n"
        "Return the top 3 as JSON."
    )
    with llm.usage_context(
        user=current_user,
        resource_id=str(event_log_id),
        resource_type="event_log",
    ):
        # Best-practice ranking returns structured JSON (workload B): chat model.
        text = llm.complete(
            system, user_prompt, temperature=0.1, model=llm.model_for("chat")
        )
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {"recommendations": [], "raw": text}
    return parsed
