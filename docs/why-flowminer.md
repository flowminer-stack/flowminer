# Why FlowMiner

**The depth of Celonis, the self-host freedom of open source — without
the AGPL trap, the open-core paywall, or the six-figure non-cancelable
contract.**

Process mining splits into two camps that each ask you to give something
up. The commercial platforms — Celonis, Signavio — give you depth, but
they are cloud-only, priced in six figures, sold on multi-year contracts,
and they put your process data on someone else's infrastructure. The
open-source tools — pm4py, ProM, Apromore's community edition — give you
freedom, but either under a copyleft licence that infects whatever you
build on top of them, behind an open-core wall that reserves conformance
and simulation and connectors for the paid tier, or as a research
toolkit with no product around it.

FlowMiner refuses the trade. It is a complete, self-hostable process
mining product — process discovery, conformance, simulation,
object-centric mining, and a data-grounded AI assistant — under a
permissive MIT licence, that runs on a 4GB VPS you control.

This document makes the case specifically and honestly. Where a
capability is on the roadmap rather than shipped, it says so.

---

## At a glance

| | **FlowMiner** | Celonis | Apromore CE | Disco | pm4py |
|---|---|---|---|---|---|
| **License** | MIT (permissive) | Proprietary | Open-core (LGPL core; enterprise features closed) | Proprietary | AGPL-3.0 (copyleft) |
| **Self-host** | Yes — full stack | No (cloud-only) | Yes (CE), enterprise for the rest | Desktop only | Yes (library) |
| **Conformance** | Yes (fitness / precision / deviations) | Yes | Enterprise tier | No | Yes (library) |
| **Simulation** | Yes (discrete-event, Simod-style) | Yes | Enterprise tier | No | Partial (library) |
| **OCEL / object-centric** | Yes — OCEL 2.0 + state-aware OCPM | Yes (flagship) | Limited | No | Yes (library) |
| **AI assistant** | Yes — data-grounded chat + tool use + MCP | Yes (Process Copilot, cloud) | No | No | No |
| **Connectors** | CSV, XES, OCEL 2.0, REST, SQL, Jira, GitHub, Zendesk, Odoo | 150+ (enterprise) | Enterprise tier | File import only | File import (library) |
| **Pricing** | Free (MIT) | Six-figure, multi-year | Free CE / paid enterprise | Per-seat licence | Free (AGPL) |

The table is the short version. The rest of this page is the argument.

---

## 1. Permissive MIT — no AGPL trap, no open-core paywall

FlowMiner is MIT. You can run it, fork it, embed it in a commercial
product, and ship it to a customer without telling anyone and without
inheriting any licence obligations on your own code. That is a
deliberate choice, and it separates FlowMiner from both open-source
alternatives.

- **pm4py is AGPL-3.0.** It is an excellent library, and FlowMiner
  builds on it for the mining primitives. But AGPL is the strongest
  copyleft licence in common use: if you offer pm4py-derived
  functionality over a network, the AGPL's network clause obliges you
  to release the complete corresponding source of your service under
  the AGPL too. For a lot of teams that is a non-starter, and it is the
  reason a thin product layer around pm4py is not something you can
  casually commercialise. FlowMiner's own application code is MIT;
  pm4py remains a dependency under its own terms.

- **Apromore is open-core.** The community edition is real and useful,
  but conformance checking, simulation, and most of the connectors live
  in the enterprise edition. The open and closed editions are not the
  same product — the community edition is the on-ramp, and the features
  that matter most to a serious deployment are on the other side of a
  sales conversation.

With FlowMiner there is no second edition. Conformance, simulation,
object-centric mining, the connectors, and the AI assistant are all in
the one repository under the one licence.

---

## 2. Your data, your exit

The most expensive thing about a process mining platform is not the
licence — it is the lock-in. Once your event data, your dashboards, and
your institutional knowledge live inside a proprietary cloud, leaving is
a project, not a decision.

The risk is not theoretical. The public dispute between Celonis and SAP
over data-access pricing — and the looming S/4HANA migration deadline
that forces a lot of SAP shops to re-platform anyway — is a reminder
that the layer between you and your own ERP data can be turned into a
toll booth, and that the toll can change while you are mid-contract.

