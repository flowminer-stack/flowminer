# FlowMiner Competitive UX & Feature Audit
**Date: 2026-06-10**

> ## ⚠️ Verified corrections (added post-audit, 2026-06-10)
> The research/synthesis agents reasoned from repo *contents*, not the live infrastructure, and got the deployment picture wrong. Verified against the running system and build files:
>
> - **`demo.flowminer.io` is already LIVE.** `curl -L https://demo.flowminer.io` → HTTP 200, serving the real built SPA (title "FlowMiner", hashed Vite bundles); backend `/health` → 200. The `flowminer.io` landing page is live too. It auto-deploys via Dokploy on push. **→ §1 move #2 "deploy the already-built demo" is already done — drop it.** The "no public demo link / undeployed demo kit" framing throughout this report is FALSE.
> - **`rust_accel` is baked into the production image.** `backend/Dockerfile:36-58` installs the Rust toolchain and runs `maturin build --release` + installs the wheel into the runtime venv. The "must run maturin develop or it's slow" caveat is a *local-dev* note, not a deployment gap. **→ "bake rust_accel in" is already done.**
> - **`lingam`, `shap`, `simpy`, `croniter` are in `backend/requirements.txt`** (lines 73/48/89/20) → present in the deployed image. Only `ocpa` is deliberately excluded (documented pm4py pin conflict, `backend/requirements.txt:94-105`). **→ "bundle optional deps" is ~95% already done; the residual is only the deliberate ocpa exclusion + degraded-mode *labeling* for minimal/custom self-host installs.**
>
> **Still true (re-verified):** zero git tags (`git tag` empty) → push `v0.1.0`; `<you>` placeholder clone URLs in README.md:83, docs/why-flowminer.md:169, CONTRIBUTING.md:24. The discoverability / chat-tool / write-back items below are deployment-independent and stand — **except** the AI-no-key dead-end, which does NOT apply on the live demo (it ships an OpenRouter key) and needs a separate fresh-install recheck.

## 1. Executive Summary

FlowMiner is, on the evidence of its own codebase, the deepest self-hostable process mining platform in existence. It ships capabilities that the entire open-source ecosystem lacks and that commercial incumbents charge six figures for: stochastic conformance (JSD/EMD), queue mining (Erlang-C), causal discovery (LiNGAM), discrete-event simulation, predictive monitoring with SHAP, OCEL 2.0 with state-aware OCPM, and a Rust acceleration layer that makes large-log analysis tractable. Layered on top is an AI assistant with tool-use, an Extraction Copilot that writes the ETL SQL, an LLM column-mapper, and — uniquely in this market — an MCP server that lets Claude Desktop/Cursor/Zed query a FlowMiner instance directly. pm4py is a library, Disco is discovery-only, Apromore Community Edition is gutted and now archived. FlowMiner is none of those things. The product is genuinely good.

**The single biggest thing holding it back is not capability — it is that almost nobody can find the capability, and almost nobody knows the product exists.** Two binding constraints dominate everything else. First, *discoverability*: roughly 16 of the most differentiating analysis pages (Causal Map, Cases-at-Risk, Automation ROI, Process Health, Drift, Root Cause, Social Network, Simulation) are reachable only via the ⌘K palette or by drilling into a project card — they appear nowhere a browsing user would look. The AI layer renders a raw error dump instead of a setup prompt when no key is configured. The post-upload landing screen is the most control-dense surface in the product. The deep backend is largely unreachable through the conversational interface non-technical users actually use. Second, *distribution*: there are no git tags, the README clone URL is literally `github.com/<you>/flowminer.git`, there is no public demo link (despite a fully-built demo deployment kit sitting in the repo), and FlowMiner appears in zero "Celonis alternative" comparison articles where buyers are actively searching right now.

