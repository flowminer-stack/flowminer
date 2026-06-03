# FlowMiner Competitive UX & Feature Audit

**Date:** 2026-06-02  
**Method:** 8 competitor deep-dives (Celonis, Apromore, Power Automate / Signavio, UiPath / IBM / ARIS, Disco / QPR / Workfellow, pm4py / ProM / bupaR, general buyer pain-points, cross-vendor pricing), 3 codebase capability maps (backend surface, frontend UX, new-user onboarding), 31 candidate findings each verified against live source files.  
**Scope:** All 31 candidates verified; 0 false positives discarded. 5 confirmed absent, 8 partial/weak, 18 confirmed UX issues.

---

## 1. Executive Summary

FlowMiner's backend is analytically class-leading for an open-source tool. The core process-mining stack — five discovery algorithms, five conformance methods, M/M/c queue mining, concept-drift detection, three predictive models, full OCEL/OCPM layer, LiNGAM causal discovery, DES simulation, and 17 connectors — is fully implemented with Rust acceleration on hot paths. The product has more analytical depth than Disco, more breadth than Apromore CE (before its August 2025 repo archival), and a more complete self-serve experience than pm4py.

The problem is not the product. The problem is that none of this is communicated, and several high-value completed features are unreachable in the UI.

**Three simultaneous crises:**

1. **Positioning vacuum.** The README opens with a generic one-liner and 38 feature bullets. It names zero competitors, states no thesis, and never tells a potential switcher why they should choose FlowMiner over the tool they already hate. Celonis costs $150K–$1.26M Year-1. Apromore CE is archived. pm4py is AGPL. The market is wide open and FlowMiner is invisible to everyone who is actively looking.

2. **Time-to-value UX failures.** Four high-severity issues block the moment a new user first creates value: the superior ColumnMapper component is dead code; the post-upload CTA drops users on a blank canvas; the product tour silently highlights nothing (5 of 6 DOM selectors do not exist); and Governance / Capability Map pages are entirely undiscoverable with no navigation link anywhere in the app.

3. **Three security findings that must ship before any public release.** The streaming ingest endpoint (`/ingest/{event_log_id}`) and WebSocket endpoint (`/ws/{event_log_id}`) have zero authentication. The dashboard collaboration WebSocket passes identity as a raw URL query string with no JWT verification. The anonymizer is reversible SHA-256 pseudonymisation with static salts — but the product calls it "anonymisation" with no disclosure that it is not GDPR-compliant anonymous data.

**Market context summary:**

| Competitor | Core complaint | Opening for FlowMiner |
|---|---|---|
| Celonis | $150K–$1.26M TCO, 3-yr non-cancelable contracts, $400–700K/yr CoE, opaque PQL | MIT license, no contract, self-serve AI replaces the CoE |
| Apromore CE | All OSS repos archived Aug–Sep 2025; conformance/simulation behind paywall | Full stack MIT, no feature wall, still maintained |
| pm4py | AGPL blocks embedding; no GUI; requires Python expertise | Web app, MIT, self-serve, same algorithmic depth |
| Disco | Discovery only; no conformance, simulation, collaboration; desktop-only | Full stack; server-hosted; MIT; runs on 4 GB VPS |
| UiPath / IBM | Expensive; consultant-dependent; 4–6 month time-to-value | Self-serve onboarding; AI copilot replaces SI engagement |
| SAP Signavio | Cloud-only; no on-prem path; data-access surcharges | Self-hosted by default; data sovereignty guaranteed |

---

## 2. Confirmed-Absent Features (5)

These capabilities have zero implementation in the codebase. Every claim has been verified against source files.

| # | Feature | Severity | Effort | Why It Matters | Recommended Fix |
|---|---|---|---|---|---|
| F1 | **Multi-table join / ETL for fragmented source tables** (SAP EKKO + EKPO + EKBE style) | Critical | L | 40–80% of every process mining project is event-log preparation from relational ERP tables. This is the single most-cited buyer pain across Celonis, UiPath, SAP, and IBM reviews. FlowMiner's `log_builder.py` accepts exactly one `staging_path` argument; `BuildRequest` has a single `staging_path: str` field. No join specification, no second source. | Add a multi-source join stage to Log Builder: register 2–3 uploaded tables, define join keys, pick which columns become case\_id/activity/timestamp. Pair with the Extraction Copilot (already generates SQL). This alone closes the dominant ETL pain. |
| F2 | **Real-time / live process monitoring UI** (streaming WS frontend + auth) | High | L | Competitors are praised for live dashboards. FlowMiner has the WebSocket and ingest scaffolding in `streaming.py` but `LiveMetrics` is a `defaultdict(list)` purely in-process with no persistence, no conformance/drift logic, and no frontend page consuming it. See also Security §5. | After closing the auth hole (§5, S1): ship a live monitoring page running incremental bottleneck/conformance over a sliding window and firing existing alert rules. Back with Redis pub/sub for multi-worker correctness. |
| F3 | **Threaded / assignable annotations** (parent\_id, assignee\_id, resolved) | Medium | M | Collaborative review is a key Celonis differentiator. Annotation model `annotation.py` has only: id, project\_id, event\_log\_id, activity\_name, edge\_source, edge\_target, content, created\_by, created\_at — no threading fields. `CommentThread.tsx` uses "@mentions" language over a structurally flat backend. | Add `parent_id`, `assignee_id`, `resolved` columns with Alembic migration; wire real `@mention` to the notification transport (once S1 auth is closed). |
| F4 | **Community / governance / commercial-support signal** (GitHub Discussions, support-tier statement) | Medium | S | "No vendor to call" is the top reason enterprise switchers stay on hated paid tools. README has no community channel, no badges, no support statement, and a dead link to `CODE_OF_CONDUCT.md`. | Add a README support section (community: GitHub Discussions + a chat channel; commercial: optional SLA available). Fix or create `CODE_OF_CONDUCT.md`. State the governance/maintainership posture. |
| F5 | **SMB / mid-market / consultant wedge messaging** | Medium | M | ProcessMind launched at $99–199/mo specifically to fill the gap the market is "begging for." FlowMiner is the natural answer (free, MIT, 4 GB VPS, self-serve AI, DEMO\_MODE=1 for zero-friction public instances) but makes no segment claim anywhere. | Pick three wedge audiences explicitly in README and docs: (1) SMB priced out of Celonis, (2) consultants doing zero-license client scoping, (3) regulated orgs needing on-prem. Stand up a hosted public DEMO\_MODE instance as a friction-free trial that beats Disco's 100-event cap. |

