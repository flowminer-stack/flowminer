#!/usr/bin/env python3
"""Fine-tune the OCPM improvement-report narration prompt.

This script drives the same code path the production endpoint uses
(``_summarise_findings_for_prompt`` + ``llm.complete``) but lets you
swap the system prompt in from a file. The point is to iterate on the
prompt against a real OCEL analysis result without having to hit the
web UI, clear caches, and reload.

Typical workflow
================

1. Populate the improvement-report cache by visiting the OCPM page
   for your target log once (or by calling
   ``GET /api/v1/ocel/<ocel_id>/improvement-report`` with curl).
2. Run this script with a prompt file:

       docker exec processmining-backend-1 python3 \
         scripts/tune_ocpm_narrative.py \
         --ocel-id <uuid> \
         --prompt scripts/prompts/v6_cot_full.md

3. Edit ``scripts/prompts/v6_cot_full.md`` (or copy it to ``v7.md`` and
   edit) and re-run. Use ``--prompts a.md b.md c.md`` to compare
   variants side-by-side in a single run.

Notes
=====
* The script shares ``_summarise_findings_for_prompt`` and the
  ``ImprovementReportResponse`` schema with ``app.api.ocel``, so
  whatever you see here matches what the UI would render verbatim.
* The LLM itself is called via ``app.services.llm.complete`` which
  honours ``FLOWMINER_LLM_PROVIDER``, ``OPENROUTER_MODEL``, etc. —
  set them in ``.env`` and force-recreate the backend before running.
* If no improvement-report cache entry exists we bail out with a
  helpful message; we never recompute the structured report here
  because that needs the parsed OCEL object.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Make sure /app/scripts is importable regardless of cwd inside the
# container — the backend image mounts the project at /app.
SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.api.ocel import (  # noqa: E402
    ImprovementReportResponse,
    _NARRATE_SYSTEM_PROMPT,
    _summarise_findings_for_prompt,
)
from app.services import llm  # noqa: E402
from app.services.result_cache import cache_get  # noqa: E402


def load_report(ocel_id: str) -> ImprovementReportResponse:
    """Pull the structured improvement report out of Redis.

    We rely on the production cache rather than recomputing because
    recomputing needs the parsed OCEL object, which only exists in the
    backend process. Visiting the OCPM page once populates this cache.
    """
    cached = cache_get(ocel_id, "improvement_report", "none")
    if cached is None:
        sys.stderr.write(
            f"ERROR: no cached improvement_report for ocel_id={ocel_id}.\n"
            "       Visit the OCPM page for that log once (or curl the\n"
            "       /api/v1/ocel/<id>/improvement-report endpoint) to\n"
            "       populate the cache, then re-run this script.\n"
        )
        sys.exit(2)
    return ImprovementReportResponse(**cached)


def build_user_prompt(report: ImprovementReportResponse) -> str:
    """Exactly mirror the production ``narrate`` endpoint so whatever
    the LLM sees here is what it would see in real traffic."""
    prompt_json = _summarise_findings_for_prompt(report)
    return (
        "Structured improvement report (JSON):\n\n"
        f"{prompt_json}\n\n"
        "Write the executive summary now."
    )


def load_prompt(prompt_path: str | None, label: str | None = None) -> tuple[str, str]:
    """Return (display_label, system_prompt). ``None`` → current default."""
    if prompt_path is None:
        return ("default (baked-in)", _NARRATE_SYSTEM_PROMPT)
    text = Path(prompt_path).read_text().strip()
    return (label or Path(prompt_path).stem, text)


_BRIEF_MARKER = "===BRIEF==="


def _strip_scratch(text: str) -> tuple[str, str | None]:
    """If the prompt asked for chain-of-thought separated by the
    ===BRIEF=== marker, peel off the scratch and return only the brief.

    Returns (brief, scratch_or_none). When the marker isn't present the
    full text is treated as the brief (so non-CoT prompts still work).
    """
    if _BRIEF_MARKER in text:
        scratch, _, brief = text.partition(_BRIEF_MARKER)
        return brief.strip(), scratch.strip() or None
    return text.strip(), None


def run_once(system: str, user: str, *, temperature: float) -> tuple[str, float, str | None]:
    t0 = time.perf_counter()
    raw = llm.complete(system, user, temperature=temperature)
    brief, scratch = _strip_scratch(raw)
    return brief, time.perf_counter() - t0, scratch


def print_header(ocel_id: str, user_prompt: str) -> None:
    import os

    provider = llm._provider()
    configured = llm.is_llm_configured()
    model_env = {
        "anthropic": "ANTHROPIC_MODEL",
        "openai": "OPENAI_MODEL",
        "openrouter": "OPENROUTER_MODEL",
        "ollama": "OLLAMA_MODEL",
    }.get(provider)
    model = os.getenv(model_env, "") if model_env else ""
    print(f"Provider        : {provider}  (configured={configured})")
    if model:
        print(f"Model           : {model}")
    print(f"OCEL id         : {ocel_id}")
    print(f"User-prompt size: {len(user_prompt):,} chars")
    print()


def dump_user_payload(user_prompt: str, out_path: str) -> None:
    Path(out_path).write_text(user_prompt)
    print(
        f"Wrote the user-prompt (system-prompt excluded) to {out_path} "
        f"({len(user_prompt):,} chars)"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Iterate on the OCPM narration system prompt.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--ocel-id",
        required=True,
        help="UUID of the OCEL / event-log to narrate.",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--prompt",
        help="Path to a single system-prompt file. Falls back to the "
        "current production default when omitted.",
    )
    group.add_argument(
        "--prompts",
        nargs="+",
        metavar="PATH",
        help="Multiple system-prompt files — runs each in sequence for "
        "side-by-side comparison.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Sampling temperature passed to llm.complete (default 0.2).",
    )
    parser.add_argument(
        "--dump-user-payload",
        metavar="PATH",
        help="Write the compact JSON user-prompt to PATH and exit. "
        "Handy for one-off inspection without calling the LLM.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    report = load_report(args.ocel_id)
    user_prompt = build_user_prompt(report)

    if args.dump_user_payload:
        dump_user_payload(user_prompt, args.dump_user_payload)
        return 0

    print_header(args.ocel_id, user_prompt)

    if args.prompts:
        prompts = [load_prompt(p) for p in args.prompts]
    else:
        prompts = [load_prompt(args.prompt)]

    for label, sys_prompt in prompts:
        print(f"━━━ {label} ({len(sys_prompt):,} chars) ━━━")
        try:
            brief, took, scratch = run_once(
                sys_prompt, user_prompt, temperature=args.temperature
            )
        except Exception as e:
            print(f"  LLM call failed: {type(e).__name__}: {e}")
            continue
        words = len(brief.split())
        scratch_note = f" · scratch {len(scratch.split())}w" if scratch else ""
        print(f"  {took:.1f}s · brief {words}w · {len(brief):,} chars{scratch_note}\n")
        if scratch:
            print("  ── scratch (stripped from production output) ──")
            for line in scratch.splitlines():
                print(f"  │ {line}")
            print("  ── brief ──")
        print(brief)
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
