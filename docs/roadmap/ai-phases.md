# FlowMiner AI roadmap — phases 2-6

Phase 1 ships with this commit. The remaining phases are queued below in
priority order. Each entry lists:

- what we deliver
- why it matters vs Celonis's equivalent
- approximate engineering effort
- a concrete next-step checklist you can pull into a sprint

Research notes on Celonis's AI surface (Process Copilot, PI Graph,
AgentC, Action Flows, MCP Server) are summarised inline where each
phase intersects with their product.

---

## Phase 2 — Tool-use chat: NL → filter chips → visualisation

**Deliverable.** The Ask-AI panel becomes a genuine analytical assistant:
the user types a question, the LLM decides which mining endpoint(s) to
call, fetches the real numbers, and returns a text answer *plus* a
rendered chart and (optionally) a set of applied filter chips.

**Why it matters.** This is Celonis Process Copilot's flagship: it
translates natural language into their Process Query Language (PQL),
runs the query, and returns charts, tables, CSV exports, and a draft
email. We don't have PQL and shouldn't build one — filter chips +
existing mining endpoints already carry the same semantic content, and
the LLM can pick tools instead of writing SQL. Shipping this closes the
single biggest gap between FlowMiner and Celonis on the conversational
loop.

**Estimated effort.** 2-3 weeks. Biggest risks are latency with
streaming + multi-turn tool calls and making sure the LLM chooses tools
correctly across providers (Claude, OpenAI, DeepSeek, Ollama all have
slightly different tool-use schemas).

**Next-step checklist.**

1. Define a tool catalogue (8-10 tools) in a new `backend/app/services/chat_tools.py`:
   `filter_by_activity`, `filter_by_duration`, `filter_by_case_count`,
   `show_bottlenecks`, `show_variants`, `show_rework_rates`,
   `compare_cases`, `drill_into_case`, `show_time_series`, `render_chart`.
   Each tool is a thin wrapper over an existing mining endpoint + a
   schema describing its args. Keep tool names human-readable.
2. Wire the catalogue into `backend/app/api/ai.py` — use the existing
   `/ai/agent/run` endpoint as the starting point (it already supports
   Anthropic tool-use). Add OpenAI/DeepSeek tool-use paths mirroring
   the Anthropic one in `app/services/llm.py`.
3. Define the chart payload format: fenced `chart` code block or a
   custom `{"type":"tool_result","name":"render_chart","args":{...}}`
   line in the NDJSON stream. Keep the data in the payload small —
   pre-aggregated on the backend, not raw events.
4. Frontend: extend `FloatingAIChat` to detect tool-result lines in
   the NDJSON stream and render them inline with recharts. Reuse the
   existing `ProcessChart` component from Dashboards for consistency.
5. Filter-chip side effect: when a tool call applies filters, also
   push them into `useFilterStore` so the rest of the page updates.
   Add an "Applied filters" pill next to the assistant message that
   says "Apply to page" / "Revert".
6. Prompt the LLM with the tool catalogue + the log's current
   context summary (we already compute this in `_build_log_context`).
   Reuse the v6 prompt style: plain English, evidence discipline.
7. Cap the tool loop at 5 turns. Surface tool errors to the user
   instead of silently retrying.
8. Tuning script extension: add a `--tools` mode to
   `backend/scripts/tune_ocpm_narrative.py` so prompt iteration works
   for the tool-use system prompt too.

**Provider note.** DeepSeek's tool use is not fully reliable on
multi-turn; prefer Claude Haiku or gpt-4o-mini as the default tool-use
provider, but keep the provider pluggable so ollama can drive this
locally.

---

## Phase 3 — MCP server: first open-source process-mining MCP

**Deliverable.** A standalone `flowminer-mcp` Python package that
speaks Anthropic's Model Context Protocol and exposes every mining
endpoint as an MCP tool. Ships as both a Python wheel and a Docker
image. Works with Claude Desktop, Cursor, Zed, and any MCP-aware
agent out of the box.

**Why it matters.** Celonis announced their MCP server at Celosphere
2025 and marketed it as "the industry's first MCP server for process
intelligence." That claim is valuable *and* locally defeasible — MCP
is a small, well-specified protocol and we can ship a fully working
implementation in a week. Being first in open source gives us a real
moat with developer-tool buyers and with the Ollama / local-LLM crowd
that Celonis structurally cannot serve.

**Estimated effort.** 1 week for a functional v1, 1 more week for
polish + docs + example walkthroughs.

**Next-step checklist.**

1. New module: `backend/app/mcp/server.py`. Use the official `mcp`
   Python SDK (Anthropic). Runs in stdio mode by default so Claude
   Desktop can launch it directly.