---

## 3. Partial / Weak Features (8)

These capabilities exist but have gaps severe enough to limit their value or expose bugs.

| # | Feature | Severity | Effort | Current Gap | Files | Recommended Fix |
|---|---|---|---|---|---|---|
| P1 | **Action rules write-back** | High | M | `dispatch_action()` in `action_engine.py` (lines 99–152) returns intent dicts for all 5 action types (notify\_email, notify\_webhook, create\_task, tag\_case, escalate) with zero side effects. Docstring confirms: "intentionally lightweight." | `backend/app/services/action_engine.py` | Implement real transport: httpx POST for webhook (highest leverage, bridges to n8n/Zapier), SMTP for email via existing settings, Slack incoming webhook. Remove the `success=True` lie from the execution log. |
| P2 | **ERP connectors wired to UI** | High | M | 9 connector types in `ConnectorForm.tsx` and `_get_connector_service()`. SAP, Salesforce, Snowflake, BigQuery, ServiceNow, Workday, Coupa, Ariba, Oracle Fusion are implemented as service classes but unreachable. Celery `tasks.py` has a second dispatcher that handles 5 of them for scheduled syncs — so they are not totally dead — but no user can create one via the HTTP API. | `backend/app/api/connectors.py` lines 41–65; `frontend/src/components/Connectors/ConnectorForm.tsx` lines 40–111 | Wire Salesforce + Snowflake + BigQuery first (already implemented, plumbing + UI card each). Then SAP as a strategic priority. Mark unimplemented ones as "coming soon" rather than silently 400-ing. |
| P3 | **Custom KPI expression evaluator** | Medium | M | SQL sandbox in `analytics.py` (line 312) registers one flat DataFrame with no process-aware UDFs. Custom KPI `expression` field exists in the schema but is never evaluated — `expression` is stored but `dispatch` returns a static value. The competitive filter-expression DSL in `competitive.py` has real process-native predicates (case.duration, activity contains) but is isolated from the KPI surface. | `backend/app/api/analytics.py` line 312; `backend/app/services/competitive.py` | Wire the existing `safe_expression` AST evaluator (already used by ETL `derive_column`) to the Custom KPI expression field. Add variant\_id, case\_duration, rework\_count helper columns to the SQL sandbox. |
| P4 | **Task mining capture agent** | Medium | L | Backend is complete: 6 routes, batch ingest (5000 events/call), n-gram pattern miner, cross-link to process activities. Frontend page and API client wrappers exist. Missing: any desktop capture agent / recorder in the repo. Feature is unusable end-to-end. | `backend/app/api/task_mining.py`; `frontend/src/pages/TaskMiningPage.tsx` | Ship a minimal Python tray-app client (active window title + app + timestamp + URL, batched to existing `/events` endpoint). Or explicitly deprecate to "bring your own recorder" with documented SDK wrappers. |
| P5 | **OPerA object-centric metrics** (synchronization, pooling, lagging time) | Medium | L | `ocpa` not in `requirements.txt`. Zero matches for "opera", "synchronization\_time", "pooling\_time", "lagging\_time" across `backend/app/`. OC-DFG, OC-Petri-Net structural analysis, and 5 object-graph types are present and working. The OC Petri Net endpoint returns only structural stats (activity/place/arc counts) — no visual net topology. Roadmap at `docs/roadmap/ocel-tools.md` explicitly lists these as unbuilt. | `backend/app/api/ocel.py` `get_oc_petri_net` (line ~1150–1218); `docs/roadmap/ocel-tools.md` | Implement OPerA synchronization/pooling/lagging-time metrics (this is the payoff layer that converts "OCEL plumbing" into a defensible Celonis-class differentiator). Add OC-Petri-Net visual rendering. Be explicit in docs that OPerA is on the roadmap, not shipped. |
| P6 | **Mobile / responsive exec-facing surfaces** | Low | M | PWA: no `manifest.json`, no service worker, no `vite-plugin-pwa`. The app has a functioning mobile sidebar drawer and responsive header, but: the Deep Analyses mega-menu inner `grid-cols-3` has no responsive breakpoints; the AnalysisHub sidebar becomes a horizontal scrolling row on mobile with no scroll hint. MissionControl and Dashboards (the two exec-facing pages) are not genuinely phone-friendly. | `frontend/src/pages/ProcessViewPage.tsx` lines 172–176; `frontend/src/components/AnalysisHub/AnalysisHub.tsx` line 202; `frontend/index.html` | Add PWA manifest (minimal, ≤ 30 min effort). Make MissionControl and shared Dashboard views phone-friendly. Fix the mega-menu responsive grid. |
| P7 | **OCEL positioning** | Medium | S | Comprehensive OCEL backend (14 endpoints, full frontend UI, OC-DFG, 5 object-graph types, state-aware OCPM per EDOC 2025) sits as one README bullet with no competitive framing. Power Automate, Signavio, Disco, UiPath, IBM all explicitly weak on OCEL. Celonis is cited as the one tool with genuine OCPM — and FlowMiner matches it on the layer below OPerA. | `README.md` line ~110 | Elevate OCEL to a README headline pillar. Be honest about the boundary: "Object-centric discovery and analysis (OPerA metrics on the roadmap)." This claims a lane no other open-source tool credibly occupies. |
| P8 | **On-prem / data-sovereignty positioning** | Medium | S | Capability is real: self-hosted docker-compose (no cloud dependency), SAML+OIDC+TOTP (`api/saml.py`, `api/sso.py`), audit logs (`api/audit_logs.py`), privacy config (`api/privacy.py`). Zero sovereign/air-gap/data-residency framing anywhere in user-facing copy. Critical caveat: `anonymizer._hash_value` uses SHA-256 with static salts — this is reversible pseudonymisation, not GDPR-anonymous data (§5, S3). | `backend/app/services/anonymizer.py` lines 11–17; `README.md` | Add "On-prem and sovereign by default" positioning section. Position as "data never leaves your network + pseudonymisation + RBAC + audit log." Do not claim GDPR anonymisation — claim data sovereignty and pseudonymisation, which is accurate and still compelling. |

