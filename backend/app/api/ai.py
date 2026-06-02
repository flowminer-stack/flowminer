"""LLM-backed AI endpoints.

Provides five distinct capabilities all layered on the same LLM
abstraction in ``app.services.llm``:

  1. POST /ai/chat              — Chat about a specific event log; the
                                  server assembles context (summary,
                                  top bottlenecks, insights) and streams
                                  an answer.
  2. POST /ai/text-to-bpmn      — Convert a natural-language description
                                  into BPMN XML.
  3. POST /ai/agent/run         — Agentic tool-use loop; the model can
                                  call discover/conformance/insights etc.
                                  as tools until it decides it has enough.
  4. GET  /ai/narrate/{id}      — Generate a Markdown document describing
                                  a discovered process, ready to paste
                                  into Confluence / Notion.
  5. GET  /ai/suggest-best-practice/{id} — Compare the discovered model
                                  against a small library of best-practice
                                  BPMN snippets and return the top matches.

All endpoints work end-to-end without credentials thanks to the null
provider in ``llm.py`` — they return a templated fallback instead.
"""

from __future__ import annotations

import json
import logging
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.api.mining import _assert_event_log_access, _load_event_log_and_df
from app.database import get_db
from app.models import User
from app.services import llm
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
    from app.api.mining import _assert_event_log_access
    from app.services.result_cache import cache_get

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
    from app.services import chat_tools

    await _assert_event_log_access(body.event_log_id, db, current_user)
    context = await _build_log_context(body.event_log_id, db, current_user)
    is_ocel = await _is_ocel_log(body.event_log_id, db)

    user_prompt = (
        f"Context for the event log the user is asking about:\n\n{context}\n\n"
        f"User question: {body.question}"
    )

    if not body.stream:
        text = llm.complete(_SYSTEM_PROMPT, user_prompt)
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

    async def _gen_tools():
        import logging as _log
        _logger = _log.getLogger(__name__)
        try:
            async for event in llm.stream_with_tools(
                _TOOL_SYSTEM_PROMPT,
                user_prompt,
                chat_tools.CHAT_TOOL_SCHEMAS,
                _tool_runner,
                temperature=0.2,
                max_turns=5,
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
        try:
            async for chunk in llm.stream(_SYSTEM_PROMPT, user_prompt):
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

    from app.api.mining import _get_cached, _set_cached
    from app.services.result_cache import cache_get as _raw_cache_get
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


# ─── 2. Text-to-BPMN ─────────────────────────────────────────────────────


class TextToBpmnRequest(BaseModel):
    description: str


@router.post("/text-to-bpmn")
async def ai_text_to_bpmn(
    body: TextToBpmnRequest,
    _current_user: User = Depends(get_current_active_user),
):
    """Convert a natural-language description into BPMN XML.

    The LLM is told to emit valid BPMN 2.0 XML and nothing else. We
    post-process to strip any markdown fences and validate the result
    looks like XML before returning.
    """
    sys_prompt = (
        "You generate valid BPMN 2.0 XML from natural-language process "
        "descriptions. Respond with the XML and nothing else — no "
        "explanation, no markdown fences. Use exclusive gateways for "
        "decisions and parallel gateways for concurrent paths. Always "
        "include the bpmndi diagram section so the result is renderable."
    )
    xml = llm.complete(sys_prompt, body.description, temperature=0.1)

    # Strip markdown fences if the model wrapped the output
    stripped = xml.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        # Drop the opening and closing fences
        lines = [l for l in lines if not l.startswith("```")]
        stripped = "\n".join(lines)

    if "<bpmn" not in stripped and "<?xml" not in stripped:
        # Fallback: wrap the null-provider notice as a comment in a
        # minimal BPMN stub so the UI can still render something.
        stripped = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!-- ' + stripped.replace("-->", "--") + ' -->\n'
            '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">\n'
            '  <bpmn:process id="Process_1" isExecutable="true"/>\n'
            '</bpmn:definitions>'
        )

    return {"bpmn_xml": stripped, "llm_configured": llm.is_llm_configured()}


# ─── 3. Agentic tool-use loop ────────────────────────────────────────────