The competitive opening is enormous and time-sensitive. Celonis is bleeding mid-market and regulated buyers over price ($286K median enterprise contract), mandatory Centers of Excellence, proprietary PQL lock-in, and cloud-only architecture. SAP Signavio jacked prices post-acquisition and treats non-SAP data as second-class. **Apromore's open-source Community Edition was archived in August–September 2025 after the Salesforce acquisition — those self-hosting users are stranded and shopping right now**, and FlowMiner has no importer to catch them. Every major incumbent is structurally cloud-only and cannot serve EU banking, healthcare, government, or defence — an uncontested beachhead FlowMiner owns by architecture.

**The top five moves, in order:**

1. **Make depth discoverable.** Add a browsable "Analyses" catalog to the sidebar, fix the AI-no-key dead-ends, surface the data-quality report on the landing screen, and expand the AI chat tool catalogue to expose the cases-at-risk / simulation / SNA backends that already exist. These are mostly S/M-effort fixes that convert a hidden asset into a visible one.
2. **Win the distribution war.** Push a `v0.1.0` tag (the release pipeline is already wired), deploy the already-built `demo.flowminer.io`, replace the `<you>` placeholder, and seed "Celonis/Apromore alternative" comparison content. Capability is done; ROI is now almost entirely in being findable.
3. **Catch the Apromore exodus.** Ship a "Migrate from Disco/Apromore" XES importer with mapping auto-carry (≈1 day on existing infrastructure) and market it loudly to stranded CE users.
4. **Reposition around depth + sovereignty + AI/MCP, not "cheap."** Lead every surface with "the depth of Celonis, your infrastructure, no query language, no CoE." Carve an explicit regulated/sovereign beachhead. The positioning doc already says all this — it just isn't surfaced in-product.
5. **Build the close-the-loop write-back** (Jira/ServiceNow issue creation) to neutralize Celonis's single most-cited differentiator (EMS/Action Flows) — the connectors are already authenticated, the write path is an extension, not a greenfield build.

The rest of this report grounds each of these in competitor evidence and verified code.

---

## 2. The Competitive Landscape — what users actually say

### Celonis — the market leader users love to leave

**Loved:** best-in-class variant explorer and visualization ("excelling at the process mining part and showing event logs and process variants" — Gartner Peer Insights); the deepest SAP connector library; PQL's expressiveness for analysts who master it; and the EMS/Action Flows insight-to-action loop, which even critics concede is conceptually unmatched.