---

## 4. Confirmed UX Issues (18)

All 18 confirmed by code inspection. Grouped by severity.

### 4.1 Critical (1)

#### UX-C1 — README is a feature catalog, not a positioning weapon
**Severity:** Critical | **Effort:** S  
**Competitor evidence:** Celonis costs $150K–$1.26M Year-1 and buyers are actively seeking alternatives. Apromore CE repos archived Aug–Sep 2025. pm4py AGPL blocks embedding. Disco is discovery-only desktop. The market is searching for exactly what FlowMiner is — but the README never names a competitor or states a thesis.  
**Current status:** `README.md` (201 lines, 38 bullet points) opens with "Open-source process mining platform. Upload an event log, get an interactive process map..." Zero occurrences of: celonis, disco, apromore, signavio, alternative, competitor, migration, self-host as a differentiator.  
**Evidence:** `README.md` lines 1–10; zero hits for any competitor name in user-facing copy outside roadmap docs.  
**Fix:** Rewrite the top third of `README.md` around a positioning thesis: "The depth of Celonis, the self-host freedom of pm4py, without the AGPL trap, the open-core paywall, or the six-figure contract." Add a one-screen comparison table (FlowMiner vs Celonis vs Apromore CE vs Disco vs pm4py) with rows for License, Self-host, Conformance, Simulation, OCEL, AI/Copilot, Connectors, Price. Lead with the switcher's pain.

---

### 4.2 High (9)

#### UX-H1 — Navigation IA buries Governance, Capability Map, Mission Control
**Severity:** High | **Effort:** M  
**Competitor evidence:** Celonis's "feature buried under menus" is a top G2/TrustRadius complaint. FlowMiner is repeating the anti-pattern on its highest-value enterprise pages.  
**Current status:** `Sidebar.tsx` lines 33–59: exactly 10 nav items. `App.tsx` lines 176–232: 37 authenticated routes. Three tiers of discoverability problem: (1) `/governance` (line 223) and `/capability-map` (line 224) have zero navigation links anywhere in the UI — confirmed by exhaustive grep across all `.tsx/.ts` files; (2) `/mission-control/:eventLogId` is only reachable from `UploadPage` done-step, not from the sidebar; (3) per-log deep-analysis routes live behind a mega-menu that requires first drilling into a project and then an event log.  
**Evidence:** `frontend/src/components/Layout/Sidebar.tsx` (navSections) vs `frontend/src/App.tsx` (routes).  
**Fix:** Promote Mission Control, Governance, and Capability Map to first-class sidebar entries. The per-log analyses (variants, bottlenecks, drift, etc.) can stay in the mega-menu since they require an eventLogId — that is acceptable progressive disclosure.

