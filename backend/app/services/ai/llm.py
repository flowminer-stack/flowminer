"""LLM provider abstraction.

Supports five providers and an auto-fallback order:
  1. ``anthropic``  — Claude via the official anthropic SDK
  2. ``openai``     — GPT via the openai SDK (Azure OpenAI also works)
  3. ``openrouter`` — OpenRouter aggregator (uses the openai SDK with a
                      custom base URL; any model name OpenRouter exposes
                      is valid, e.g. ``anthropic/claude-haiku-4-5``,
                      ``openai/gpt-4o-mini``, ``meta-llama/llama-3.1-70b``)
  4. ``ollama``     — local Ollama HTTP API (great for air-gapped)
  5. ``null``       — returns a templated response instead of calling an LLM
                      (used when no provider is configured, so the UI
                      still works end-to-end for dev and demos)

The null provider is important: it means the LLM-backed features can
ship in the OSS default install without any credentials, and a user
who wires in a real provider gets an upgrade for free.

Environment variables:
  FLOWMINER_LLM_PROVIDER   anthropic | openai | openrouter | ollama | null
                           (default: null)
  ANTHROPIC_API_KEY        for the anthropic provider
  ANTHROPIC_MODEL          e.g. claude-sonnet-4-6 (default: claude-sonnet-4-6)
  OPENAI_API_KEY           for the openai provider
  OPENAI_MODEL             e.g. gpt-4o-mini (default)
  OPENROUTER_API_KEY       for the openrouter provider
  OPENROUTER_MODEL         e.g. anthropic/claude-haiku-4-5 (default)
  OPENROUTER_SITE_URL      optional ``HTTP-Referer`` header OpenRouter shows
                           on its rankings page. Harmless if unset.
  OPENROUTER_APP_NAME      optional ``X-Title`` header same purpose
  OLLAMA_HOST              e.g. http://localhost:11434 (default)
  OLLAMA_MODEL             e.g. llama3.1 (default)
"""

from __future__ import annotations

import json
import logging
import os
from typing import AsyncIterator, Iterable

import httpx

logger = logging.getLogger(__name__)


class LLMError(Exception):
    pass


def _from_system_settings(key: str) -> str | None:
    """Best-effort read from the encrypted system_settings table.

    Wrapped in a broad try/except because this function is called
    from hot LLM paths — if Postgres is unreachable or the table
    doesn't exist yet (e.g. before the first migration runs) we
    should silently fall through to env vars, not blow up the
    chat endpoint.
    """
    try:
        from app.services.system_settings import get_setting
        return get_setting(key)
    except Exception:
        return None


def _config(setting_key: str, env_key: str, default: str = "") -> str:
    """Resolve a config value from (1) system_settings table,
    (2) environment variable, (3) ``default``. The DB value wins
    when set so the Settings UI can override ``.env``."""
    db_val = _from_system_settings(setting_key)
    if db_val:
        return str(db_val)
    env_val = os.getenv(env_key, "").strip()
    if env_val:
        return env_val
    return default


def _provider() -> str:
    return _config("llm.provider", "FLOWMINER_LLM_PROVIDER", "null").lower()


def _api_key(provider: str | None = None) -> str:
    """Return the API key for the given provider, looking in
    system_settings first, then the provider-specific env var."""
    provider = (provider or _provider()).lower()
    # All providers share a single ``llm.api_key`` row in the DB
    # because the operator picks ONE provider at a time from the
    # Settings UI. The env var fallback is provider-specific so
    # legacy ``.env`` files with multiple keys still work.
    db_val = _from_system_settings("llm.api_key")
    if db_val:
        return str(db_val)
    env_key_map = {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
    }
    env_key = env_key_map.get(provider)
    return os.getenv(env_key, "").strip() if env_key else ""