FlowMiner is built so that leaving is always cheap:

- **Full project export to JSON.** A single endpoint
  (`GET /projects/{id}/export`) serialises a project's metadata,
  dashboards, alerts, custom KPIs, initiatives, and action rules into
  one portable manifest, and `POST /projects/import` reads it back. The
  manifest references the underlying event-log files by SHA-256
  checksum rather than embedding them, so you re-attach the raw files on
  import and the importer matches them by digest. Migrating a project
  between two FlowMiner instances — or snapshotting one for backup — is
  a file copy, not a support ticket.

- **Open formats on the way out.** Analysis results export to CSV and
  Excel, and discovered models export to BPMN XML via the inductive
  miner. Object-centric data stays in OCEL 2.0, the open standard.

- **Open formats on the way in.** FlowMiner ingests CSV, XES, OCEL 2.0,
  Parquet, and Excel directly, plus REST APIs, SQL databases, and
  packaged connectors for Jira, GitHub, Zendesk, and Odoo. Any source
  that can produce a case ID, an activity, and a timestamp is fair game.

There is no three-year non-cancelable contract, no per-query data-access
tax, and no scenario where your own process maps become inaccessible
because a renewal lapsed. The data is in your Postgres, on your host.

---

## 3. No Center of Excellence, no SI engagement, no proprietary query language

The hidden cost of enterprise process mining is the people you have to
hire around it. A Celonis rollout typically means a Center of
Excellence, a systems-integrator engagement to build the data model, and
analysts fluent in PQL — Celonis's proprietary Process Query Language —
to ask the platform anything non-trivial. The tool is the cheap part.

FlowMiner is designed so a single analyst can be productive on day one:

- **Auto column-mapping.** On upload, FlowMiner scores each column in
  your file against the roles it needs — case ID, activity, timestamp,
  resource, cost — and pre-fills the mapping with its best guess and a
  confidence score for each. For standard formats you confirm and move
  on; you do not hand-build a schema.

- **Data-anchored AI chat.** The Ask-AI panel is scoped to the current
  log and calls the real mining endpoints. Ask "where are the
  bottlenecks?" and the assistant fetches the actual numbers, returns a
  grounded answer, and can render a chart or propose filter chips inline
  — no query language to learn. It works against OpenRouter, Anthropic,
  OpenAI, a local Ollama model, or a built-in null provider for demos.

- **Extraction Copilot.** When your data is still sitting in a source
  system rather than a clean event log, the Extraction Copilot works
  with you through conversation and **writes the SQL** — standard ANSI
  SQL targeting PostgreSQL, scoped to the tables and columns you have
  confirmed, with the rationale explained before the query and a
  self-reported confidence score. This is the work an SI normally bills
  for, turned into a chat.

- **MCP server.** FlowMiner ships a Model Context Protocol server so
  Claude Desktop, Cursor, or Zed can query your instance as a tool. Your
  agent of choice becomes the query interface, against your data, on
  your terms.

Where Celonis answers "ask the platform" with "learn PQL and staff a
CoE," FlowMiner answers with auto-mapping, a chat grounded in your data,
and a copilot that writes the extraction SQL for you.

---

## 4. Disco-fast to start

Disco earned its following by being instant: open the app, drop in a
file, see a process map. The open-source server tools have historically
not been that — Apromore CE has meant standing up Java 8, MySQL 5.6, and
Kafka with the right versions in the right order, and ProM has its own
plugin and Gatekeeper friction before you see your first map.

FlowMiner aims for Disco's time-to-first-map with a server tool's
collaboration and persistence:

```bash
git clone https://github.com/<you>/flowminer.git
cd flowminer
make init-env
make up
```

`make up` brings up the full stack — FastAPI, Postgres, Redis, the
Celery worker, and the SPA — and waits until `/health/ready` reports
healthy, usually 30–90 seconds on a cold first build. Register the first
user (auto-promoted to admin), upload the bundled
`docs/examples/running-example.csv`, confirm the auto-detected mapping,
and you have an interactive process map. The whole stack is sized to run
on a 4GB VPS — no Kafka, no version-pinned database server to wrangle by
hand.

