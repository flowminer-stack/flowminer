# OCEL-native tools roadmap

Research notes on what true OCEL-native analyses exist in the literature
and in open source, separate from `phases.md` (the general AI roadmap).
The goal here is to identify tools we can add to the OCPM page and the
chat tool catalogue that use the object-centric structure *properly* —
not analyses that are equivalent to flattening per object type and
running a classical algorithm.

All items are sourced from academic papers and the `pm4py` / `ocpa`
libraries. Citations inline.

---

## The key library we should audit: `ocpa`

[ocpa](https://github.com/ocpm/ocpa) is the most feature-complete
open-source OCEL library. It ships algorithms that are missing from
`pm4py` but are well-documented in the PADS group's publications:

- **OPerA performance metrics** — `ocpa.algo.enhancement.token_replay_based_performance` (synchronization, pooling, lagging, flow time).
- **OC-fitness / OC-precision** — `ocpa.algo.conformance.precision_and_fitness.evaluator`.
- **Object-centric variant extraction** — `ocpa.visualization.log.variants`, `ocpa.algo.discovery.variants`.
- **Process-execution graph extraction** — the building block for variant analysis and execution drill-in.
- **ML feature extractors** — tabular / sequential / graph encodings for predictive monitoring.
- **Basic constraint monitoring** — `ocpa.algo.conformance.constraint_monitoring.algorithm`.

`ocpa` is pip-installable and written in Python. It depends on `pm4py`
internally so the runtime cost of adding it is low. The first action
on this roadmap is *"add ocpa to `requirements.txt` and verify the
basic import works against the existing improvement-report pipeline."*

## `pm4py` OCEL functions we don't currently use

From the `pm4py.*` surface (verified live inside the backend
container):

- `pm4py.ocel_o2o_enrichment` — enriches an OCEL 1.0 log with object-to-object relations derived from shared event participation. Worth running automatically on OCEL 1.0 logs so downstream analyses see O2O.
- `pm4py.cluster_equivalent_ocel` — clusters events that are "equivalent" (same activity, same object-type set composition). Useful for finding mis-tagged events and as a cheap anomaly signal.
- `pm4py.sample_ocel_connected_components` — extracts a full process execution subgraph for a specific object. The backbone for the execution drill-in view.
- `pm4py.filter_ocel_cc_object` — same operation with positive/negative filtering.
- `pm4py.filter_ocel_object_types_allowed_activities` — validates a rules dict like `{"Order": ["Place", "Approve", "Ship"]}` against the log, useful for constraint monitoring.
- `pm4py.filter_ocel_object_per_type_count` — filter events by how many objects of each type they involve ("events with exactly 3 items").
- `pm4py.filter_ocel_events_timestamp` — time-window slicing for digests / drift analysis.

None of these require new algorithms — they're one-line wrappers we
can surface as chat tools or as UI filters.

## Highest-value additions (ordered by effort → impact)

### 1. OPerA performance overlay on the OCPN

**Paper**: Park, Adams, van der Aalst (2022) — *OPerA: Object-Centric
Performance Analysis*, ICPM 2022, [arXiv 2204.10662](https://arxiv.org/abs/2204.10662).

**What it computes**: Given the OCPN we already discover, replays the
OCEL using token-based replay with variable-arc semantics and computes
per-arc / per-activity statistics for four metrics that are *definitionally
impossible* on flattened logs:

- **Synchronization time** — wait for all required object tokens at a shared transition
- **Pooling time** — wait for enough objects of the same type to accumulate in a place
- **Lagging time** — cross-type causal lag between related transitions
- **Flow time** — end-to-end time of one object through a portion of the net

Plus the classical waiting/service/sojourn times computed correctly
(without duplication from convergence).

**Why it matters**: these four metrics are the single strongest
differentiator between "real OCPM" and "flattened-per-type-with-a-logo".
Celonis's performance story doesn't expose these because their
analytics are flattening-based. Shipping this gives us a feature
Celonis genuinely does not have.

**Where it surfaces**: a new "OCPN performance overlay" panel on the
OCPM page, colour-coding arcs by synchronization/pooling/lagging time.
Also a new chat tool `show_sync_times` / `show_pooling_times` that
renders the per-arc breakdown as a bar chart.

**Effort**: `ocpa` implements the replayer — we pass it our existing
OCPN and call `.apply()`. Frontend: one new panel. **1-2 weeks.**

### 2. Object-centric variant explorer (graph-based, not sequences)

**Paper**: Adams, Schuster, Schmied, Schuh, van der Aalst (2022) —
*Defining Cases and Variants for Object-Centric Event Data*, ICPM 2022,
[arXiv 2208.03235](https://arxiv.org/abs/2208.03235).

**What it computes**: Partitions the OCEL into *process executions*
(subgraphs induced by a leading object and its recursively related
objects), then groups executions by graph isomorphism on their
activity-labelled DAGs. The output is a ranked list of variant graphs
(not sequences), each with frequency, case count, and optionally
timing annotations.

**Why it matters**: classical variants are sequences, so after
flattening, concurrent activities get serialised arbitrarily by
timestamp ties and the variant count is inflated. Two runs that are
structurally identical but different in timestamp order produce one
OC-variant but multiple classical variants. This is what
*"object-centric variant analysis"* genuinely means; Celonis labels
their flattening-plus-annotation-overlay feature the same way, and it
is not the same thing (see the anti-list below).

**Where it surfaces**: a new "Variants" tab on the OCPM page with a
DAG-based variant list. Each variant renders as a small graph. Chat
tool `show_variants(top_n)` returns the variant list and a mini
rendering of the top variant.

**Effort**: `ocpa.algo.discovery.variants` does the extraction and
isomorphism grouping. Frontend: a DAG renderer (we already use dagre
via cytoscape on other pages — reusable). **2 weeks.**

### 3. OC-DFG conformance overlay

**Paper**: Park, Adams, van der Aalst (2024) — *Conformance Checking
and Performance Analysis Using Object-Centric Directly-Follows Graphs*,
BPM 2024.

**What it computes**: Uses a *normative* OC-DFG (either a hand-drawn
reference, the discovery result on a golden subset, or a
threshold-filtered version of the full OC-DFG) and compares it against
the actual log. Produces per-arc deviation scores: which arcs in the
normative model are under-represented and which arcs in reality don't
exist in the normative model. Reports per-object-type counts.

**Why it matters**: it's the most *directly implementable* OCEL-native
conformance check because we already have OC-DFG discovery wired up.
The comparison is a dict diff over two OC-DFG structures — no Petri
net machinery needed.

**Where it surfaces**: on the existing OCPM Process View, add a toggle
"Conformance: compare to threshold-filtered DFG (≥N% frequency)". Arcs
go red if they're in the threshold DFG but underrepresented, green if
they fit, and blue if they're new relative to the threshold.

**Effort**: no new library needed — compare two OC-DFG dicts from
`pm4py.discover_ocdfg`. **1 week.**

### 4. Process execution drill-in

**Paper**: Adams et al. (2022) (same as variant paper above).

**What it computes**: given a selected object instance (e.g. Order
O-1234), extracts the full execution subgraph — all events involving
O-1234, all objects related to it via E2O and O2O, and all events
involving those related objects transitively up to a configurable
depth — and renders it as an interactive graph.

**Why it matters**: this is Celonis's and Microsoft Power Automate's
core "single instance" view. Currently FlowMiner can't answer
*"what happened for order O-1234 specifically?"* without the user
flattening manually.

**Where it surfaces**: a new "Execution" button in the OCPM page object
list. Clicking an object opens a slide-in panel with the execution
subgraph. Also chat tool `drill_into_object(object_id)` that returns a
compact tree summary.

**Effort**: `pm4py.sample_ocel_connected_components` already extracts
the connected component. The work is in the frontend graph renderer
(swimlane-by-object-type + event nodes on the correct lane). **1-2
weeks.**

### 5. TOTeM type-level cardinality model

**Paper**: Liss, Adams, van der Aalst (2024) — *TOTeM: Temporal Object
Type Model*, BPM 2024 Forum. [vdaalst.com/publications/p1475.pdf](https://www.vdaalst.com/publications/p1475.pdf).

**What it computes**: a schema-level graph whose nodes are object types
and whose edges are annotated with (1) temporal ordering ("does
Customer Order typically start before Shipment?"), (2) overall
cardinality ratio ("how many items per order on average?"), and
(3) event-level cardinality ("at events where both types appear, how
many of each?").

**Why it matters**: perfect for the *"tell me about this log before
I run discovery"* moment. Currently the OCPM page shows raw object
counts per type; TOTeM adds relationships. This is the kind of output
that looks great in a consultant slide deck and is also an honest
grounding tool.

**Where it surfaces**: a new "Type model" card at the top of the OCPM
Overview tab. Rendered as an annotated node-link diagram.

**Effort**: the algorithm is a handful of SQL-like aggregations on the
OCEL's E2O table — no library needed. One of the cheaper items on the
list. **3-4 days.**

### 6. Interleavings between object types

**Already in pm4py**: `pm4py.algo.discovery.ocel.interleavings` is
shipped but we don't surface it. It discovers timestamp-based
interleavings between two sets of process executions correlated via
shared objects — e.g. "how does the Purchase Order flow interleave
temporally with the Goods Receipt flow?"

**Where it surfaces**: a new "Interleavings" sub-tab on the OCPM
Analysis tab. User picks two object types; we render a DFG-like graph
where nodes are activities from either flow and edges show temporal
ordering at the event level.

**Effort**: wrap the pm4py function + add a small picker. **2 days.**
Cheapest win on this list.

---

## Medium-value additions

### 7. OCPN fitness / precision

**Paper**: Adams, van der Aalst (2021) — *Precision and Fitness in
Object-Centric Process Mining*, ICPM 2021.

`ocpa` implements this. Returns scalar fitness + precision plus
per-activity diagnostics. Surfaces as a small card in the OCPM Overview.
**Effort**: 2-3 days if `ocpa` is already installed.

### 8. Super variants

**Paper**: Adams, Hastrup-Kiil, Park, van der Aalst (2024) — *Super
Variants*, BPM 2024.

Clusters OC-variants into groups of structurally similar variants and
emits a small set of "super variant" graphs. Valuable for logs with
100+ variants because the Variant Explorer output is otherwise
unreadable. No public implementation — would have to reimplement from
the paper. **Medium effort.**

### 9. OC-DFG conformance with per-type deviation attribution

Extension of item 3 that reports which *object type* is responsible
for each deviation, not just the arc. Useful for finding
"the Container flow is the one misbehaving" vs "the Transport Document
flow is the one misbehaving". Implementable on top of item 3. **2
days incremental.**

### 10. OLAP granularity operations (drill-down / roll-up / fold / unfold)

**Paper**: [arXiv 2412.00393](https://arxiv.org/abs/2412.00393).

Lets the user reshape an OCEL at view time — e.g. split a generic
"Test" object type into "Test-ECG" and "Test-Blood" based on an
attribute, then re-run discovery at the finer granularity without
re-importing. Python implementation exists from the paper's authors.

**Effort**: 1 week to wire + UI for the four operations.

### 11. Object-centric anomaly detection (isolation forest variant)

**Paper**: Grigore, Tavares, Junior (2025) and the GCN-AE paper
[arXiv 2403.00775](https://arxiv.org/abs/2403.00775).

The lightweight variant: extract graph features per object (interaction
degree, cross-type co-occurrence patterns), run Isolation Forest, score
each execution. Flags executions that behave structurally unlike the
rest. Doesn't need a GNN. **1 week.**

### 12. OC constraint monitoring (basic)

`ocpa.algo.conformance.constraint_monitoring.algorithm` already
implements a basic form where the user defines constraint templates
as structured objects (not the full visual OCCM language from the
paper). Wrap as a chat tool `check_constraint(kind, activity_a,
activity_b)` — e.g. *"check that Register Customer Order always
precedes Create Transport Document"*. **3-4 days.**

---

## Low-priority / research frontier

These are valuable but paper-only or require heavy implementation:

- **OC-alignments** (Liss 2023) — no public impl
- **OC-DECLARE** (Küsters 2025) — no public impl
- **OCLPM** (Peeva 2024) — ProM plugin in Java, would need port
- **Concept drift on OCEL** (Adams 2023) — paper only
- **HOEG predictive monitoring** (2024) — GNN-based, paper + code
- **OC-causal nets** (Liss 2025) — niche formalism
- **Object-centric querying (OCPQ)** (2025) — competes with our existing filter chips, uncertain fit
- **State-aware OCPM** (Kretzschmann 2025) — would require us to add explicit state transitions to the OCEL, bigger data-model change
- **Process area extraction** (Liss 2026) — nice-to-have for resource clustering

---

## The anti-list — do NOT ship as "OCPM features"

These are analyses that look object-centric but are mathematically
identical to flattening per object type and running a classical
algorithm. Marketing these as OCPM is dishonest and gets caught the
moment a process-mining savvy user looks at them.

- **Per-object-type DFG discovery.** Flatten to a type, run classical
  DFG. The OC-DFG we already ship (via `pm4py.discover_ocdfg`) is the
  genuine version.

- **Variant analysis on a flattened "leading object type".** Classical
  variants on a flattened log. Not the same as graph-isomorphism-based
  OC variants. **This is what Celonis actually does in their Variant
  Explorer despite marketing it as OCPM.**

- **Per-object-type throughput time.** Case duration on each flattened
  log. Equivalent to classical case duration.

- **Activity frequency per object type.** Aggregation on the E2O
  table. Not an analysis, just a pivot.

- **Per-object-type social network / handover.** Classical org mining
  on flattened logs. *Cross-type* handover (resource X in the Order
  flow handed off to resource Y in the Invoice flow) is genuinely OC.

- **Classical conformance on a flattened OCEL.** Token replay or
  alignments on one leading object type. Fitness/precision values are
  distorted by convergence.

- **Single-object lifecycle view.** Case trace where the object ID is
  the case ID. OC-native only if you ALSO show the parallel timelines
  of the related objects (which makes it the execution drill-in —
  item 4 above).

- **Segmentation by time window.** Standard process cube slice. Not
  object-centric, just temporal.

- **Attribute distribution histograms.** Directly readable from OCEL
  attribute tables. Not an analysis.

Our current **per_object_type** section of the improvement report is
**close to** the anti-list because it runs standard insights on each
flattened perspective — but we rescue it by also computing
**cross_object_findings** which are cross-type leverage points that
are invisible after flattening. Keep both; the cross-object section
is what justifies calling it OCPM.

---

## Proposed sequencing

If we treat this as a Phase 7 in `phases.md`:

**Sprint 1 (1 week):**
- Item 6 (interleavings) — 2 days, cheapest win
- Item 5 (TOTeM) — 3-4 days

**Sprint 2 (2 weeks):**
- Item 1 (OPerA metrics) — flagship feature
- Add `ocpa` to the backend Dockerfile

**Sprint 3 (2-3 weeks):**
- Item 3 (OC-DFG conformance overlay) — 1 week
- Item 2 (object-centric variant explorer) — 2 weeks

**Sprint 4 (1-2 weeks):**
- Item 4 (process execution drill-in)
- Item 7 (OCPN fitness/precision)

Everything past sprint 4 is medium-to-low priority and can wait for
user signal.

---

## Sources

Primary references (papers cited above):
- OPerA metrics: [arXiv 2204.10662](https://arxiv.org/abs/2204.10662)
- OC-variant definitions: [arXiv 2208.03235](https://arxiv.org/abs/2208.03235)
- Super Variants: [BPM 2024 LNCS 14940](https://link.springer.com/chapter/10.1007/978-3-031-70396-6_7)
- TOTeM: [vdaalst.com/publications/p1475.pdf](https://www.vdaalst.com/publications/p1475.pdf)
- OC-DFG conformance: [BPM 2024 LNCS 14940](https://link.springer.com/chapter/10.1007/978-3-031-70418-5_11)
- OCPN fitness/precision: [ICPM 2021](https://icpmconference.org/2021/wp-content/uploads/sites/5/2021/09/Precision-and-Fitness-in-Object-Centric-Process-Mining.pdf)
- OC-alignments: [ER 2023 LNCS 14320](https://link.springer.com/chapter/10.1007/978-3-031-47262-6_11)
- OC-DECLARE: [BPM 2025 LNCS 16044](https://link.springer.com/chapter/10.1007/978-3-032-02867-9_11)
- OCLPM: [arXiv 2411.10468](https://arxiv.org/abs/2411.10468)
- OCEL 2.0 spec: [vdaalst.com/publications/p1435.pdf](https://www.vdaalst.com/publications/p1435.pdf)
- PADS survey: [Mathematics 2023](https://www.mdpi.com/2227-7390/11/12/2691)

Libraries:
- [ocpa on GitHub](https://github.com/ocpm/ocpa)
- [pm4py OCEL docs](https://pm4py-source.readthedocs.io/en/latest/pm4py.statistics.ocel.html)

Competitor pages (for anti-list context):
- [Celonis OCPM overview](https://docs.celonis.com/en/object-centric-process-mining-overview.html)
- [Microsoft Power Automate OCPM](https://learn.microsoft.com/en-us/power-automate/object-centric-overview)
- [QPR ProcessAnalyzer OCPM](https://wiki.onqpr.com/pa/index.php/Object-centric_Process_Mining_Model)