#### UX-H2 — Post-upload blank canvas with no "what to look at first" nudge
**Severity:** High | **Effort:** S  
**Competitor evidence:** Disco is praised specifically for "start getting value virtually immediately after downloading." Celonis requires a 4–6 month CoE ramp. The time-to-first-insight moment is the decisive differentiator for self-serve tools.  
**Current status:** `UploadPage.tsx` lines 553–593: done-step has exactly two CTAs — `navigate(/projects/${projectId})` and `navigate(/process/${eventLogId})` or `/ocpm/${eventLogId}`. Zero reference to `/mission-control/:id` anywhere in the file. `MissionControlPage.tsx` exists, is routed, and is the strongest composed first-value view in the app.  
**Evidence:** `frontend/src/pages/UploadPage.tsx` lines 553–593; `frontend/src/pages/MissionControlPage.tsx`.  
**Fix:** Add a third CTA on the done-step: "See Insights" → `/mission-control/${eventLogId}`, make it the visually primary button. Add `data-tour="process-map-toolbar"` and `data-tour="filter-chip-bar"` to the process view so the tour actually works (see UX-H3).

#### UX-H3 — Product tour has 5 of 6 DOM selectors dangling — tour silently teaches nothing
**Severity:** High | **Effort:** S  
**Current status:** Full grep of the entire frontend for `data-tour` found exactly 2 placements: `ProcessViewPage.tsx:510` (`data-tour="ask-ai"`) and `OCPMPage.tsx:1932` (`data-tour="ask-ai"`). All 5 other selectors in `tours.config.ts` — `process-map-toolbar` (line 53), `filter-chip-bar` (line 58), `variant-focus` (line 74), `variant-evolution` (line 79), `ocpm-improvements` (line 90) — have zero placements. When these steps run, the spotlight disappears (null rect) and the tour card floats unanchored.  
**Evidence:** `frontend/src/components/Onboarding/tours.config.ts` lines 53–90; `frontend/src/components/Onboarding/ProductTour.tsx` line 48.  
**Fix:** Add the 5 missing `data-tour` attributes to the corresponding elements (toolbar wrapper at `ProcessViewPage.tsx:739`, FilterChipBar wrapper at line 759, relevant elements in `VariantsPage.tsx` and `OCPMPage.tsx`). Add a CI lint that fails when a tour selector has no matching DOM attribute.

#### UX-H4 — ColumnMapper.tsx is dead code — onboarding uses an inferior inline form
**Severity:** High | **Effort:** M  
**Current status:** `ColumnMapper.tsx` (live color-coded table preview, duplicate validation, quick stats, ConfidencePill scoring) is confirmed dead code: grep for "ColumnMapper" across all `frontend/src` `.tsx/.ts` files returns only the component definition — zero imports anywhere else. `UploadPage.tsx` lines 86 hit is a comment string, not an import. `UploadPage.tsx` lines 328–551 implement a simpler inline mapping form.  
**Evidence:** `frontend/src/components/ColumnMapper/ColumnMapper.tsx` vs `frontend/src/pages/UploadPage.tsx`.  
**Fix:** Replace the inline mapping block in `UploadPage.tsx` (lines 328–551) with the `ColumnMapper` component, passing `preview.columns`, `preview.sample_rows`, and an `onMappingComplete` handler.

#### UX-H5 — MIT license buried in two-word footer; AGPL / open-core contrast never made
**Severity:** High | **Effort:** S  
**Competitor evidence:** "AGPL license is a non-starter for most companies." (opencoreventures.com). Google has a blanket internal ban on AGPL. Apromore OSS repos archived. The LICENSE difference is the single strongest legal differentiator FlowMiner has.  
**Current status:** `LICENSE` confirms verbatim MIT. `README.md` lines 199–201: the full license section is "## License / MIT. See `LICENSE`." — two words plus a link. Zero mentions of AGPL, open-core, or comparative license framing anywhere in the codebase outside `node_modules`.  
**Evidence:** `README.md` lines 199–201; `LICENSE` (verbatim MIT confirmed).  
**Fix:** Make "Permissive MIT — no AGPL trap, no open-core paywall, the whole product is the open product" a top-of-README headline. Explicitly contrast: "Unlike pm4py (AGPL) you can embed FlowMiner in a commercial product. Unlike Apromore, conformance/simulation/connectors/AI are not behind a paywall."

#### UX-H6 — No anti-lock-in / data-portability narrative despite strong export infrastructure
**Severity:** High | **Effort:** S  
**Competitor evidence:** Celonis "non-cancelable and non-refundable during the committed term. No downgrades." SAP charges customers "for the privilege of accessing information you already own." The 2025–2026 market anxiety is data lock-in.  
**Current status:** Export infrastructure is real and broad: `project_io.py` exports a full JSON manifest (project metadata, dashboards, alerts, KPIs, initiatives, action rules, event log metadata with SHA256 checksums) via `GET /{project_id}/export` — but this endpoint is not wired into the frontend UI at all, making it invisible. `mining.py` has `export_bpmn`, `export/{id}/csv`, `export/{id}/excel`. None surfaced in README.  
**Evidence:** `backend/app/api/project_io.py` (export/import endpoints); `README.md` (absent).  
**Fix:** Wire `project_io` export/import into the UI (Settings → Export Project). Add a "Your data, your exit" positioning section: "No 3-year contract. No data-access tax. Stop the containers and walk away with everything."