---

## 5. On-prem and sovereign by default

Celonis and Signavio are cloud-only by architecture. For a bank, a
hospital, a defence supplier, or any organisation under data-residency
rules, "cloud-only" is not a deployment preference — it is a structural
disqualification. These are buyers the incumbents cannot serve without
asking them to move regulated data off-premises.

FlowMiner runs entirely inside your own boundary. Postgres, Redis, the
worker, and the SPA all live on infrastructure you control; secrets are
encrypted at rest with a server-side Fernet key; and the only external
calls are the AI provider you choose to configure — which can be a local
Ollama model, so nothing leaves the host at all.

On privacy controls, FlowMiner is deliberately precise about what it
does and does not provide:

- **Pseudonymisation, not anonymisation.** FlowMiner can replace
  resource names, case IDs, and selected columns with deterministic
  pseudonyms. This is pseudonymisation: the mapping is consistent (the
  same input always yields the same token, so relationships survive),
  but because it is a deterministic hash it is *reversible* by anyone
  who can enumerate the candidate values. Do not treat it as
  irreversible anonymisation, and do not rely on it alone to satisfy a
  GDPR anonymisation standard.

- **Role-based access control.** Projects carry roles — admin, analyst,
  viewer — and the privacy configuration can independently gate whether
  analysts and viewers see raw (un-pseudonymised) data. RBAC, not the
  hash, is the real boundary against unauthorised re-identification.

- **Audit log.** Every mutation is recorded, so access to sensitive
  projects is traceable.

The honest framing is **pseudonymisation + RBAC + audit** — a sound
privacy posture for an on-prem deployment, stated for what it is rather
than oversold as anonymisation.

---

## 6. Object-centric process mining, open and MIT

Object-centric process mining is the capability Celonis is proudest of —
the move beyond a single case notion to processes where orders, items,
deliveries, and invoices interact. FlowMiner ships it open-source and
MIT:

- **OCEL 2.0** as a first-class format, both for ingestion and as the
  internal representation.
- **Object-centric directly-follows graphs and Petri nets**, object
  lifecycle views, and cross-object improvement reports.
- **State-aware OCPM** — a pre-processor implementing Kretzschmann,
  Berti & van der Aalst (EDOC 2025) that enriches an OCEL frame with
  synthetic object-state-transition events and per-event state
  annotations, unlocking lifecycle-driven analysis (inventory cycles,
  care pathways, order lifecycles) on logs that were never instrumented
  for it. The output stays backward-compatible with any OCEL 2.0 reader.

**OPerA performance overlays** — projecting timing and frequency
metrics (synchronization time, pooling time, lagging time, flow time)
onto the object-centric Petri net the way Celonis does — are **shipped**
via the optional `ocpa` package. The endpoint
`GET /api/v1/ocel/{id}/opera-performance` returns per-arc and
per-activity statistics using token-based replay with variable-arc
semantics; install `ocpa` alongside the backend to enable it. The
discovery, the lifecycle analysis, the state enrichment, and the
performance overlay are all here.

---

## Where FlowMiner is not the answer

To keep this credible, the cases where you should *not* pick FlowMiner:

- You need 150+ pre-built, vendor-maintained enterprise connectors with
  an SLA. FlowMiner has a solid connector set, but it is not Celonis's
  catalogue.
- You want a vendor to own the data model, the rollout, and the support
  contract end to end. That is the managed-service value proposition,
  and it is a real one — it is just not what an MIT, self-hosted tool
  provides.
- You need OPerA-grade performance overlays on object-centric models
  but cannot add the optional `ocpa` dependency — the overlay requires
  it and will not run without it.

For everyone else — teams who want real depth, want to keep their data,
and do not want a six-figure contract or a copyleft obligation — that is
exactly the gap FlowMiner is built for.

---

See the [README](../README.md) for the quick start, and
[`docs/roadmap/`](./roadmap/) for the planning notes behind the items
called out as roadmap above.