_AGENT_TOOLS = [
    {
        "name": "get_log_summary",
        "description": "Get summary statistics for an event log (total cases, events, activities, average duration).",
        "input_schema": {
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    },
    {
        "name": "get_bottlenecks",
        "description": "Get the top bottleneck activities for an event log.",
        "input_schema": {
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}, "limit": {"type": "integer", "default": 5}},
            "required": ["event_log_id"],
        },
    },
    {
        "name": "get_variants",
        "description": "Get the top process variants ranked by frequency.",
        "input_schema": {
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}, "limit": {"type": "integer", "default": 5}},
            "required": ["event_log_id"],
        },
    },
    {
        "name": "get_insights",
        "description": "Get the automated plain-language insights for an event log.",
        "input_schema": {
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    },
    {
        "name": "run_conformance",
        "description": "Run alignment-based conformance checking on an event log.",
        "input_schema": {
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    },
]


class AgentRequest(BaseModel):
    event_log_id: UUID
    instruction: str


@router.post("/agent/run")
async def ai_agent_run(
    body: AgentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Run an agentic loop — the LLM can call any of the registered tools
    until it decides it has enough information to answer the instruction.

    Tools are authorized against the caller's own access — an agent can
    only query event logs the user can already see.
    """
    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    def _tool_runner(name: str, args: dict):
        # All tools operate on the same df we already loaded for this
        # request. The `event_log_id` in the tool args is ignored — the
        # loop is scoped to the single log the user asked about.
        if name == "get_log_summary":
            return mining_engine.compute_statistics(df)
        if name == "get_bottlenecks":
            b = mining_engine.run_bottleneck_analysis(df)
            limit = int(args.get("limit", 5))
            return {"bottlenecks": b.get("bottlenecks", [])[:limit]}
        if name == "get_variants":
            v = mining_engine.run_variant_analysis(df)
            limit = int(args.get("limit", 5))
            return {"variants": v.get("variants", [])[:limit], "total_variants": v.get("total_variants")}
        if name == "get_insights":
            return mining_engine.generate_insights(df)
        if name == "run_conformance":
            return mining_engine.run_conformance(df, method="alignment")
        return {"error": f"unknown tool {name}"}

    system = (
        "You are an autonomous process mining analyst. Use the provided "
        "tools to gather evidence about the event log the user is asking "
        "about, then answer their instruction with specific numbers. "
        "Prefer calling multiple tools before answering. Stop when you "
        "have enough data to give a concrete, actionable response."
    )
    user_msg = f"Event log id: {body.event_log_id}\n\nInstruction: {body.instruction}"

    import asyncio as _asyncio

    result = await _asyncio.to_thread(
        llm.call_with_tools,
        system,
        user_msg,
        _AGENT_TOOLS,
        temperature=0.2,
        max_turns=5,
        tool_runner=_tool_runner,
    )
    return result


# ─── 4. Narrate (Markdown doc generation) ────────────────────────────────


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
    text = llm.complete(system, user_prompt)
    return {"markdown": text, "llm_configured": llm.is_llm_configured()}


# ─── 5. Suggest best-practice ────────────────────────────────────────────


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
    text = llm.complete(system, user_prompt, temperature=0.1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {"recommendations": [], "raw": text}
    return parsed


# ─── 6. Per-variant root-cause explanation ───────────────────────────────
#
# User clicks "Why?" on a specific variant in VariantExplorer. We compare
# that variant's cases against the rest of the log and ask the LLM to
# explain the delta in plain English. The structured stats are computed
# deterministically — the LLM only turns them into prose.


class ExplainVariantRequest(BaseModel):
    event_log_id: UUID
    # The exact ordered activity list that defines this variant. We
    # match cases whose sequence equals this tuple. The frontend has
    # this from the variant response already, so there's no ambiguity.
    variant_activities: list[str]


class ExplainVariantResponse(BaseModel):
    explanation: str
    stats: dict
    llm_configured: bool


@router.post("/explain-variant", response_model=ExplainVariantResponse)
async def ai_explain_variant(
    body: ExplainVariantRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Explain why a specific process variant takes the time it does,
    and what distinguishes its cases from the rest of the log.

    Pipeline:
      1. Load the event log.
      2. Find the set of case_ids whose ordered activity sequence
         matches the variant.
      3. Compute deltas vs the rest of the log:
           - average case duration (ratio + absolute)
           - top resources on this variant vs overall
           - longest activity in this variant by avg duration
           - top root-cause attribute for the case subset (if any)
           - compare against the happy-path (top variant) duration
      4. Pass the structured stats to the LLM with a strict
         ground-the-numbers prompt.
      5. Return ``{explanation, stats, llm_configured}`` — the UI
         renders the explanation and keeps the stats for a details
         section.
    """
    import asyncio as _asyncio

    from app.services.ingestion import CASE_COL, ACTIVITY_COL, TIMESTAMP_COL, RESOURCE_COL

    await _assert_event_log_access(body.event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(body.event_log_id, db, current_user)

    variant_tuple = tuple(body.variant_activities)
    if not variant_tuple:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="variant_activities must be a non-empty list",
        )

    def _compute_stats() -> dict:
        """Heavy pandas work — runs in the threadpool."""
        import pandas as pd

        # Per-case ordered activity sequence.
        sorted_df = df.sort_values([CASE_COL, TIMESTAMP_COL])
        case_sequences = sorted_df.groupby(CASE_COL)[ACTIVITY_COL].apply(tuple)
        matching_mask = case_sequences == variant_tuple
        variant_cases = set(case_sequences[matching_mask].index)
        other_cases = set(case_sequences[~matching_mask].index)

        case_times = sorted_df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        case_times["_duration"] = (
            case_times["max"] - case_times["min"]
        ).dt.total_seconds()

        variant_durations = case_times.loc[
            case_times.index.isin(variant_cases), "_duration"
        ].dropna()
        other_durations = case_times.loc[
            case_times.index.isin(other_cases), "_duration"
        ].dropna()

        v_avg = float(variant_durations.mean()) if len(variant_durations) > 0 else 0.0
        o_avg = float(other_durations.mean()) if len(other_durations) > 0 else 0.0
        ratio = (v_avg / o_avg) if o_avg > 0 else None

        # Happy path comparison
        happy_path = None
        try:
            variants_all = mining_engine.run_variant_analysis(df).get("variants", [])
            if variants_all:
                happy = variants_all[0]
                happy_path = {
                    "activities": list(happy.get("activities") or []),
                    "case_count": int(happy.get("frequency") or 0),
                    "avg_duration": float(happy.get("avg_duration") or 0),
                }
        except Exception as e:
            logger.warning("explain-variant: variant analysis failed: %s", e)

        # Activity durations within this variant — which step is the
        # slowest when cases follow this specific path?
        longest_step = None
        try:
            subset = sorted_df[sorted_df[CASE_COL].isin(variant_cases)]
            if not subset.empty:
                subset = subset.copy()
                subset["_ts"] = subset[TIMESTAMP_COL]
                per_case = subset.sort_values([CASE_COL, "_ts"])
                per_case["_next_ts"] = per_case.groupby(CASE_COL)["_ts"].shift(-1)
                per_case["_dwell"] = (
                    per_case["_next_ts"] - per_case["_ts"]
                ).dt.total_seconds()
                dwell_per_act = (
                    per_case.dropna(subset=["_dwell"])
                    .groupby(ACTIVITY_COL)["_dwell"]
                    .mean()
                    .sort_values(ascending=False)
                )
                if not dwell_per_act.empty:
                    act = str(dwell_per_act.index[0])
                    longest_step = {
                        "activity": act,
                        "avg_seconds": float(dwell_per_act.iloc[0]),
                    }
        except Exception as e:
            logger.warning("explain-variant: step duration calc failed: %s", e)

        # Resource concentration within the variant vs everywhere else.
        top_resources: list[dict] = []
        other_top_resources: list[dict] = []
        try:
            if RESOURCE_COL in df.columns:
                v_subset = df[df[CASE_COL].isin(variant_cases)]
                o_subset = df[df[CASE_COL].isin(other_cases)]

                def _top(dfx) -> list[dict]:
                    if dfx.empty:
                        return []
                    counts = dfx[RESOURCE_COL].dropna().value_counts().head(3)
                    total = int(counts.sum()) or 1
                    return [
                        {"name": str(r), "share": round(float(c) / total, 3)}
                        for r, c in counts.items()
                    ]

                top_resources = _top(v_subset)
                other_top_resources = _top(o_subset)
        except Exception as e:
            logger.warning("explain-variant: resource calc failed: %s", e)

        # Top distinguishing attribute via root cause, scoped to the
        # subset — uses existing mining_engine code, so we inherit its
        # column-discovery logic.
        root_cause_factor: dict | None = None
        try:
            rc = mining_engine.run_root_cause_analysis(df)
            factors = rc.get("factors", [])
            # Find the first factor whose affected-case subset
            # overlaps significantly with our variant cases.
            for f in factors[:5]:
                cases_with_attr = set(f.get("case_ids") or [])
                if not cases_with_attr:
                    continue
                overlap = len(cases_with_attr & variant_cases)
                if overlap / max(len(variant_cases), 1) > 0.5:
                    root_cause_factor = {
                        "attribute": f.get("attribute"),
                        "value": f.get("value"),
                        "avg_duration_affected": f.get("avg_duration_affected"),
                        "avg_duration_normal": f.get("avg_duration_normal"),
                        "overlap_pct": round(overlap / max(len(variant_cases), 1), 3),
                    }
                    break
        except Exception as e:
            logger.warning("explain-variant: root cause lookup failed: %s", e)

        return {
            "variant_case_count": len(variant_cases),
            "other_case_count": len(other_cases),
            "variant_avg_duration_seconds": v_avg,
            "other_avg_duration_seconds": o_avg,
            "duration_ratio": ratio,
            "activities": list(variant_tuple),
            "longest_step": longest_step,
            "top_resources_in_variant": top_resources,
            "top_resources_in_other": other_top_resources,
            "root_cause_factor": root_cause_factor,
            "happy_path": happy_path,
        }

    stats = await _asyncio.to_thread(_compute_stats)

    if stats["variant_case_count"] == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No cases match the given variant in this event log.",
        )

    def _fmt_dur(s: float) -> str:
        if s < 60:
            return f"{s:.0f}s"
        if s < 3600:
            return f"{s/60:.1f}m"
        if s < 86400:
            return f"{s/3600:.1f}h"
        return f"{s/86400:.1f}d"

    # Compact human-friendly summary for the LLM. We precompute the
    # phrases so the model never has to interpret raw seconds.
    summary_lines = [
        f"Cases in this variant: {stats['variant_case_count']}",
        f"Cases in other variants: {stats['other_case_count']}",
        f"This variant avg duration: {_fmt_dur(stats['variant_avg_duration_seconds'])}",
        f"All other variants avg duration: {_fmt_dur(stats['other_avg_duration_seconds'])}",
    ]
    if stats["duration_ratio"] is not None:
        summary_lines.append(
            f"Duration ratio: {stats['duration_ratio']:.2f}x "
            f"({'slower' if stats['duration_ratio'] > 1 else 'faster'} than other variants)"
        )
    summary_lines.append(
        f"Activity sequence ({len(stats['activities'])} steps): "
        + " → ".join(stats["activities"][:20])
        + (" …" if len(stats["activities"]) > 20 else "")
    )
    if stats["longest_step"]:
        summary_lines.append(
            f"Slowest step inside this variant: "
            f"{stats['longest_step']['activity']} "
            f"(avg dwell {_fmt_dur(stats['longest_step']['avg_seconds'])})"
        )
    if stats["top_resources_in_variant"]:
        summary_lines.append(
            "Top resources handling this variant: "
            + ", ".join(
                f"{r['name']} ({r['share']*100:.0f}%)"
                for r in stats["top_resources_in_variant"]
            )
        )
    if stats["top_resources_in_other"]:
        summary_lines.append(
            "Top resources on other variants: "
            + ", ".join(
                f"{r['name']} ({r['share']*100:.0f}%)"
                for r in stats["top_resources_in_other"]
            )
        )
    if stats["root_cause_factor"]:
        rcf = stats["root_cause_factor"]
        summary_lines.append(
            f"Correlating attribute: {rcf.get('attribute')} = {rcf.get('value')!r} "
            f"covers {rcf.get('overlap_pct', 0)*100:.0f}% of these cases"
        )
    if stats["happy_path"]:
        hp = stats["happy_path"]
        summary_lines.append(
            f"Happy path: {' → '.join(hp['activities'][:10])}"
            + (" …" if len(hp["activities"]) > 10 else "")
            + f" ({hp['case_count']} cases, "
            f"avg {_fmt_dur(hp['avg_duration'])})"
        )

    stats_block = "\n".join(f"  - {line}" for line in summary_lines)

    system = (
        "You are FlowMiner's process-mining analyst. You will be given "
        "structured delta statistics comparing one process variant "
        "against all other cases in the same event log. Your job is to "
        "explain in plain business English WHY this variant behaves "
        "the way it does, grounded only in the numbers provided. "
        "Rules:\n"
        "  1. Never cite a number that isn't in the stats block. Never "
        "invent activities, resources, or attributes.\n"
        "  2. Open with one sentence summarising whether this variant "
        "is faster, slower, or average — and by how much.\n"
        "  3. Give the most likely reason (longest step, resource "
        "concentration, correlating attribute, or structural deviation "
        "from the happy path) and tie it to the stat that supports it.\n"
        "  4. Finish with exactly 2 concrete next steps a process "
        "owner could take THIS WEEK.\n"
        "  5. Plain text. No markdown headings. Under 180 words."
    )
    user_prompt = (
        "Delta stats for this variant vs the rest of the log:\n\n"
        f"{stats_block}\n\n"
        "Explain this variant now."
    )

    text = await _asyncio.to_thread(
        llm.complete, system, user_prompt, temperature=0.2
    )

    return ExplainVariantResponse(
        explanation=text.strip(),
        stats=stats,
        llm_configured=llm.is_llm_configured(),
    )


# ─── 7. Plain-language Explain (bottleneck / conformance / prediction) ───────
#
# A lightweight endpoint that generates a 1-2 sentence plain-English
# explanation for a single bottleneck row or conformance deviation.
# Designed to be called inline from the UI "Explain" button; results
# are cheap enough to not need heavy caching for v1.
#
# The endpoint works end-to-end even when the LLM is unconfigured —
# it falls back to a per-kind templated string and sets
# ``fallback_used=True`` so the client can render a small disclaimer.


_EXPLAIN_SYSTEM = (
    "You are a concise process-mining analyst assistant. "
    "Output only plain English. "
    "Maximum 2 sentences for the explanation field. "
    "Maximum 1 sentence for the actionable_hint field. "
    "Never invent activity names, resource names, or numbers not in the "
    "user input. "
    'Respond with valid JSON in this exact shape: '
    '{"explanation": "<1-2 sentences>", "actionable_hint": "<1 sentence or null>"}'
)

_EXPLAIN_USER_TEMPLATES: dict[str, str] = {
    "bottleneck": (
        "You are explaining a process-mining finding to a business analyst. "
        "Activity '{activity}' has an average duration of {avg_duration_human} "
        "(median {median_duration_human}) and severity '{severity}'. "
        "In ≤2 sentences, plainly explain what this likely means and include "
        "1 short suggestion as actionable_hint. "
        "Do not invent activity names or attributes not in the context."
    ),
    "conformance": (
        "Explain this process deviation to a business analyst in ≤2 sentences. "
        "Case '{case_id}' shows a '{deviation_type}' deviation involving "
        "activity '{activity}'. "
        "Plainly state what this kind of deviation means in process terms "
        "and provide one short way to investigate as actionable_hint."
    ),
    "prediction": (
        "Explain this process prediction to a business analyst in ≤2 sentences. "
        "The prediction context is: {context_summary}. "
        "Plainly state what this prediction means and provide one short "
        "next step as actionable_hint."
    ),
}

_EXPLAIN_FALLBACKS: dict[str, tuple[str, str]] = {
    "bottleneck": (
        "This activity is among the slowest in the process.",
        "Consider examining waiting times and resource availability.",
    ),
    "conformance": (
        "This case did not follow the expected process flow.",
        "Review whether the deviation is intentional or indicates a process gap.",
    ),
    "prediction": (
        "This prediction reflects historical patterns in your event log.",
        "Consider verifying the underlying assumptions.",
    ),
}


def _fmt_seconds(s: float | int | None) -> str:
    """Human-readable duration from seconds."""
    if s is None:
        return "unknown"
    s = float(s)
    if s < 60:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s/60:.1f}m"
    if s < 86400:
        return f"{s/3600:.1f}h"
    return f"{s/86400:.1f}d"