#### UX-H7 — Self-host time-to-value story is strong but never pitched against Apromore / ProM install pain
**Severity:** High | **Effort:** S  
**Competitor evidence:** Apromore CE required manual port edits, MySQL 5.6, Java 8, Ubuntu 18.04, separate Kafka. ProM "can't be opened because the developer cannot be verified" on Mac. Disco is praised for "no implementation required." FlowMiner matches Disco's ease but the README presents it as neutral mechanics.  
**Current status:** `Makefile` `up` target chains `localhost` overlay then `wait` (polls `/health/ready`). `scripts/init-env.sh` auto-generates 4 secrets. `.env.example` has only 3 REQUIRED secrets. Deploy footprint is 2 vCPU / 4 GB VPS (documented in `deploy/demo/README.md`). README quick-start mentions timing parenthetically but makes no competitive claim.  
**Evidence:** `Makefile`; `scripts/init-env.sh`; `README.md` quick-start section.  
**Fix:** Lead the README with a quantified time-to-value claim: "From `git clone` to your first process map in under 10 minutes on a 4 GB VPS — no consultant, no ETL project, no MySQL/Kafka yak-shaving." Add a 60–90s asciinema/GIF of `make up` → register → upload sample → map.

#### UX-H8 — No "No Center of Excellence required" positioning despite self-serve AI being complete
**Severity:** High | **Effort:** S  
**Competitor evidence:** Celonis requires a $400–700K/yr CoE. PQL is "proprietary ... claims that any user can build an analysis are not accurate." "The biggest switch driver away from enterprise tools is the consultant-dependency trap." (G2, TrustRadius, PeerSpot).  
**Current status:** Self-serve scaffolding is architecturally complete: `UploadPage.tsx` confidence-scored auto-mapping, `services/chat_tools.py` (6 grounded tools: show\_bottlenecks, show\_rework, show\_variants, show\_events\_over\_time, show\_conformance, show\_predictions), `components/Connectors/ExtractionCopilot.tsx` (generates SQL/pandas), `api/ai.py` (narrate, suggest-best-practice, text-to-bpmn), `mcp/server.py`. Zero README/positioning copy frames any of this as "no consultant / no CoE / no proprietary query language."  
**Evidence:** `backend/app/services/chat_tools.py` lines 64–177; `README.md` (absent).  
**Fix:** Add positioning pillar: "No Center of Excellence. No SI engagement. No proprietary query language." Contrast FlowMiner's natural-language AI chat against Celonis PQL. Show the Extraction Copilot generating the SQL a Celonis project would bill a consultant for.

#### UX-H9 — Keyboard navigation absent from all custom dropdowns; zero `aria-current` on sidebar nav
**Severity:** Medium-High | **Effort:** M  
**Competitor evidence:** Accessibility is a procurement requirement for government and regulated sectors — exactly the on-prem buyers FlowMiner should be targeting.  
**Current status:** Zero matches for `aria-current` across all of `frontend/src`. Zero `aria-expanded`, `aria-haspopup`, `aria-controls`, `aria-selected`, `aria-activedescendant`. `Layout.tsx` line 52 uses a semantic `<main>` element (correct). Cytoscape canvas is completely opaque to screen readers with no textual/table fallback. Arrow keys do not move between items in global search results, user menu, Deep Analyses mega-menu, or AnalysisHub sub-items.  
**Evidence:** `frontend/src/components/Layout/Sidebar.tsx` lines 142–175; `frontend/src/pages/ProcessViewPage.tsx` (AnalysisDropdown).  
**Fix:** Add `aria-current="page"` to NavLinks. Add `role="menu"` + `role="menuitem"` + arrow-key navigation to custom dropdowns. Add `aria-labels` to icon-only buttons. Provide a textual/table fallback for the process map (the data already exists from `get_dfg`/`get_variants`).

---

### 4.3 Medium (6)

#### UX-M1 — Column auto-detect is name-only; anonymized/ETL exports get zero matches
**Severity:** Medium | **Effort:** M  
**Current status:** Two independent keyword-only implementations confirmed. `UploadPage.tsx` lines 87–165: `scoreCol()` lowercases column name and sums keyword-match weights; returns 0 for any name without a keyword. `ColumnMapper.tsx` uses the same approach. `preview.sample_rows` is already in scope on the frontend — content-based heuristics would require no backend changes.  
**Evidence:** `frontend/src/pages/UploadPage.tsx` lines 87–165; `frontend/src/components/ColumnMapper/ColumnMapper.tsx`.  
**Fix:** Add content-based fallback: ISO-8601/epoch regex scan for timestamp, cardinality/repetition profile for case-ID candidates, low-cardinality string for activity. Pure frontend change on existing preview data.