def _model(provider: str | None = None) -> str:
    provider = (provider or _provider()).lower()
    db_val = _from_system_settings("llm.model")
    if db_val:
        return str(db_val)
    env_key_map = {
        "anthropic": ("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        "openai": ("OPENAI_MODEL", "gpt-4o-mini"),
        "openrouter": ("OPENROUTER_MODEL", "anthropic/claude-haiku-4-5"),
        "ollama": ("OLLAMA_MODEL", "llama3.1"),
    }
    env_key, default = env_key_map.get(provider, (None, ""))
    if env_key:
        return os.getenv(env_key, default)
    return default


def is_llm_configured() -> bool:
    """Return True if a real LLM provider is wired up."""
    p = _provider()
    if p == "null":
        return False
    if p == "ollama":
        return True
    # All other providers require an API key — check DB first,
    # then the provider-specific env var.
    return bool(_api_key(p))


def _openrouter_default_headers() -> dict[str, str]:
    """Optional OpenRouter ranking headers. Harmless if unset."""
    headers: dict[str, str] = {}
    site = os.getenv("OPENROUTER_SITE_URL", "").strip()
    app = os.getenv("OPENROUTER_APP_NAME", "FlowMiner").strip()
    if site:
        headers["HTTP-Referer"] = site
    if app:
        headers["X-Title"] = app
    return headers


# ─── Sync (single-shot) completion ────────────────────────────────────────


def complete(system: str, user: str, *, temperature: float = 0.2) -> str:
    """Synchronous single-shot completion. Returns the model's text."""
    p = _provider()
    if p == "null" or not is_llm_configured():
        return _null_complete(system, user)
    try:
        if p == "anthropic":
            return _anthropic_complete(system, user, temperature=temperature)
        if p == "openai":
            return _openai_complete(system, user, temperature=temperature)
        if p == "openrouter":
            return _openrouter_complete(system, user, temperature=temperature)
        if p == "ollama":
            return _ollama_complete(system, user, temperature=temperature)
    except Exception as e:
        logger.warning("LLM provider %s failed (%s) — falling back to null provider", p, e)
    return _null_complete(system, user)


def _anthropic_complete(system: str, user: str, temperature: float) -> str:
    try:
        import anthropic
    except ImportError as e:
        raise LLMError("anthropic SDK not installed") from e

    model = _model("anthropic")
    client = anthropic.Anthropic(api_key=_api_key("anthropic"))
    msg = client.messages.create(
        model=model,
        max_tokens=2048,
        temperature=temperature,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    # Extract text from the content blocks
    parts = []
    for block in msg.content:
        if hasattr(block, "text"):
            parts.append(block.text)
        elif isinstance(block, dict) and "text" in block:
            parts.append(block["text"])
    return "".join(parts)


def _openai_complete(system: str, user: str, temperature: float) -> str:
    try:
        from openai import OpenAI
    except ImportError as e:
        raise LLMError("openai SDK not installed") from e

    model = _model("openai")
    client = OpenAI(api_key=_api_key("openai"))
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return resp.choices[0].message.content or ""


def _openrouter_complete(system: str, user: str, temperature: float) -> str:
    """OpenRouter uses the OpenAI-compatible chat completions API, so we
    reuse the openai SDK with a custom ``base_url`` and auth header.

    This single provider unlocks every model OpenRouter exposes —
    Claude, GPT, Gemini, Llama, DeepSeek, Mistral — under one key."""
    try:
        from openai import OpenAI
    except ImportError as e:
        raise LLMError("openai SDK not installed (required for openrouter)") from e

    model = _model("openrouter")
    client = OpenAI(
        api_key=_api_key("openrouter"),
        base_url="https://openrouter.ai/api/v1",
        default_headers=_openrouter_default_headers() or None,
    )
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return resp.choices[0].message.content or ""


def _ollama_complete(system: str, user: str, temperature: float) -> str:
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    model = os.getenv("OLLAMA_MODEL", "llama3.1")
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(
            f"{host}/api/chat",
            json={
                "model": model,
                "stream": False,
                "options": {"temperature": temperature},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")


def _null_complete(system: str, user: str) -> str:
    """Deterministic templated response used when no LLM is configured.

    The answer includes whatever structured context was passed in the
    user message so the UI demonstrates end-to-end flow even in the
    no-credentials default install.
    """
    preview = user[:800].strip()
    return (
        "⚠️ No LLM provider is configured — set FLOWMINER_LLM_PROVIDER "
        "to anthropic / openai / openrouter / ollama and the matching "
        "API key to enable real AI answers.\n\n"
        "In the meantime, here's what the model would have received "
        "as context:\n\n"
        f"{preview}"
    )


# ─── Streaming completion (for chat UI) ──────────────────────────────────


async def stream(system: str, user: str, *, temperature: float = 0.2) -> AsyncIterator[str]:
    """Async generator yielding text chunks as the model produces them.

    Falls back to yielding the full null-provider response in a single
    chunk if streaming isn't available.
    """
    p = _provider()
    if p == "null" or not is_llm_configured():
        yield _null_complete(system, user)
        return

    try:
        if p == "anthropic":
            async for chunk in _anthropic_stream(system, user, temperature):
                yield chunk
            return
        if p == "openai":
            async for chunk in _openai_stream(system, user, temperature):
                yield chunk
            return
        if p == "openrouter":
            async for chunk in _openrouter_stream(system, user, temperature):
                yield chunk
            return
        if p == "ollama":
            async for chunk in _ollama_stream(system, user, temperature):
                yield chunk
            return
    except Exception as e:
        logger.warning("LLM stream %s failed (%s)", p, e)
    yield _null_complete(system, user)


async def _anthropic_stream(system: str, user: str, temperature: float) -> AsyncIterator[str]:
    try:
        import anthropic
    except ImportError:
        yield _null_complete(system, user)
        return
    model = _model("anthropic")
    client = anthropic.AsyncAnthropic(api_key=_api_key("anthropic"))
    async with client.messages.stream(
        model=model,
        max_tokens=2048,
        temperature=temperature,
        system=system,
        messages=[{"role": "user", "content": user}],
    ) as s:
        async for text in s.text_stream:
            yield text


async def _openai_stream(system: str, user: str, temperature: float) -> AsyncIterator[str]:
    try:
        from openai import AsyncOpenAI
    except ImportError:
        yield _null_complete(system, user)
        return
    model = _model("openai")
    client = AsyncOpenAI(api_key=_api_key("openai"))
    stream = await client.chat.completions.create(
        model=model,
        temperature=temperature,
        stream=True,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            yield delta


async def _openrouter_stream(system: str, user: str, temperature: float) -> AsyncIterator[str]:
    """Streaming via the openai SDK pointed at OpenRouter."""
    try:
        from openai import AsyncOpenAI
    except ImportError:
        yield _null_complete(system, user)
        return
    model = _model("openrouter")
    client = AsyncOpenAI(
        api_key=_api_key("openrouter"),
        base_url="https://openrouter.ai/api/v1",
        default_headers=_openrouter_default_headers() or None,
    )
    stream = await client.chat.completions.create(
        model=model,
        temperature=temperature,
        stream=True,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            yield delta


async def _ollama_stream(system: str, user: str, temperature: float) -> AsyncIterator[str]:
    host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    model = os.getenv("OLLAMA_MODEL", "llama3.1")
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{host}/api/chat",
            json={
                "model": model,
                "stream": True,
                "options": {"temperature": temperature},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = payload.get("message", {}).get("content")
                if content:
                    yield content
                if payload.get("done"):
                    return


# ─── Function/tool-calling abstraction (for the agent loop) ──────────────


def call_with_tools(
    system: str,
    user: str,
    tools: list[dict],
    *,
    temperature: float = 0.2,
    max_turns: int = 5,
    tool_runner=None,
) -> dict:
    """Run an agent loop with tool use.

    ``tools`` is a list of tool schemas in Anthropic's tool-use format
    (name, description, input_schema). ``tool_runner`` is a function
    ``(name, args) -> result_dict`` that actually executes the tool.

    Returns the final assistant text, the list of tool calls and their
    results, and the number of turns.
    """
    p = _provider()
    if p != "anthropic" or not is_llm_configured():
        return {
            "text": _null_complete(system, user),
            "tool_calls": [],
            "turns": 0,
            "provider": p,
            "note": "Agentic tool use requires the anthropic provider; falling back to null.",
        }

    try:
        import anthropic
    except ImportError:
        return {"text": _null_complete(system, user), "tool_calls": [], "turns": 0}

    model = _model("anthropic")
    client = anthropic.Anthropic(api_key=_api_key("anthropic"))

    messages = [{"role": "user", "content": user}]
    tool_calls: list[dict] = []

    for turn in range(max_turns):
        resp = client.messages.create(
            model=model,
            max_tokens=2048,
            temperature=temperature,
            system=system,
            tools=tools,
            messages=messages,
        )
        # Collect any text parts
        text_parts = []
        tool_uses = []
        for block in resp.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                text_parts.append(block.text)
            elif btype == "tool_use":
                tool_uses.append(block)

        if resp.stop_reason == "end_turn" or not tool_uses:
            return {
                "text": "".join(text_parts),
                "tool_calls": tool_calls,
                "turns": turn + 1,
                "provider": p,
            }

        # Execute each tool and append the results
        messages.append({"role": "assistant", "content": resp.content})
        tool_results = []
        for tu in tool_uses:
            name = tu.name
            args = tu.input or {}
            try:
                result = tool_runner(name, args) if tool_runner else {"error": "no runner"}
            except Exception as e:
                result = {"error": str(e)}
            tool_calls.append({"name": name, "args": args, "result": result})
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": json.dumps(result, default=str)[:4000],
            })
        messages.append({"role": "user", "content": tool_results})

    return {
        "text": "[agent hit max turns without completing]",
        "tool_calls": tool_calls,
        "turns": max_turns,
        "provider": p,
    }


# ─── Streaming tool-use (for the chat UI) ────────────────────────────
#
# The chat endpoint wants to show the user live progress: "calling
# tool X… got result… continuing text…". That needs a streaming
# async generator that interleaves text chunks with tool lifecycle
# events. We yield structured envelopes:
#
#     {"kind": "text", "text": "..."}
#     {"kind": "tool_start", "id": "...", "name": "...", "args": {...}}
#     {"kind": "tool_result", "id": "...", "name": "...", "result": {...}}
#     {"kind": "tool_error", "id": "...", "name": "...", "error": "..."}
#     {"kind": "done"}
#
# The chat endpoint wraps each of these in its own NDJSON envelope
# so clients can distinguish them from plain chat chunks.
#
# Multi-provider strategy: we implement this for the openai SDK
# (which also drives OpenRouter, DeepSeek, Azure OpenAI, Fireworks,
# and many more via the ``base_url`` knob). For providers that don't
# support tool use (ollama models without function calling, or the
# null provider) we fall through to regular streaming and emit a
# single note so the client can decide whether to fall back.


async def stream_with_tools(
    system: str,
    user: str,
    tools: list[dict],
    tool_runner,
    *,
    temperature: float = 0.2,
    max_turns: int = 5,
):
    """Async generator that runs a tool-use loop while streaming.

    ``tools`` is in OpenAI function-calling format
    (``{"type": "function", "function": {...}}``).

    ``tool_runner(name, args)`` is a sync callable that returns a
    dict with keys ``data`` / ``render`` / ``summary`` (and optionally
    ``error``). The ``summary`` is what the LLM sees as the tool
    result content in its next turn — short enough to stay under
    context budgets. The ``render`` is for the frontend only.

    This implementation uses the openai SDK and works with any
    OpenAI-compatible endpoint (OpenAI, OpenRouter, DeepSeek, Azure
    OpenAI, etc.).
    """
    p = _provider()
    supported = p in ("openai", "openrouter")
    if not supported or not is_llm_configured():
        # Fall through to plain streaming, no tools, so at least the
        # user gets a text answer.
        yield {
            "kind": "tool_warning",
            "text": (
                "Tool-use is not available on the current LLM provider; "
                "answering in plain text."
            ),
        }
        async for chunk in stream(system, user, temperature=temperature):
            yield {"kind": "text", "text": chunk}
        yield {"kind": "done"}
        return

    try:
        from openai import AsyncOpenAI
    except ImportError:
        async for chunk in stream(system, user, temperature=temperature):
            yield {"kind": "text", "text": chunk}
        yield {"kind": "done"}
        return

    if p == "openai":
        client = AsyncOpenAI(api_key=_api_key("openai"))
        model = _model("openai")
    else:  # openrouter
        client = AsyncOpenAI(
            api_key=_api_key("openrouter"),
            base_url="https://openrouter.ai/api/v1",
            default_headers=_openrouter_default_headers() or None,
        )
        model = _model("openrouter")

    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    for turn in range(max_turns):
        resp_stream = await client.chat.completions.create(
            model=model,
            temperature=temperature,
            tools=tools,
            messages=messages,
            stream=True,
        )

        # Assemble the response as it streams in. Text chunks flow
        # straight through to the caller; tool-call chunks accumulate
        # because the OpenAI API sends them in pieces (name first,
        # then arguments in multiple deltas).
        response_text_parts: list[str] = []
        tool_calls_accum: dict[int, dict] = {}  # index -> {id, name, arguments}
        finish_reason: str | None = None

        async for chunk in resp_stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if delta is None:
                continue

            if getattr(delta, "content", None):
                response_text_parts.append(delta.content)
                yield {"kind": "text", "text": delta.content}

            # Tool call assembly
            tc_deltas = getattr(delta, "tool_calls", None) or []
            for tc in tc_deltas:
                idx = tc.index
                entry = tool_calls_accum.setdefault(
                    idx, {"id": None, "name": None, "arguments": ""}
                )
                if tc.id:
                    entry["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn:
                    if getattr(fn, "name", None):
                        entry["name"] = fn.name
                    if getattr(fn, "arguments", None):
                        entry["arguments"] += fn.arguments

            if choice.finish_reason:
                finish_reason = choice.finish_reason

        # End of this turn's stream. Decide what to do.
        if not tool_calls_accum:
            # No tools requested — we're done, the text has already been
            # yielded as it streamed.
            yield {"kind": "done"}
            return

        # Append the assistant turn (with the tool calls) to the
        # message history — required so the next turn's messages
        # reference valid tool_call_ids.
        assistant_msg: dict = {
            "role": "assistant",
            "content": "".join(response_text_parts) or None,
            "tool_calls": [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": tc["arguments"] or "{}",
                    },
                }
                for tc in tool_calls_accum.values()
            ],
        }
        messages.append(assistant_msg)

        # Execute each tool and emit start/result envelopes.
        for tc in tool_calls_accum.values():
            tc_id = tc["id"]
            tc_name = tc["name"] or ""
            tc_args_raw = tc["arguments"] or "{}"
            try:
                tc_args = json.loads(tc_args_raw) if tc_args_raw.strip() else {}
            except json.JSONDecodeError:
                tc_args = {}

            yield {
                "kind": "tool_start",
                "id": tc_id,
                "name": tc_name,
                "args": tc_args,
            }

            try:
                result = tool_runner(tc_name, tc_args)
            except Exception as e:
                result = {
                    "error": f"{type(e).__name__}: {str(e)[:180]}",
                    "summary": f"Tool '{tc_name}' failed.",
                    "render": None,
                    "data": None,
                }

            # Emit the full envelope (including render) to the
            # frontend, but send only the summary back to the LLM
            # — that keeps the model's context cheap and avoids
            # re-quoting the same data in the next turn.
            yield {
                "kind": "tool_result",
                "id": tc_id,
                "name": tc_name,
                "result": result,
            }

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result.get("summary")
                    or json.dumps(result.get("data"), default=str)[:1500],
                }
            )

    # Fell off the end of the turn loop.
    yield {
        "kind": "tool_warning",
        "text": f"Tool loop hit the {max_turns}-turn limit.",
    }
    yield {"kind": "done"}