class ExplainRequest(BaseModel):
    kind: Literal["bottleneck", "conformance", "prediction"]
    context: dict  # small JSON supplied by the frontend


class ExplainResponse(BaseModel):
    explanation: str          # 1-2 sentences max
    actionable_hint: str | None
    fallback_used: bool       # True when LLM unavailable/errored


@router.post("/explain", response_model=ExplainResponse)
async def ai_explain(
    body: ExplainRequest,
    current_user: User = Depends(get_current_active_user),
):
    """Return a 1-2 sentence plain-language explanation for a single
    bottleneck row or conformance deviation.

    The endpoint is intentionally lightweight — no event log is loaded,
    no DataFrame work runs.  The caller passes a small ``context`` dict
    with the fields it already has from the mining response.

    Defensive fallback: if the LLM provider is unconfigured, times out,
    or returns unparseable JSON, a templated string is returned with
    ``fallback_used=True``.
    """
    import asyncio as _asyncio

    kind = body.kind
    ctx = body.context

    fallback_explanation, fallback_hint = _EXPLAIN_FALLBACKS.get(
        kind, ("No explanation available.", None)
    )

    # Build the user prompt from the kind-specific template.
    try:
        if kind == "bottleneck":
            user_prompt = _EXPLAIN_USER_TEMPLATES["bottleneck"].format(
                activity=ctx.get("activity", "unknown"),
                avg_duration_human=_fmt_seconds(ctx.get("avg_duration_s") or ctx.get("avg_duration")),
                median_duration_human=_fmt_seconds(ctx.get("median_duration_s") or ctx.get("median_duration")),
                severity=ctx.get("severity", "unknown"),
            )
        elif kind == "conformance":
            user_prompt = _EXPLAIN_USER_TEMPLATES["conformance"].format(
                case_id=ctx.get("case_id", "unknown"),
                deviation_type=ctx.get("deviation_type", "unknown"),
                activity=ctx.get("activity", "unknown"),
            )
        else:  # prediction
            summary_parts = [f"{k}={v}" for k, v in list(ctx.items())[:6]]
            user_prompt = _EXPLAIN_USER_TEMPLATES["prediction"].format(
                context_summary=", ".join(summary_parts) or "no details provided",
            )
    except Exception as e:
        logger.warning("ai_explain: prompt build failed for kind=%s: %s", kind, e)
        return ExplainResponse(
            explanation=fallback_explanation,
            actionable_hint=fallback_hint,
            fallback_used=True,
        )

    # Call LLM in thread (sync completion).
    if not llm.is_llm_configured():
        return ExplainResponse(
            explanation=fallback_explanation,
            actionable_hint=fallback_hint,
            fallback_used=True,
        )

    try:
        raw = await _asyncio.to_thread(
            llm.complete, _EXPLAIN_SYSTEM, user_prompt, temperature=0.2
        )
    except Exception as e:
        logger.warning("ai_explain: LLM call failed for kind=%s: %s", kind, e)
        return ExplainResponse(
            explanation=fallback_explanation,
            actionable_hint=fallback_hint,
            fallback_used=True,
        )

    # Parse the JSON the model should have returned.
    try:
        # Strip markdown fences if the model wrapped the JSON.
        stripped = raw.strip()
        if stripped.startswith("```"):
            lines = [l for l in stripped.splitlines() if not l.startswith("```")]
            stripped = "\n".join(lines)
        parsed = json.loads(stripped)
        explanation = str(parsed.get("explanation") or fallback_explanation).strip()
        hint_raw = parsed.get("actionable_hint")
        actionable_hint = str(hint_raw).strip() if hint_raw else None
        return ExplainResponse(
            explanation=explanation,
            actionable_hint=actionable_hint,
            fallback_used=False,
        )
    except (json.JSONDecodeError, Exception) as e:
        logger.warning(
            "ai_explain: could not parse LLM JSON response for kind=%s: %s — "
            "returning raw text as explanation",
            kind, e,
        )
        # Fall back gracefully: use raw text as the explanation rather
        # than the templated string, since the LLM DID respond.
        explanation = raw.strip()[:400]
        return ExplainResponse(
            explanation=explanation or fallback_explanation,
            actionable_hint=None,
            fallback_used=False,
        )