#### UX-M2 — Connector setup has no schema preview or auto-detect post "Test Connection"
**Severity:** Medium | **Effort:** M  
**Current status:** `ConnectorForm.tsx` lines 1020–1068: three plain text inputs for column names, no dropdown, no schema fetch, no confidence scores. `BaseConnector.get_schema()` is an `@abstractmethod`; `DatabaseConnector` and `CsvConnector` implement it; but there is no `GET /{connector_id}/schema` endpoint in the API router.  
**Evidence:** `frontend/src/components/Connectors/ConnectorForm.tsx`; `backend/app/api/connectors.py`.  
**Fix:** Wire existing `get_schema()` implementations into a new `GET /{connector_id}/schema` endpoint. Replace the three text inputs in `ConnectorForm` with a post-test-connection schema-fetch flow that populates dropdowns — mirroring `ColumnMapper` exactly.

#### UX-M3 — Three simultaneous filter systems feed different pipelines with no user indication
**Severity:** Medium | **Effort:** S  
**Current status:** Three components co-rendered in `ProcessViewPage.tsx` (lines 720–763): `FilterPanel` (sidebar, toggleable), `FilterExpressionBar` (DSL), `FilterChipBar`. These are not just undifferentiated — they feed different pipelines: `FilterPanel` exclusively controls the process map via local `ProcessFilter` state (`useState` at line 250). `FilterExpressionBar` and `FilterChipBar` write into a global Zustand chip store that drives analysis sub-pages but does NOT re-run the process map computation. A user who sets a panel filter and a chip filter has both active simultaneously on different parts of the UI with no visible indication.  
**Evidence:** `frontend/src/pages/ProcessViewPage.tsx` lines 720–763, 250.  
**Fix:** Make chips the canonical truth: have the panel and DSL bar emit chips. Show every active filter as a chip regardless of entry point. Tuck the DSL bar behind an "Advanced" toggle with a one-line "all filters combine (AND)" hint.

#### UX-M4 — Spaghetti model: manual sliders with no automated algorithm guidance
**Severity:** Medium | **Effort:** M  
**Current status:** Algorithm buttons have only `title={opt.label}` (the algorithm name). No tooltip explains when to use each. No threshold recommendation based on log shape. Clean View auto-fires for >80 edges (`computeCleanComplexity()`) but provides no rationale for the threshold or the algorithm chosen. Competitors are criticized for the same blank-canvas problem.  
**Evidence:** `frontend/src/pages/ProcessViewPage.tsx` (algorithm segmented-button bar); `backend/app/services/discovery.py`.  
**Fix:** Add an algorithm recommender: inspect log shape (variant count, concurrency, log size) and auto-select miner + threshold with a one-line rationale ("446 variants, top 5 cover 29% → Inductive Miner @ noise 0.2 keeps it readable"). Reuse existing AI narration to caption the diagram.

#### UX-M5 — `'/'` shortcut documented but not implemented; `aria-current` absent
**Severity:** Medium | **Effort:** S  
**Current status:** `useKeyboardShortcuts.ts` lines 3–19: only handles `'?'` (show shortcuts). `ShortcutsModal.tsx` line 6 documents `'/'` as "Focus search" — but pressing `'/'` from anywhere in the app does not focus the search field. The header input handles its own focus only when it already has focus.  
**Evidence:** `frontend/src/hooks/useKeyboardShortcuts.ts`; `frontend/src/components/common/ShortcutsModal.tsx`.  
**Fix:** Add a global `'/'` keydown handler in `useKeyboardShortcuts.ts` that calls `.focus()` on the search input ref (or dispatches a focus-search action via Zustand).

#### UX-M6 — ProjectPickerPage forces an extra click for single-project users
**Severity:** Low-Medium | **Effort:** S  
**Current status:** `ProjectPickerPage.tsx` lines 37–98: the only short-circuit branch is `projects.length === 0` (empty state). Any count ≥ 1 renders the full picker grid. The `useEffect` (lines 29–31) calls only `fetchProjects()` with no navigate side-effect. Users with one project must click through the picker for every Initiatives and Benchmark visit.  
**Evidence:** `frontend/src/pages/ProjectPickerPage.tsx` lines 29–31, 37–98.  
**Fix:** After projects load, if `projects.length === 1`, call `navigate(nextPathTemplate.replace(':projectId', projects[0].id), { replace: true })` immediately. Two-line addition.

---

### 4.4 Low (2)

#### UX-L1 — Breadcrumb drops UUID silently, leaving context-free one-word crumbs
**Severity:** Low | **Effort:** S  
**Current status:** `Header.tsx` lines 40–46: for a terminal UUID segment (`i === segments.length - 1`) the `useBreadcrumbs` hook hits `continue` and drops it entirely. The breadcrumb for `/variants/{uuid}` renders only "Variants" with no resource identity. The UUID is not shown truncated — it is silently absent.  
**Evidence:** `frontend/src/components/Layout/Header.tsx` lines 40–46.  
**Fix:** Expose the resolved event-log name via a shared store slot (e.g. `useEventLogsStore.currentEventLogName`) and substitute it for UUID breadcrumb segments.