2. Tool surface:
   - `get_log_summary(log_id)` — totals, activity list, date range.
   - `get_variants(log_id, top_n)` — most common paths.
   - `get_bottlenecks(log_id, top_n)` — activities by duration.
   - `get_conformance(log_id)` — fitness + precision against inductive.
   - `get_dfg(log_id)` — directly-follows graph as JSON.
   - `get_rework(log_id)` — rework rates per activity.
   - `generate_insights(log_id)` — the full v6-grade insight set.
   - `ask(log_id, question)` — delegates to `/ai/chat` for the fully
     narrated answer. This is the "escape hatch" for complex queries.
3. Auth: accept an API token via env var. Each tool call re-uses
   existing access checks from `_assert_event_log_access`. Do not
   bypass authorization just because the client is an MCP agent.
4. Publish a minimal Python wheel: `pip install flowminer-mcp`.
   Ship a `Dockerfile.mcp` too so the standard way to run it is
   `docker run flowminer-mcp --backend http://host:8000 --token $X`.
5. Docs: `docs/mcp-claude-desktop.md` with a literal
   `claude_desktop_config.json` snippet people can copy-paste.
   Include a worked example: "Claude, summarise the bottlenecks in
   the HR onboarding log."
6. Blog post positioning: "The first open-source process-mining MCP
   server — ask Claude Desktop about your process in one click."

**Anti-goal.** Don't re-implement mining logic in the MCP server. It
is a thin proxy to the existing FastAPI endpoints — nothing more.

---

## Phase 4 — Lightweight knowledge layer

**Deliverable.** Per-log "Process Notes" — a free-text field where
users paste domain knowledge (activity glossary, business rules,
"Depart means outbound gate", "Place in Stock is inventory dwell",
etc.). Every LLM prompt gets those notes as a grounding block. The
field is auto-seeded from heuristics we already run (resource
detection, dwell-activity detection, object type counts).

**Why it matters.** Celonis's entire grounding story depends on a
hand-curated Knowledge Model — schemas, KPI definitions, rules,
opportunity logic. Building a good Knowledge Model is consulting
work; it's why Celonis implementations cost what they do. We can
capture 80% of the grounding value with 5% of the UI surface by
letting users paste plain English notes and feeding them to the LLM.
The auto-seed is the killer feature: the user opens the notes and
sees *their* resource types and dwell patterns already annotated,
which they can correct inline.

**Estimated effort.** 1-2 weeks. The persistence piece is trivial
(one text column on `event_logs`). The interesting work is the
auto-seed and the prompt wiring.

**Next-step checklist.**

1. DB migration: add `process_notes TEXT NULL` to `event_logs`.
2. Settings UI in the event-log header area: a small "Notes" button
   that opens an inline textarea. Save on blur. Show the count of
   auto-generated lines vs user-edited lines.
3. Auto-seed generator (`backend/app/services/process_notes.py`):
   pulls from the cached improvement report, resource markers,
   dwell findings, and the largest/smallest object types. Produces
   a markdown block with one line per auto-detected fact:
   ```
   ## Auto-detected (edit or delete)
   - "Forklift" is a reusable resource (3 units, 7738 events).
   - "Place in Stock" looks like inventory dwell, not process waste.
   - "Truck" is a reusable resource (6 units, 12,542 events).
   ```
4. Prompt wiring: in `_build_log_context` (for chat) and
   `_summarise_findings_for_prompt` (for narration) add a
   `process_notes` section at the top of the user prompt. The v6
   narrator prompt should reference it: "If process_notes contradicts
   a finding in the report, trust the notes."
5. Tuning script: add a `--notes` flag to load a notes file and
   inject it into the test payload, so prompt iteration on the
   narrator handles the notes case.
6. Re-cache: when notes change, invalidate the cached
   `improvement_narrative` and `chat_suggestions` for that log.

---

## Phase 5 — Proactive push: digests and alerts

**Deliverable.** A weekly digest per project: the AI diffs the current
improvement report against last week's snapshot, writes a
narrative-style "what changed" email / Slack post, and pushes it to
subscribed users. "Container rework dropped from 95% to 88% this
week. The new top issue is X." No trigger configuration required.

**Why it matters.** Celonis's proactive alerting relies on
customer-defined KPI triggers wired through their Event Subscription
API. That works, but it requires someone to decide in advance what is
worth alerting on. Our angle is different and specifically enabled by
LLMs: the AI scans the delta and decides what's noteworthy. No
trigger config, no upfront investment, just "here's what changed."

**Estimated effort.** 2 weeks.

**Next-step checklist.**

1. Celery beat job `weekly_digest`: for every event log that has been
   touched in the last 7 days, compute and cache a fresh
   `improvement_report`, compare against the previous cached version
   (stored as `improvement_report_prev` under a new cache key), and
   build a diff structure: new findings, resolved findings, changed
   metrics.