# ─── 8. Event-log extraction copilot ─────────────────────────────────────────
#
# Multi-turn dialog that helps users transform raw source-system tables into
# a valid event log by generating SQL/pandas extraction code with rationale.
# Follows the abstract → prompt → reason pattern from Berti et al. (CoopIS 2024).


class ExtractTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ExtractRequest(BaseModel):
    schema_hint: str | None = None      # optional dump of source-table schemas
    objective: str | None = None         # e.g. "track customer onboarding"
    history: list[ExtractTurn] = []      # conversation so far


class ExtractStep(BaseModel):
    label: str                           # e.g. "Identify case ID"
    rationale: str                       # plain English
    sql: str | None = None               # generated SQL (or None if conversational)
    pandas: str | None = None            # alternative pandas snippet
    columns_used: list[str] = []         # columns/tables this step references


class ExtractResponse(BaseModel):
    assistant_message: str               # next message to user
    suggested_steps: list[ExtractStep]   # any code emitted this turn (may be empty)
    requires_user_input: bool            # true if the agent is asking for clarification
    confidence: float                    # 0-1 self-rated
    fallback_used: bool


_EXTRACT_SYSTEM_PROMPT = (
    "You are an event-log extraction assistant. The user has raw source-system "
    "tables and wants to extract an event log for process mining. Your job: "
    "through conversation, derive a SQL query (or pandas snippet) that produces "
    "columns (case_id, activity, timestamp, resource_id, optional case_attributes).\n\n"
    "Rules:\n"
    "  1. Ask for missing schema info if the user has not described their tables. "
    "Never invent column names — only reference columns the user has confirmed exist.\n"
    "  2. Explain the WHY before any SQL. Each suggested step must have a clear "
    "rationale in plain business English.\n"
    "  3. When proposing SQL, scope it to columns/tables already confirmed by the "
    "user. Use standard ANSI SQL that works on PostgreSQL.\n"
    "  4. Rate your own confidence from 0 (completely guessing) to 1 (all columns "
    "confirmed and query is straightforward).\n"
    "  5. Set requires_user_input to true whenever you need the user to confirm "
    "column names, table structures, or business definitions before you can proceed.\n\n"
    "RESPONSE FORMAT — you MUST respond with a single JSON object matching this "
    "exact schema (no markdown fences, no extra text outside the JSON):\n"
    "{\n"
    '  "assistant_message": "<conversational reply to the user>",\n'
    '  "suggested_steps": [\n'
    "    {\n"
    '      "label": "<short step name>",\n'
    '      "rationale": "<plain English why>",\n'
    '      "sql": "<SQL string or null>",\n'
    '      "pandas": "<pandas snippet or null>",\n'
    '      "columns_used": ["<col1>", "<col2>"]\n'
    "    }\n"
    "  ],\n"
    '  "requires_user_input": true,\n'
    '  "confidence": 0.0\n'
    "}"
)