#### UX-L2 — Full-screen spinners everywhere; zero skeleton screens; synchronous ML training blocks
**Severity:** Low | **Effort:** M  
**Current status:** 20+ pages use `<LoadingSpinner size="lg" fullPage />`. The `skeleton`/`animate-pulse` CSS pattern already exists in `LoadingSpkeleton.tsx` but is used on zero page shells. Separate but related: `predict_remaining_time` in `mining.py` trains sklearn models synchronously per-request with no `_run_in_thread` wrapper — unlike its sibling prediction endpoints.  
**Evidence:** `frontend/src/pages/ProjectDetailPage.tsx` lines 123–125; `frontend/src/pages/ProcessViewPage.tsx` line 407; `backend/app/api/mining.py` line ~2945.  
**Fix:** (1) Wrap `predict_remaining_time` in `_run_in_thread` — one-line backend fix. (2) Extend existing skeleton pattern to `ProjectDetailPage` and `ProcessViewPage` page shells so committed content paints immediately. Keep `AnalysisLoading` for genuinely long compute.

---

## 5. Security Findings (3)

These are bugs, not feature gaps. They must be resolved before any public release or production deployment is advertised.

| # | Finding | Severity | File | Description | Fix |
|---|---|---|---|---|---|
| S1 | **Streaming endpoints have zero authentication** | High | `backend/app/api/streaming.py` lines 177, 241, 247 | `websocket_endpoint` (`/ws/{event_log_id}`), `get_live_kpis` (`/live-kpis/{event_log_id}`), and `ingest_event` (`/ingest/{event_log_id}`) have no `Depends(get_current_user)`. The `Depends` and `Query` imports are present (line 23) but applied to zero endpoints. Any unauthenticated client can inject arbitrary events or read live metrics for any event log. | Add `current_user: User = Depends(get_current_user)` to all three endpoints. Validate that `current_user` has read/write access to the referenced `event_log_id` before processing. |
| S2 | **Dashboard collaboration WebSocket passes identity as unverified query string** | High | `backend/app/api/streaming.py` (dashboard collab WS endpoint) | The dashboard collaboration WebSocket accepts `username` as a raw URL query string parameter with no JWT verification. Any client can claim any identity, including impersonating other users or admins. | Replace query-string identity with JWT validation on WebSocket connect: extract the `Authorization` header (or a `token` query param for WS compatibility) and validate it with the existing `get_current_user` dependency before accepting the connection. |
| S3 | **Anonymizer is reversible pseudonymisation with static salts — not GDPR-anonymous** | Medium | `backend/app/services/anonymizer.py` lines 11–17 | `_hash_value` uses SHA-256 with static salt strings (`'flowminer'`, `'resource'`, `'case'`, `column_name`) truncated to 8 hex chars. This is deterministic pseudonymisation: anyone with the salt (hard-coded in the source) and a finite value set (e.g. employee IDs, case numbers) can reverse it by brute force or dictionary lookup. The module has no documentation disclosing this. The product surfaces this feature as "anonymisation" in the UI and `api/privacy.py`. | (a) Add a clear docstring to `anonymizer.py` and UI tooltip to `privacy.py` disclosing: "This is pseudonymisation (reversible with the source value set), not GDPR-grade anonymisation." (b) For GDPR-grade anonymisation, replace static salts with a per-deployment secret from settings and add a one-way generalisation/suppression mode as an alternative. Do not claim GDPR compliance for the current implementation. |

---

## 6. Positioning / GTM Gaps (10 items, summary table)

Full details in §4 and §3 above. Summary for GTM planning:

| # | Gap | Severity | Effort | Status | One-line Fix |
|---|---|---|---|---|---|
| G1 | README is a feature catalog, not a positioning weapon | Critical | S | Absent | Rewrite top third with competitor thesis + comparison table |
| G2 | MIT license advantage never stated vs AGPL / open-core | High | S | Present but invisible | Add "no AGPL trap, no open-core paywall" headline + shields badge |
| G3 | No anti-lock-in / data-portability narrative | High | S | Present but invisible | Add "Your data, your exit" section; wire project-export to UI |
| G4 | Self-host time-to-value not quantified or pitched vs Apromore/ProM pain | High | S | Present but invisible | Lead README with `< 10 min` claim + asciinema GIF |
| G5 | No "No CoE / no SI / no PQL" anti-consultant positioning | High | S | Present but invisible | Add positioning pillar contrasting AI self-serve vs PQL CoE |
| G6 | OCEL/OCPM positioned as a bullet not a differentiator | Medium | S | Partial | Elevate to headline pillar; be honest about OPerA roadmap boundary |
| G7 | No SMB / mid-market / consultant-pre-sales wedge | Medium | M | Absent | Pick 3 wedge audiences; stand up DEMO\_MODE public instance |
| G8 | On-prem/sovereign capability unframed for regulated buyers | Medium | S | Present but invisible | Add "On-prem & sovereign by default" section; clarify pseudonymisation |
| G9 | No community channel / support-tier / governance signal | Medium | S | Absent | Add Discussions link, support-tier statement, fix CODE\_OF\_CONDUCT dead link |
| G10 | No prebuilt images / versioning / release story | Medium | M | Absent | GitHub Actions release workflow; GHCR tags; CHANGELOG.md |

---

## 7. Backend Quality Observations

These are not UX findings but are surfaced here because they affect correctness claims made in positioning copy.