**Hated:** Pricing is the dominant complaint. No public rate card; enterprise median of **$286,356/year** (SpendHound, 160 contracts); a consultant quoting the jump from "$15,000 entry-level to $200,000+ when scaling across business units" (PeerSpot). Gartner rates Celonis 4.1/5 on Evaluation & Contracting, its *lowest* dimension. PQL is proprietary lock-in: *"a code that only Celonis uses, so there is little help on the internet or through AI beyond the Celonis documentation"* (Gartner). The platform "cannot be self-served" — it requires a 5–20 FTE Center of Excellence (Celonis' own research, via Diginomica). And it is SaaS-only, structurally excluding regulated industries.

**The switching opening:** Cost, consultant dependency, PQL lock-in, and cloud-only deployment are all things FlowMiner inverts by design. The strongest single quote for FlowMiner's pitch is the Glassdoor employee review: *"Overpriced complicated products with overhyped value realization story — customers do not need all the bells and whistles to do decent process mining; competitors are catching up at a discount."*

### Apromore & the open-source ecosystem — the stranded segment

**Loved:** academic-grade simulation, Gartner Leader recognition, application-neutrality, and a free Community/Core edition that gave researchers and PoC teams a real starting point.

**Hated (and now fatal):** **ApromoreCore was archived read-only on 29 August 2025; ApromoreDocker on 1 September 2025** — *"The source code available in this repository is now deprecated."* The Salesforce acquisition broke the neutrality promise that was the entire reason non-Salesforce shops chose it. The free tier was always gutted (conformance, dashboards, filters, simulation all enterprise-only), and now there is no maintained self-host path at all.

For the broader OSS world the pains are structural: ProM crashes on non-trivial logs and overwhelms users with "200+ plugins with no guidance on which to use"; pm4py "is just a library" with no UI, single-threaded performance, and graphviz dependency hell; and across all of them **ETL is non-existent** — *"ETL functionality in process mining tools is lacking... you are on your own there"* (PMC11646219, 41-analyst study).

**The switching opening:** This is FlowMiner's most direct audience and its most time-sensitive one. Stranded Apromore CE users are *actively shopping* and need a maintained, self-hostable tool with the depth they had — exactly FlowMiner's profile.

### Microsoft & SAP — the suite-bundled hyperscalers

**Microsoft Power Automate Process Mining** wins on M365/Azure gravity and task mining, but is a **$5,000/tenant/month add-on** on top of Power Automate Premium, is "best suited for process discovery" (not conformance or continuous monitoring), cannot do ETL ("isn't equipped with transforming or preparing any ETL work" — its own Copilot FAQ), and degrades sharply on non-Microsoft data.

**SAP Signavio** is frictionless for SAP shops but *"After SAP acquired Signavio, the prices increased significantly, making it too expensive for our small company"* (PeerSpot). Non-SAP data is a "second-class citizen," Process Insights "hardcodes SAP best-practice assumptions" that are "invalid" for evolved processes, and the Celonis-SAP antitrust suit (data-extraction "toll booth") is actively shaping buyer decisions.

**The switching opening:** Both explicitly abandon the SMB, sovereignty, and non-suite segments. Both are cloud-only. FlowMiner's hardcoded-benchmark *avoidance* (overridable reference targets, not SAP-best-practice lock-in) is the safe counter-position.

### UiPath / IBM / ARIS — the second tier

UiPath wins on the RPA-mining loop but has a thin connector library (~10–12 vs Celonis's 100+), "congested" process maps, no drag-and-drop dashboards, and a 30%-of-project SQL data-prep tax. IBM is "too high" priced for SMBs with "thin onboarding documentation." ARIS owns the BPM-to-mining conformance loop but suffers Citrix slowness, multi-day maintenance windows, split modeling/mining environments, and — critically — **vendor-stability fear after the 2025 Software AG divestiture**. All three lose to self-hostable options on cost transparency, data sovereignty, and per-seat/per-event pricing.

### Disco & the simple tools — the UX benchmark

Disco is the cautionary tale FlowMiner must respect. It is beloved for **near-zero time-to-value** ("value virtually immediately after downloading"), **calm intuitive UX** ("a pleasant look and feel, without unnecessary bells and whistles"), and **local-execution privacy**. Its limits — discovery-only, closed data, desktop-only, no collaboration — are exactly where FlowMiner is stronger. But Disco's *feel* is the bar: the moment FlowMiner's first-touch screen feels denser or more intimidating than Disco, it loses the very "fleeing the steep curve" buyers it targets. **This is the most important UX lesson in the entire research corpus.**

---

## 3. What FlowMiner Has Today (grounded in code)

**Genuinely strong (full maturity, verified in code):**

- **Core mining.** Discovery (DFG, Alpha, Heuristic, Inductive IM/IMf, Split Miner v2, ILP) with Rust acceleration (`backend/app/services/discovery.py`, `rust_accel.py` — DFG ~400x, Inductive ~95x byte-identical to pm4py). Conformance across six methods including alignment-based, decomposed SESE, and stochastic JSD/EMD (`conformance.py`). Bottleneck/DBSM scoring (`bottleneck.py`), queue mining (`queue_mining.py`), drift detection (`drift.py`).
- **Predictive/causal/simulation.** Remaining-time GBR, outcome RF, next-activity, suffix prediction, and SLA-breach alarm scoring with proper OOF cross-validation and model persistence (`predictive.py`); DES simulation with resource pools and scenario deltas (`simulation_des.py`); causal LiNGAM DAG (`causal.py`).
- **Operational layer.** Alerts with live `/test` (`alert_engine.py`), action rules with dry-run/cooldown (`action_engine.py`), initiatives/ROI tracker with live `/measure` recompute and 19 value-calculator formulas (`initiatives.py`, `value_calculators.py`), scorecards with cost-of-quality FTE quantification (`scorecards.py`), governance lifecycle (`governance.py`), audit logs, privacy/anonymization.
- **AI/MCP.** Streaming tool-use chat (`ai.py`, `chat_tools.py`), Extraction Copilot (`ai_tools.py`), LLM column-mapper (`mapping_suggester.py`), 9-tool MCP server (`mcp/server.py`), 5-provider abstraction incl. local Ollama (`llm.py`).
- **Onboarding/upload flow.** The CSV → confidence-scored auto-mapping → live-preview ColumnMapper → direct-to-Mission-Control path is the most polished part of the product and beats most commercial tools. The demo seeder (`demo_seeder.py`) ships 5 pre-mapped real logs including the full 251K-case BPIC2019.

**Exists but weak:**

- **OCEL/OCPM.** OC-DFG and summary ship, but OPerA performance metrics require the optional `ocpa` package and error out if absent (`ocel_improvements.py`).
- **Analytical query layer.** Only a case-*filter* DSL (`filter_engine.py`) plus arithmetic over 9 fixed scalar metrics (`custom_kpis.py`). No graph-aware computation (e.g. "avg time A→B per resource group").
- **Streaming.** A real WebSocket live-KPI backend exists (`streaming.py`) but is entirely unwired in the frontend; `ProcessPulsePage` only animates the *static* map.
- **Collaboration.** Threaded annotations on activities/edges work end-to-end, but `@mentions` are a cosmetic placeholder, assignment fires no notification, and there is no shareable "finding" object.
- **Benchmarking.** Two cross-log benchmarks exist but compare only the user's own logs; template KPI targets exist but aren't wired into the benchmark UI as reference baselines.

**Stub:**

- **Task mining.** Capture agent polls window titles only; pattern miner is a bag-of-ngrams counter. The one genuinely differentiated piece — the task→process cross-link endpoint — is buried.

---

## 4. The Gaps That Matter (verified)

### 4A. UX / Usability Gaps

#### G1 — Deep features are undiscoverable (HIGH / M)
**Evidence:** Celonis Community ("the basic 2D process map feels almost like a hidden feature"); ProM ("you don't know what plugins to use"). **Verified state:** ~16 distinct, high-value analysis pages — Causal Map, Cases-at-Risk, Automation ROI, Process Health, Drift, Root Cause, Social Network, Simulation, Dotted Chart, Process City, Lineage, Comparison, Rework, Animation, Pulse, Mission Control — are reachable *only* via ⌘K or project-card drill-down; none appear in the sidebar (`Sidebar.tsx` confirmed; Mission Control is *explicitly* commented out at lines 111–115). The ⌘K button helps but is a *search*, not a *browse*, surface. **This is the inverse of the competitive story:** the deep backend that should win deals is invisible. **Recommendation:** add a persistent browsable "Analyses" catalog grouped by intent (reuse `AnalysisPalette` groups), with one-line descriptions and recommended/locked badges.

#### G2 — Data-quality warnings are invisible in the standard upload flow (HIGH / S)
**Evidence:** 78% of practitioners report data-quality issues as a top challenge (PMC11646219); "wrong conclusions because they skip cleaning event logs" (esystems.fi). **Verified state:** `DataQualityCard` is built and good, but the standard CSV path navigates straight to Mission Control (`UploadPage.tsx` line 212), bypassing the `step==='done'` block (line 466) where the card renders. A first-time user with a messy CSV — the exact target segment — *never sees the quality report.* **Recommendation (option A, low-risk):** on Mission Control, auto-fetch quality stats and show a dismissible banner when severity is high, with one-click jump to the repair tool. This turns a hidden cure into an on-by-default differentiator vs pm4py/Disco/Apromore-CE.

#### G3 — The post-upload landing screen is the densest in the product (HIGH / M)
**Evidence:** Disco loved for "no unnecessary bells and whistles"; UiPath maps hated as "congested." **Verified state:** ProcessView stacks **~21 interactive controls** (9 top-bar + 12 map-strip) before any insight, both rows `flex-wrap` to two lines on medium viewports, and a `w-64` right panel renders even with no node selected. Auto-Clean View only triggers above 80 edges, so small/medium logs land on the full unconstrained surface. **Recommendation:** lower the auto-simplify threshold to ~40 edges; collapse Detail/Clean/count/"what does this mean" into a single "Simplify" control; make the right panel opt-in. Lead new users with a calm view and a one-click "Advanced" reveal.

#### G4 — Three parallel filter mechanisms, self-flagged in code (HIGH / M)
**Evidence:** Celonis "overly cumbersome steps to apply filters" + 15-filter cap; Disco loved for intuitive sliders. **Verified state:** FilterPanel (6 categories), FilterChipBar, and FilterExpressionBar coexist; the code itself flags "Finding #13 — unify the filter systems" in two files. **Recommendation:** make the FilterChipBar the single source of truth (its own tooltip already claims this), demote FilterPanel to a popover editor, and hide the DSL bar behind a power-user toggle.

#### G5 — AI is a silent (worse: error-dumping) no-op without a key (HIGH / S)
**Evidence:** Celonis Copilot is a *loved* differentiator; OSS has no AI-guided analysis at all. **Verified state — worse than feared:** with no LLM key, Mission Control renders the null-provider's raw fallback string (env-var instructions + context dump) *as if it were the executive briefing* — it looks broken. Chat panels stream the same text. The `llm_configured` flag is returned by the API but consumed by only 2 of 5+ AI surfaces. **Recommendation:** read `llm_configured`; render an "Enable AI insights — add a key in Settings → AI" card instead of the dump; repoint existing env-var banners to `/settings?tab=ai`.

#### G6 — AI chat tool catalogue is too narrow (HIGH / M)
**Evidence:** the recurring buyer demand is "self-service analytics without PQL." **Verified state:** only 7 chat tools exist (`chat_tools.py`); the LLM cannot answer "show me the 5 slowest cases," "which cases will breach SLA," "who hands off to whom," or "what if I add a clerk" — despite complete `case_explorer`, `predictive`, `org_mining`, and `simulation_des` backends. The deep analytics are unreachable through the conversational surface non-technical users use, undercutting the no-PQL positioning. **Recommendation:** add `show_slowest_cases`, `show_sna`, `predict_sla_risk`, `simulate_what_if` (each wraps an existing service + a frontend render type). Tools 1–2 are sub-second; 3–4 use the existing model-cache. **This is the single highest-leverage way to convert backend depth into a self-service experience.**

#### G7 — Connector "Test Connection" requires saving credentials first (MEDIUM / M)
**Verified state — confirmed at all three layers:** the test endpoint is ID-keyed and reads only persisted config (`connectors.py` lines 281–301); the frontend gate and a no-op parent handler enforce save-before-test. Data-in is the make-or-break moment; a save-before-validate flow reads as broken. **Recommendation:** add a `POST /connectors/test-config` endpoint accepting raw form-state config without persisting.

#### G8 — Smaller papercuts (MEDIUM–LOW / mostly S)
- **Duration filter** takes raw seconds with a format-mismatched placeholder (`FilterPanel.tsx` 170–197) — replace with a range slider or unit-aware input.
- **Broken `/` shortcut** (`useKeyboardShortcuts.ts` line 12 selects `input[type=text]`; header uses `type="search"`) and **ShortcutsModal omits ⌘K** — two trivial fixes; ⌘K is the entry point to ~30 pages.
- **Product tour** has a broken `ocpm-improvements` selector (spotlights nothing in production) and a backdrop-click that permanently completes the tour with no restart path.
- **Canvas pages** use `calc(100vh-7rem)` (4 pages) which clips on mobile browsers — switch to `100dvh`. Fix before any shared link goes external.
- **Two AI chat surfaces** (FloatingAIChat + AskAI) with no explanation of which to use — add one-line cross-references or consolidate.

### 4B. Missing / Weak Features

#### G9 — No write-back / close-the-loop to source systems (HIGH / L)
**Evidence:** Celonis EMS/Action Flows is the *named core differentiator*; "the story stays on the dashboard, nothing changes" (bpm-d); "2-in-3 initiatives under-delivered" (HFS). **Verified absent:** `dispatch_action()` handles 7 action types, all internal/generic-webhook; `create_task` lands in FlowMiner's *own* task table. No Jira/ServiceNow/Salesforce *write* path exists — but those connectors already hold authenticated httpx clients. **Recommendation:** add `create_jira_issue` / `create_servicenow_incident` action types reusing existing connector auth; surface "where did my action go?" with the external record link. Start Jira + ServiceNow.

#### G10 — Real-time streaming is built but invisible (MEDIUM / M)
**Verified state:** a real WebSocket live-KPI backend exists and is registered (`streaming.py`, `main.py:172`); alerts run on a 5-min batch beat against the stored log; the frontend never connects to the live-KPI stream and `ProcessPulsePage` only animates static data. This is a *wiring* problem, not a build. **Recommendation:** wire a Live-Ops page (sidebar-visible) to the existing stream; fire alert evaluation on ingested events. Market as "real-time process monitoring, self-hosted" — a capability Microsoft and Disco lack entirely.

#### G11 — No analytical query language / graph-aware metrics (MEDIUM / XL)
**Verified state:** only a case-filter DSL + arithmetic over 9 scalars. No "time A→B per resource group." **Recommendation — do NOT build a 150-operator PQL clone.** Lean into the LLM layer: "define a metric in plain English → generated, saveable expression" (the Extraction-Copilot pattern for metrics). This converts Celonis's PQL *strength* into FlowMiner's advantage (no proprietary language, AI-native), directly answering the #1 PQL complaint. Optionally extend the existing `safe_eval` AST with named graph builtins.

#### G12 — Templates/recipes exist but are siloed and uneven (MEDIUM / M)
**Verified state:** 9 log-builder recipes + 19 seed templates exist and *are* surfaced in onboarding and a sidebar Templates page — but TemplatesPage shows blank until an admin clicks "seed," recipe cards link to `/projects?new=1` instead of the builder with the pack pre-applied, and the 3 enterprise recipes (SAP/Salesforce/ServiceNow) lack the default KPIs/alerts the ecommerce/logistics ones have. **Recommendation:** auto-seed on first visit, deep-link recipe cards into the builder, and enrich the enterprise recipes to match.

#### G13 — No external benchmarking; collaboration shallow; task mining a prototype (MEDIUM–LOW)
- **Benchmarking:** wire existing template KPI targets into BenchmarkPage as a labelled "reference target" row — gives Signavio-style "your O2C is 110h vs the 72h reference" anchoring without a licensed dataset.
- **Collaboration:** implement (or remove) the `@mention` placeholder, fire a notification on annotation assignment, add a lightweight shareable "Finding" object.
- **Task mining:** keep and surface the differentiated cross-link endpoint; otherwise defer — the governance overhead (HR/works-council buy-in) makes depth investment XL with uncertain payoff.

#### G14 — A positioning win to bank: most "feared gaps" are already solved
Several capabilities a competitor audit would assume missing are **present and verified** — this is itself a story to tell: a real ROI/value-realization layer, a streaming backend, OCEL 2.0 + state-aware OCPM, stochastic conformance, an MCP server, and a robust onboarding/upload flow. The onboarding-wizard "one-way door" gap was *disproven* (a "Getting started" reopen button exists on the Projects page). The public-demo "missing" gap was *disproven* (a full `deploy/demo/` kit exists — only the README link is missing). These are surfacing problems, not build problems.

---

## 5. Positioning, Pricing & Go-to-Market

FlowMiner has an excellent positioning doc (`docs/why-flowminer.md`) doing **zero conversion work** because it lives in a markdown file no evaluator opens. There is no `/why`, `/compare`, or `/pricing` route, and the Login/Register pages carry generic "MIT licensed, no lock-in" copy with a *commodity* feature list (upload, discover, bottleneck, dashboards) — anything a competitor could write. Fix the surfacing first; the content already exists.

**Reframe the core pitch — depth first, price last.** The internal "cheaper + sovereign" framing is inverted and risks the "budget tool" read that anchors low (Glassdoor: competitors "catching up at a discount"). Buyers leaving Celonis want to *stop overpaying*, not to *downgrade*. Lead with: *"The only self-hostable platform with OCEL 2.0 object-centric mining, stochastic conformance, queue mining, causal discovery, and DES simulation — the depth enterprises pay six figures for, on your infrastructure."* Treat free/MIT/sovereign as the closer. Add the one-line proof: "pm4py is a library, Disco is discovery-only, Apromore CE is archived and gutted."

**Make the AI/MCP wedge the headline, not a feature bullet.** "No query language. No CoE. Ask in plain English — or point your own AI agent at it via MCP" neutralizes *two* incumbent pains at once (PQL lock-in + ETL tax). Ship the roadmap's already-titled "first open-source process-mining MCP server" blog post to reach the Cursor/Zed/Claude-Desktop audience no incumbent is courting.

**Carve the sovereignty beachhead explicitly.** Every major incumbent is cloud-only and *structurally cannot* serve EU banking, healthcare, public sector, or defence. Name the segment, name the disqualifier, name the proof (air-gapped, local Ollama, Fernet-at-rest, RBAC+audit) — and preserve the honest pseudonymisation-not-anonymisation caveat to avoid overclaiming GDPR compliance.

**Lead the value-realization story against the industry's #1 failure narrative.** "Over 2-in-3 process intelligence initiatives under-deliver" is the most damaging incumbent critique — and FlowMiner has *built* the answer (Initiatives tracker, 19 value calculators, cost-of-quality scorecards, Automation ROI). Add a value-realization pillar: "Close the loop — track the dollars, not just the diagrams. Baseline → action → measured savings, in the open product." Pure S-effort messaging on shipped capability.

**Pricing model.** The product is free (MIT) — a real advantage — but the commercial-support tier in SUPPORT.md is itself opaque ("email us," no tiers), reproducing the exact opacity FlowMiner criticizes. Publish a simple table: **Community (free) / Supported (flat annual) / Managed hosting (per-instance)** with at least ranges. Make "unlimited processes, unlimited data volume, flat fee — no per-GB, no per-process, no per-seat data tax" an explicit anti-Celonis-APC message.

**Vertical packaging.** Reframe the 9 shipped recipes as outcome-led solution pages — "FlowMiner for Procure-to-Pay," "for Order-to-Cash," "for IT Service Management / Jira," "for Healthcare pathways" — each pre-wiring the demo log, recipe, KPIs, and ROI calculator. Buyers self-identify by process area, not algorithm.

---

## 6. Prioritized Roadmap

| # | Move | Sev | Effort | Expected impact |
|---|------|-----|--------|-----------------|
| **NOW — quick wins, mostly days** | | | | |
| 1 | Push `v0.1.0` tag + replace `<you>` placeholder URLs | High | S | Materializes GHCR release + GitHub Releases page; removes the single most damaging trust signal |
| 2 | Deploy `demo.flowminer.io` (kit already built) + add "Try live" CTA to README | High | S | Removes the biggest top-of-funnel leak for a self-host tool |
| 3 | Fix AI-no-key dead-ends → "Enable AI in Settings" card (G5) | High | S | Stops the strongest differentiator from looking broken on fresh installs |
| 4 | Surface DataQualityCard banner on Mission Control (G2) | High | S | Eliminates the worst failure mode (wrong map from dirty data) for the target segment |
| 5 | Reorder Login/Register + README to depth-first; add value-realization + sovereignty pillars to why-flowminer.md (§5) | High | S | Stops anchoring low; surfaces the actual moat |
| 6 | Fix `/` shortcut + add ⌘K to ShortcutsModal; fix tour selector + backdrop-dismiss (G8) | Med | S | Removes embarrassing first-impression bugs |
| 7 | Migrate-from-Disco/Apromore XES importer + loud copy (G14/migration) | High | S–M | Catches the active Apromore CE exodus |
| **NEXT — weeks** | | | | |
| 8 | Browsable "Analyses" sidebar catalog (G1) | High | M | Converts hidden depth into a visible selling point |
| 9 | Expand AI chat tool catalogue: slowest-cases, SLA-risk, SNA, what-if (G6) | High | M | Makes the deep backend self-serviceable without PQL — the core wedge |
| 10 | Declutter ProcessView; lower auto-simplify to ~40 edges; opt-in right panel (G3) | High | M | Matches Disco's calm first-touch; lowers the curve FlowMiner claims to lower |
| 11 | Unify filters around the chip bar (G4, "Finding #13") | High | M | Resolves the team's own flagged issue; one mental model |
| 12 | Connector test-with-form-state endpoint (G7) | Med | M | Makes the make-or-break data-in moment feel trustworthy |
| 13 | Publish commercial-support pricing table + roadmap URL + SBOM in release.yml | Med | S–M | Trust-proof trifecta; transparency wedge vs incumbents |
| 14 | `dvh` fix on 4 canvas pages (G8) | Low | S | Stops clipped shared links reading as "unfinished" |
| **LATER — deliberate bets** | | | | |
| 15 | Source-system write-back: Jira/ServiceNow issue creation (G9) | High | L | Neutralizes Celonis's #1 differentiator (EMS) |
| 16 | Wire the live-ops streaming UI (G10) | Med | M | Surfaces a built real-time capability incumbents gate behind enterprise tiers |
| 17 | Vertical solution pages from existing recipes; auto-seed templates; enrich enterprise recipes (G12) | Med | M | Buyers self-identify; collapses time-to-first-insight |
| 18 | Reference-target benchmarking; collaboration (@mention/notify/Finding object) (G13) | Med | M | Signavio-style anchoring; closes the multi-function ownership gap |
| 19 | NL-to-metric "define a KPI in plain English" (G11) | Med | XL | Open, AI-native answer to PQL — only if power-analyst demand materializes |
| 20 | Task mining depth (richer agent, sequence mining) (G13) | Low | XL | Defer unless RPA-adjacency becomes a target segment |

---

## 7. Honest Caveats

- **This audit could not verify actual user behavior.** Every UX severity here is reasoned from code structure plus competitor evidence, not from session recordings, funnel analytics, or usability tests on FlowMiner itself. The ProcessView density, the discoverability gap, and the AI dead-ends are *confirmed in code* — but their real conversion impact must be validated with real evaluators.

- **Market research is competitor-grounded, not FlowMiner-grounded.** The quotes are about Celonis/Apromore/Disco/etc. FlowMiner has **zero independent reviews** (G2/Capterra/PeerSpot), so there is no peer-validation of how its depth or UX actually lands. This thinness is itself the trust gap to close — and it means none of the "FlowMiner wins on X" claims have external proof yet.

- **Several "shipped" capabilities were marked unclear/partial in the source map** (DMN export, sustainability/carbon, counterfactual, custom KPIs depth, several SaaS connectors' `fetch_data` depth). They are not load-bearing in this report's recommendations, but should not be marketed as fully mature without a read.

- **Effort estimates are directional.** "S/M/L/XL" are relative engineering bands, not commitments. The write-back (G9) and live-ops wiring (G10) in particular depend on connector-auth and Celery-dispatch details that warrant a spike before scheduling.

- **The biggest unverifiable assumption is the GTM thesis itself:** that distribution, not capability, is the binding constraint. The code strongly supports "the product is good and undiscovered," but whether the Apromore exodus, the regulated-sovereignty beachhead, and the MCP/dev-tool channel actually convert is a market bet to test cheaply (a demo link + one comparison article + one blog post) before investing heavily.

- **Validate with real users, in priority order:** (1) does a first-time evaluator find the deep analyses without being told about ⌘K; (2) does the upload→Mission-Control flow surface data-quality problems they care about; (3) do stranded Apromore CE users actually try a migration importer; (4) does depth-first messaging outperform sovereignty-first on the regulated segment. These four tests would de-risk the entire roadmap above.
