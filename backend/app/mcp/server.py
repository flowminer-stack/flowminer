"""FlowMiner MCP server — stdio mode.

Exposes the mining engine as MCP tools so any MCP-aware client (Claude
Desktop, Cursor, Zed, Bedrock, etc.) can ask questions about a
FlowMiner event log and get back grounded numeric answers.

Run from inside the backend container:

    docker exec -it processmining-backend-1 python3 -m app.mcp.server

Authentication
--------------
The server is intended to be run as a subprocess by a trusted client
on the same host (that's the MCP stdio model). It still needs to
scope access to a single user account so the tool results only
contain event logs that user can see via the REST API. Configure the
user by setting ``FLOWMINER_MCP_USER_EMAIL`` in the environment — the
server looks up that user once at startup and treats every tool call
as coming from them. When unset, the server refuses to start rather
than silently exposing all data.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any
from uuid import UUID

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

logger = logging.getLogger("flowminer.mcp")


# ── Tool schemas ─────────────────────────────────────────────────────
#
# One schema per mining-engine function we want to expose. Keep
# descriptions crisp and parameters tightly typed so the calling
# LLM hallucinates args less often.

_TOOL_SCHEMAS: list[Tool] = [
    Tool(
        name="list_event_logs",
        description=(
            "List event logs the current user can access. Returns an "
            "array of {id, name, project, total_cases, total_events, "
            "created_at} objects. Always call this first to discover "
            "what logs exist before asking about a specific one."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Max logs to return (default 20).",
                    "default": 20,
                    "minimum": 1,
                    "maximum": 100,
                }
            },
            "required": [],
        },
    ),
    Tool(
        name="get_log_summary",
        description=(
            "Get the headline stats for one event log — total cases, "
            "total events, unique activities, date range, average case "
            "duration. Use this to orient yourself before drilling into "
            "bottlenecks or variants."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "event_log_id": {
                    "type": "string",
                    "description": "UUID of the event log to summarise.",
                }
            },
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_bottlenecks",
        description=(
            "Return the activities with the longest average duration "
            "in the given event log. Each entry has activity, "
            "avg_duration_seconds, frequency, and is_bottleneck flag."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "event_log_id": {"type": "string"},
                "top_n": {
                    "type": "integer",
                    "description": "Max bottlenecks to return.",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 50,
                },
            },
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_variants",
        description=(
            "Return the most common execution paths through the "
            "process, ranked by case count. Each variant has an "
            "activity list and a case_count."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "event_log_id": {"type": "string"},
                "top_n": {
                    "type": "integer",
                    "description": "Max variants to return.",
                    "default": 10,
                    "minimum": 1,
                    "maximum": 50,
                },
            },
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_rework",
        description=(
            "Return activity-level rework rates and the cases-with-"
            "rework count. Each entry is {activity, rework_rate, "
            "rework_count}."
        ),
        inputSchema={
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_conformance",
        description=(
            "Run token-based conformance checking against an inductive-"
            "miner model and return fitness, precision, and the list "
            "of deviations."
        ),
        inputSchema={
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_dfg",
        description=(
            "Return the directly-follows graph as a list of {source, "
            "target, count} edges. Useful for drawing or reasoning "
            "about the process topology."
        ),
        inputSchema={
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="get_insights",
        description=(
            "Return the automated plain-language insights (bottlenecks, "
            "waiting times, rework, variants, conformance) computed "
            "by the mining engine — the same set the web UI displays."
        ),
        inputSchema={
            "type": "object",
            "properties": {"event_log_id": {"type": "string"}},
            "required": ["event_log_id"],
        },
    ),
    Tool(
        name="ask_natural_language",
        description=(
            "Delegate an open-ended question about the log to the "
            "FlowMiner chat endpoint. Returns a fully narrated answer "
            "with references to real numbers. Use this when the "
            "user's question doesn't map cleanly to one of the "
            "structured tools above."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "event_log_id": {"type": "string"},
                "question": {
                    "type": "string",
                    "description": "Free-form question in English.",
                },
            },
            "required": ["event_log_id", "question"],
        },
    ),
]


# ── Request context ──────────────────────────────────────────────────


class _Ctx:
    """Container for the resolved user + DB factory used by tool
    handlers. Populated once at startup so every tool call can run
    without re-looking-up the user every time."""

    user_email: str | None = None
    user = None  # app.models.User


_ctx = _Ctx()


async def _resolve_user() -> None:
    """Load the FlowMiner user named by FLOWMINER_MCP_USER_EMAIL."""
    from sqlalchemy import select

    from app.database import async_session
    from app.models import User

    email = os.getenv("FLOWMINER_MCP_USER_EMAIL", "").strip()
    if not email:
        raise RuntimeError(
            "FLOWMINER_MCP_USER_EMAIL is required. Set it to the email "
            "of the FlowMiner user whose logs the MCP server should "
            "expose."
        )
    async with async_session() as db:
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user is None:
            raise RuntimeError(f"User {email!r} not found.")
        _ctx.user = user
        _ctx.user_email = email
    logger.info("MCP server bound to user %s", email)


# ── Helpers ──────────────────────────────────────────────────────────


def _text(obj: Any) -> list[TextContent]:
    """Render an arbitrary object as a single TextContent block."""
    try:
        payload = json.dumps(obj, indent=2, default=str)
    except Exception:
        payload = str(obj)
    return [TextContent(type="text", text=payload)]


def _parse_uuid(raw: Any) -> UUID:
    try:
        return UUID(str(raw))
    except Exception as e:
        raise ValueError(f"event_log_id must be a UUID, got {raw!r}") from e


async def _load_df(event_log_id: UUID):
    """Load the (event_log, df) pair using the same guarded path the
    REST API uses. Raises if the user can't access the log."""
    from app.api._mining_deps import _load_event_log_and_df
    from app.database import async_session

    async with async_session() as db:
        return await _load_event_log_and_df(event_log_id, db, _ctx.user)