| Observation | Severity | File |
|---|---|---|
| Snowflake, BigQuery, ServiceNow, Workday, Coupa, Ariba, Oracle Fusion connectors are fully implemented but `_get_connector_service()` only handles 9 types — selecting these in a hypothetical UI returns HTTP 400 | High | `backend/app/api/connectors.py` lines 41–65 |
| OC Petri Net endpoint returns only structural stats (activity/place/arc counts) with no visual net topology — the entire value of the feature | High | `backend/app/api/ocel.py` `get_oc_petri_net` lines ~1150–1218 |
| Alignment conformance returns `precision=None`, `generalization=None` — users switching from token\_replay to alignment silently lose two metrics with no warning | Medium | `backend/app/services/conformance.py` `_alignment_conformance` lines ~329–336 |
| EMD stochastic conformance scipy fallback uses rank-encoded Wasserstein (documented as "APPROXIMATION") with no indicator to callers | Medium | `backend/app/services/conformance.py` `compute_stochastic_conformance` lines ~906–938 |
| `predict_remaining_time` trains sklearn synchronously per-request with no thread offload; blocks request thread for several seconds on large logs | Medium | `backend/app/services/predictive.py` (all `predict_*` methods); `backend/app/api/mining.py` ~2945 |
| LiNGAM causal DAG caps at `top_k=20` activities with no feedback to caller about excluded activities | Low | `backend/app/services/causal.py` `_build_duration_matrix` lines ~43–44 |
| OCEL in-memory store evicts oldest 20% (not LRU) when >50 items; reload path does a synchronous DB lookup inside `threading.Lock` | Low | `backend/app/api/ocel.py` `_BoundedOcelStore.__setitem__` lines ~73–406 |
| DES pure-Python fallback (`_run_pqueue`) skips resource contention — a scenario with `resource_pool_overrides` produces the same throughput whether capacity is 1 or 10 | Medium | `backend/app/services/simulation_des.py` `_run_pqueue` lines ~441–478 |

---

## 8. Onboarding Path Audit

The new-user journey from CSV to first insight has structural strengths (drag-and-drop upload, confidence-scored auto-detection, demo datasets, `OnboardingWizard` banner, `ProductTour`) but three confirmed breaks at critical moments:

1. **ColumnMapper.tsx is not wired into `UploadPage`** (UX-H4 above) — the step where a user first maps their columns uses an inferior inline form instead of the polished component that already exists.

2. **ProductTour selectors are dangling** (UX-H3 above) — the tour fires with an 800ms delay on the process view, but 5 of 6 spotlight targets do not exist in the DOM. The tour appears to run but highlights nothing.

3. **OnboardingWizard steps 3–4 have no CTA** — `OnboardingWizard.tsx` lines 38–51: steps "Explore the process map" and "Run deep analysis" have `step.action = null` and `step.path = null`. After reading two informational slides the user is stranded with only "Next" or "Got it."

**Recommended priority sequence for the onboarding fix:**
1. Add the 5 `data-tour` attributes (< 1 hour).
2. Wire `ColumnMapper` into `UploadPage` mapping step (2–4 hours).
3. Add "See Insights" CTA on done-step pointing to `MissionControlPage` (30 min).
4. Add CTA buttons to `OnboardingWizard` steps 3–4 with `navigate()` calls (30 min).

---

## 9. Competitor Landscape Reference

| Tool | License | Self-host | Conformance | Simulation | OCEL | AI/Copilot | Price (2025–2026) |
|---|---|---|---|---|---|---|---|
| **FlowMiner** | MIT | Yes (docker-compose, 4 GB VPS) | 5 methods + stochastic EMD | DES (SimPy + fallback) | Full OCEL 2.0, OC-DFG, 5 object graphs | AI chat + MCP + Copilot | Free / MIT |
| Celonis | Proprietary | No (SaaS only) | Yes (token replay, alignment) | No | OPerA (paid) | Process Copilot (AgentC) | $150K–$1.26M+ Year-1 TCO |
| Apromore CE | Open-core (archived Aug 2025) | Was self-hosted | Enterprise only | Enterprise only | No | Enterprise only | Free CE (archived); enterprise negotiated |
| pm4py | AGPL-3.0 | Library (Python) | Yes (full) | Stochastic replay | Basic | No GUI | Free (AGPL) |
| Disco | Proprietary | Desktop-only | No | No | No | No | ~€2K/yr individual |
| SAP Signavio | Proprietary | No (SAP BTP cloud) | Yes | Basic | No | Yes | Bundled with SAP; no public pricing |
| UiPath PM | Proprietary | On-prem option | Yes | Basic | No | Yes | $15K–$150K/yr |
| Power Automate PM | Proprietary | No (M365 cloud) | Basic | No | No | Copilot (limited) | Included in M365 E5 |
| IBM PM | Proprietary | On-prem option | Yes | Yes | No | Yes | ~$3.2K/mo published |

---

*Audit sourced from: 8 competitor research deep-dives (Celonis, Apromore, Power Automate/Signavio, UiPath/IBM/ARIS, Disco/QPR/Workfellow, pm4py/ProM/bupaR, general buyer pain-points, cross-vendor pricing), 3 codebase capability maps, 31 candidates each verified against live source files at `/home/josh/Documents/Projects/flowminer`. Dated 2026-06-02.*