_EXTRACT_FALLBACK = ExtractResponse(
    assistant_message=(
        "LLM provider unavailable. To extract an event log manually: pick the "
        "column that uniquely identifies a process instance (case_id), pick the "
        "column or expression that names what happened (activity), pick the column "
        "with the timestamp, and optionally a resource column. Aggregate one row "
        "per (case_id, activity, timestamp)."
    ),
    suggested_steps=[],
    requires_user_input=True,
    confidence=0.0,
    fallback_used=True,
)


@router.post("/extract-log", response_model=ExtractResponse)
async def ai_extract_log(
    body: ExtractRequest,
    _current_user: User = Depends(get_current_active_user),
):
    """Multi-turn event-log extraction copilot.

    Each call represents one user turn. The client maintains the conversation
    history and passes it back on each request. The server builds a user message
    that incorporates any schema_hint and objective provided, then calls the LLM
    with the full history. The response is parsed as structured JSON (ExtractResponse).

    If the LLM is unavailable or JSON parsing fails, a safe fallback is returned.
    """
    import asyncio as _asyncio

    # Build the current user message — incorporate schema_hint and objective
    # so they flow into the conversation without the frontend needing to repeat
    # them on every turn (the history already carries prior turns).
    user_parts: list[str] = []
    if body.objective:
        user_parts.append(f"Objective: {body.objective}")
    if body.schema_hint:
        user_parts.append(f"Source table schemas:\n{body.schema_hint}")

    # Append the last user message from history if any (the actual question).
    # History is ordered oldest → newest. The last entry with role="user" is
    # the current turn's question; everything before it is prior context.
    last_user_content = ""
    for turn in reversed(body.history):
        if turn.role == "user":
            last_user_content = turn.content
            break

    if last_user_content:
        user_parts.append(last_user_content)

    if not user_parts:
        user_parts.append(
            "Hello! I'd like help extracting an event log from my source tables."
        )

    current_user_msg = "\n\n".join(user_parts)

    # Build the prior conversation context (all turns except the last user turn,
    # which we've already embedded above). We include assistant turns so the
    # LLM remembers what it already suggested.
    prior_turns_text = ""
    if len(body.history) > 1:
        prior_lines: list[str] = []
        # Include all but the last user turn (which is current_user_msg)
        last_user_idx = -1
        for i in range(len(body.history) - 1, -1, -1):
            if body.history[i].role == "user":
                last_user_idx = i
                break
        relevant = body.history[:last_user_idx] if last_user_idx > 0 else []
        for t in relevant:
            role_label = "User" if t.role == "user" else "Assistant"
            prior_lines.append(f"{role_label}: {t.content[:1000]}")
        if prior_lines:
            prior_turns_text = (
                "Prior conversation:\n"
                + "\n---\n".join(prior_lines)
                + "\n\nNow respond to the current user message below."
            )

    full_user_msg = (
        f"{prior_turns_text}\n\n{current_user_msg}".strip()
        if prior_turns_text
        else current_user_msg
    )

    # Call the LLM in a thread (complete() is synchronous)
    try:
        raw = await _asyncio.to_thread(
            llm.complete,
            _EXTRACT_SYSTEM_PROMPT,
            full_user_msg,
            temperature=0.2,
        )
    except Exception as e:
        logger.warning("extract-log LLM call failed: %s", e)
        return _EXTRACT_FALLBACK

    # Check if the null provider returned its sentinel — treat as fallback.
    if "No LLM provider is configured" in raw:
        return _EXTRACT_FALLBACK

    # Parse the structured JSON response. The LLM is instructed to return
    # pure JSON, but may occasionally wrap it in markdown fences or add
    # preamble. We strip fences first, then attempt json.loads. On any
    # failure we degrade to a minimal response with the raw text as the
    # assistant_message so the user sees something useful.
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        lines = [ln for ln in lines if not ln.startswith("```")]
        stripped = "\n".join(lines).strip()

    # Find the outermost JSON object in case there's prose before/after.
    json_start = stripped.find("{")
    json_end = stripped.rfind("}") + 1
    if json_start != -1 and json_end > json_start:
        stripped = stripped[json_start:json_end]

    try:
        parsed = json.loads(stripped)
        steps_raw = parsed.get("suggested_steps") or []
        steps = [
            ExtractStep(
                label=s.get("label", "Step"),
                rationale=s.get("rationale", ""),
                sql=s.get("sql") or None,
                pandas=s.get("pandas") or None,
                columns_used=s.get("columns_used") or [],
            )
            for s in steps_raw
            if isinstance(s, dict)
        ]
        return ExtractResponse(
            assistant_message=str(parsed.get("assistant_message", raw[:800])),
            suggested_steps=steps,
            requires_user_input=bool(parsed.get("requires_user_input", True)),
            confidence=float(parsed.get("confidence", 0.0)),
            fallback_used=False,
        )
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        logger.warning("extract-log JSON parse failed (%s) — degrading to raw text", exc)
        # Graceful degradation: surface the raw text as the assistant message.
        return ExtractResponse(
            assistant_message=raw[:2000],
            suggested_steps=[],
            requires_user_input=True,
            confidence=0.0,
            fallback_used=False,
        )