# ── Tool dispatchers ─────────────────────────────────────────────────


async def _tool_list_event_logs(args: dict) -> list[TextContent]:
    from sqlalchemy import select

    from app.api.deps import _user_can_access_project
    from app.database import async_session
    from app.models import EventLog, Project

    limit = int(args.get("limit", 20))
    async with async_session() as db:
        result = await db.execute(
            select(EventLog).order_by(EventLog.created_at.desc()).limit(500)
        )
        rows = result.scalars().all()
        out: list[dict] = []
        for log in rows:
            proj_result = await db.execute(
                select(Project).where(Project.id == log.project_id)
            )
            project = proj_result.scalar_one_or_none()
            if project is None or not _user_can_access_project(_ctx.user, project):
                continue
            out.append(
                {
                    "id": str(log.id),
                    "name": log.name,
                    "project": project.name,
                    "log_type": log.log_type.value
                    if hasattr(log.log_type, "value")
                    else str(log.log_type),
                    "created_at": log.created_at.isoformat()
                    if log.created_at
                    else None,
                }
            )
            if len(out) >= limit:
                break
    return _text({"event_logs": out, "count": len(out)})


async def _tool_get_log_summary(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    stats = mining_engine.compute_statistics(df)
    return _text(
        {
            "event_log_id": str(event_log.id),
            "name": event_log.name,
            "total_cases": stats.get("total_cases"),
            "total_events": stats.get("total_events"),
            "total_activities": stats.get("total_activities"),
            "avg_case_duration_seconds": stats.get("avg_case_duration_seconds"),
            "date_range": stats.get("date_range"),
        }
    )


async def _tool_get_bottlenecks(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    top_n = max(1, min(int(args.get("top_n", 10)), 50))
    result = mining_engine.run_bottleneck_analysis(df)
    bottlenecks = result.get("bottlenecks", [])[:top_n]
    return _text({"bottlenecks": bottlenecks, "total": len(bottlenecks)})


async def _tool_get_variants(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    top_n = max(1, min(int(args.get("top_n", 10)), 50))
    result = mining_engine.run_variant_analysis(df)
    return _text(
        {
            "variants": result.get("variants", [])[:top_n],
            "total_variants": result.get("total_variants"),
        }
    )


async def _tool_get_rework(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    return _text(mining_engine.get_rework(df))


async def _tool_get_conformance(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    return _text(mining_engine.run_conformance(df, method="token_replay"))


async def _tool_get_dfg(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    return _text(mining_engine.discover_process(df, algorithm="dfg"))


async def _tool_get_insights(args: dict) -> list[TextContent]:
    from app.services.mining_engine import mining_engine

    _event_log, df = await _load_df(_parse_uuid(args["event_log_id"]))
    return _text(mining_engine.generate_insights(df))


async def _tool_ask_natural_language(args: dict) -> list[TextContent]:
    """Delegate to the FlowMiner chat endpoint by running the same
    pipeline inline. Returns a fully-narrated text answer; any charts
    or filter proposals from the tool loop are flattened into text
    summaries for MCP consumption (MCP clients don't render charts
    today — that's the web UI's job)."""
    from app.api.ai import _SYSTEM_PROMPT, _build_log_context
    from app.database import async_session
    from app.services.ai import llm

    event_log_id = _parse_uuid(args["event_log_id"])
    question = str(args.get("question") or "").strip()
    if not question:
        raise ValueError("question must be a non-empty string")

    async with async_session() as db:
        context = await _build_log_context(event_log_id, db, _ctx.user)

    user_prompt = (
        f"Context for the event log the user is asking about:\n\n{context}\n\n"
        f"User question: {question}"
    )
    text = llm.complete(_SYSTEM_PROMPT, user_prompt)
    return _text({"answer": text, "llm_configured": llm.is_llm_configured()})


_DISPATCH = {
    "list_event_logs": _tool_list_event_logs,
    "get_log_summary": _tool_get_log_summary,
    "get_bottlenecks": _tool_get_bottlenecks,
    "get_variants": _tool_get_variants,
    "get_rework": _tool_get_rework,
    "get_conformance": _tool_get_conformance,
    "get_dfg": _tool_get_dfg,
    "get_insights": _tool_get_insights,
    "ask_natural_language": _tool_ask_natural_language,
}


# ── Server wiring ────────────────────────────────────────────────────


def _build_server() -> Server:
    server: Server = Server("flowminer-mcp")

    @server.list_tools()
    async def _list_tools() -> list[Tool]:
        return _TOOL_SCHEMAS

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict) -> list[TextContent]:
        handler = _DISPATCH.get(name)
        if handler is None:
            raise ValueError(f"Unknown tool: {name}")
        try:
            return await handler(arguments or {})
        except Exception as e:
            logger.exception("tool %s failed", name)
            return _text({"error": f"{type(e).__name__}: {str(e)[:240]}"})

    return server


async def _async_main() -> None:
    logging.basicConfig(
        level=os.getenv("FLOWMINER_MCP_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(name)s [%(levelname)s] %(message)s",
        stream=sys.stderr,
    )
    await _resolve_user()
    server = _build_server()
    async with stdio_server() as (read_stream, write_stream):
        init = server.create_initialization_options()
        await server.run(read_stream, write_stream, init)


def main() -> None:
    try:
        asyncio.run(_async_main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.exception("flowminer-mcp crashed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