2. New endpoint `POST /ai/narrate-diff/{event_log_id}` that takes the
   diff and writes a markdown digest using a v6-style prompt adapted
   for diffs. Cache it as `digest_{week}`.
3. Email template + Slack webhook delivery. Reuse the existing
   `app.services.notifier` module — we already have SMTP wiring.
4. Per-user subscription: add `digest_subscriptions` table with
   `user_id`, `event_log_id`, `channel` (email/slack), `active`.
   Simple CRUD in Settings.
5. "Subscribe to this log" button next to the Ask-AI trigger on
   each log page. One-click enable.
6. Digest preview view: `/digests` page showing past digests so the
   user can see what was pushed.

**Celonis delta.** They have the mechanisms but the decision of
what's worth pushing is customer-curated. We make it AI-curated. The
UX win is "zero setup; just subscribe".

---

## Phase 6 — Agentic write-back (long term)

**Deliverable.** The AI proposes fixes to the event log or the
analysis view, the user approves with one click, and the system
executes. Start with intra-FlowMiner actions (rename an activity,
merge two activities, apply a filter to the default view, add a
process note, tag a case for investigation). Expand to external
actions only if a customer explicitly asks.

**Why it matters.** Celonis's Action Flows + Orchestration Engine
story is where they claim "autonomous enterprise" — but customer
reviews point out that end-to-end write-back is still rough and
requires heavy SI work. We can leapfrog by focusing on write-back
*within* the FlowMiner product first, where we own the whole stack
and can make the action loop feel instant. External connectors can
come later via MCP or webhooks once there's demand.

**Estimated effort.** 4+ weeks. This is the largest phase and also
the riskiest because every action needs an audit trail, a rollback
path, and approval flow.

**Next-step checklist (sketch only — flesh out when prioritised).**

1. Action catalogue: a YAML file listing every action the AI can
   propose. Each entry has a short description, a JSON schema for
   its args, an idempotency key, a rollback function, and a
   permission requirement.
2. Agent loop extension: the tool-use system from Phase 2 gets a new
   class of tools: `propose_action(...)`. These don't execute —
   they enqueue a pending action for the user to review.
3. "Pending AI actions" drawer in the Header next to Ask AI. Shows
   pending proposals with a diff preview and Approve/Reject buttons.
4. Audit log entries for every approval/rejection, with the LLM's
   rationale captured.
5. First actions to ship (low risk, high leverage):
   - Apply a filter chip set as the log's default view.
   - Rename an activity (with a per-case event-level rewrite).
   - Merge two activities that are clearly the same thing.
   - Pin a dashboard widget with a specific chart.
   - Create a process note entry (Phase 4 dependency).
6. Later: external connector actions via MCP tools or webhooks. Keep
   this behind a feature flag and only enable for customers who ask.

**Risk.** Agentic write-back is where every process-mining vendor's
demo is most impressive and where real deployments are most fragile.
Ship the intra-app version first, collect real usage data, and only
then widen the blast radius.

---

## Cross-phase backlog

Small items that don't fit cleanly into one phase but are worth
queuing:

- **Chart rendering in narrative output.** Phase 2 covers chart-in-chat
  via tool use; also emit charts in OCPM improvement reports and
  scheduled PDFs.
- **Process-specific personas.** One-shot switch in the settings:
  "healthcare", "finance", "logistics", "manufacturing". Just loads a
  domain-specific system prompt prefix into the narrator.
- **Multi-log comparison in chat.** "Compare this log to the onboarding
  log from Q1." Needs cross-log context assembly.
- **Undo for chat-applied filters.** When tool-use applies a filter to
  the page, show a sticky "Undo" toast for 5 seconds.
- **Chat history per log.** Right now the thread is ephemeral. Persist
  it per (user, log) so reopening the panel resumes the conversation.
- **Voice input.** Long tail but trivial: add a mic button next to the
  Send button using the browser Web Speech API.

---

## Explicit anti-roadmap — things we're *not* building

- **A PQL clone.** Celonis built PQL in 2014 because they had to.
  We have filter chips + existing mining endpoints; translating NL
  to those via tool use is cheaper and equivalently expressive.
- **A full Action Flows product with 150+ connectors.** That's a
  multi-year SI investment that trades off against every other
  feature. Skip until a specific customer asks.
- **A cross-company "Celonis Networks" knowledge graph.** No public
  evidence it actually works and not our market.
- **A Knowledge Model editor with its own UI, versioning, and
  publishing workflow.** Phase 4's plain-text notes capture 80% of
  the value at 5% of the cost.
- **A closed-source AI agent marketplace.** Our differentiator is
  being open and MCP-first. Any agent built on top of our MCP
  server is already "in the marketplace" by default.
