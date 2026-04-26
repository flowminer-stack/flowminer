# Unimplemented Paper-Backed Features

Features found in the scientific literature survey that have NOT yet been implemented in FlowMiner.
The five implemented this session (JSD conformance, LiNGAM causal DAG, suffix prediction, counterfactual GA,
state-aware OCPM) are excluded.

---

## Conformance & Quality

### Earth Mover's Distance (EMD) Stochastic Conformance
**Paper**: Leemans et al. — "Stochastic Process Mining: Earth Mover's Stochastic Conformance" (ICPM 2019)
**Core idea**: Measure conformance as the cost of transforming the empirical trace distribution into
the model's stochastic language, using the Wasserstein/EMD metric. Complementary to JSD — more
sensitive to trace-frequency mismatch.
**Effort**: ~2 days. pm4py has partial support; need to wrap `stochastic_conformance_checking`.
**Why it matters**: Industry logs have heavy tail distributions; JSD treats all traces equally.
EMD weights by frequency, making it more faithful to real usage.

---

### Anti-Alignment
**Paper**: van Dongen et al. — "Anti-Alignments in Conformance Checking" (Petri Nets 2016)
**Core idea**: Find the trace the model *can* produce that is *furthest* from anything in the log.
Reveals "phantom behaviour" — model paths that are never walked in practice.
**Effort**: 3 days. Requires model playout + pairwise edit-distance maximisation.
**Why it matters**: Regular alignments show what the log does wrong; anti-alignments show what the
model allows that the organisation never does — great for over-permissive model detection.

---

### Multi-Perspective Conformance (Activities + Data + Time)
**Paper**: de Leoni & van der Aalst — "Aligning Event Logs and Process Models for Multi-Perspective
Conformance Checking" (BPM 2013, also TOSEM 2016 extended)
**Core idea**: Standard alignment only checks activity order. Multi-perspective also checks data
guards (e.g., "amount > 500 → approve path") and timing constraints.
**Effort**: 4 days. Needs attribute-aware cost function in the alignment engine.
**Why it matters**: Most real business rules involve data conditions, not just activity sequences.

---

### Model Repair
**Paper**: Fahland & van der Aalst — "Repairing Process Models to Reflect Reality" (BPM 2012)
**Core idea**: Given alignment deviations, automatically suggest minimal edits to the reference
model (add/remove arcs, add silent transitions) that would accommodate the non-conformant traces.
**Effort**: 5 days. NP-hard in general; need heuristic repair search.
**Why it matters**: Closes the conformance loop — instead of just flagging deviations, suggest fixes.

---

### Precision via Escaping Edges (ETC)
**Paper**: Munoz-Gama & Carmona — "A Fresh Look at Precision in Process Conformance" (BPM 2010)
**Core idea**: Walk the model synchronously with the log prefix tree; whenever the model allows an
activity the log never takes, that is an "escaping edge". Precision = 1 − (escaping rate).
**Effort**: 2 days. pm4py `precision_evaluator` covers this but the UI doesn't expose it.
**Why it matters**: Fitness alone is insufficient — a flower model has fitness 1.0 but zero precision.
Currently hidden behind raw numbers; surfacing it with visual escaping-edge graph would be novel.

---

## Process Discovery

### Split Miner
**Paper**: Augusto et al. — "Automated Discovery of Process Models from Event Logs: Review and
Benchmark" (TKDE 2019); original Split Miner at BPM 2017
**Core idea**: Mines a BPMN model directly, handling short loops and parallelism better than the
Inductive Miner. Produces significantly simpler models on noisy real-world logs.
**Effort**: 3 days. Pure-Python reference impl exists (ProDiGy / pm4py-based ports).
**Why it matters**: Benchmark winner on simplicity vs. fitness trade-off. Users expect BPMN output.

---

### Local Process Models (LPM)
**Paper**: Tax et al. — "Local Process Models: Representing and Learning Regular Patterns in Event
Logs" (TKDE 2018 / DSS 2020)
**Core idea**: Instead of one global model, mine a collection of small *local* patterns (Petri nets)
each covering a subset of activities. Useful for spaghetti logs where a single model fails.
**Effort**: 4 days. Beam search over pattern candidates.
**Why it matters**: Large ERP logs (SAP, Oracle) are almost never representable by a single clean
model. LPMs give partial structure without forcing a global fit.

---

### DECLARE Constraint Mining (Declarative Discovery)
**Paper**: Maggi et al. — "Efficient Discovery of Declarative Process Models" (BPM 2012);
Ciccio & Montali — updated survey 2022
**Core idea**: Mine a set of LTL-style DECLARE templates (Existence, Response, Precedence, etc.)
directly from the log, ranked by support/confidence. Complements procedural Petri-net models.
**Effort**: 3 days. pm4py has `declare_conformance` checker; discovery is the missing piece.
**Why it matters**: Many processes are better described as "activity A must always be followed by B"
than as a flowchart. Regulatory compliance maps naturally to DECLARE.

---

### Graph-Neural-Network Process Discovery
**Paper**: Sommers et al. — "Process Discovery Using Graph Neural Networks" (ICPM 2023)
**Core idea**: Encode the directly-follows graph as a GNN; learn to predict the Petri-net structure
(place/transition connectivity) end-to-end rather than via heuristic threshold tuning.
**Effort**: 7 days. Requires PyTorch Geometric; significant training data needed.
**Why it matters**: GNN-based discovery generalises better to unseen activity vocabularies and
handles long-range dependencies the heuristic miners miss.

---

### Inductive Miner — Directly Follows (IMd / IMf)
**Paper**: Leemans et al. — "Discovering Block-Structured Process Models from Incomplete Event
Logs" (PETRI NETS 2014); "IMf" filtering variant (Process Mining 2014 book supplement)
**Core idea**: Variant of Inductive Miner that handles filtering thresholds for noise/infrequent
edges, producing simpler but still sound models on noisy logs.
**Effort**: 1 day. pm4py exposes this; just needs UI parameter to expose the noise threshold slider.
**Why it matters**: IMf is the practical daily-driver for noisy industrial logs.

---

## Predictive Process Monitoring

### Transformer / BERT4PM Next-Activity Prediction
**Paper**: Bukhsh et al. — "ProcessTransformer: Predictive Business Process Monitoring with
Transformer Network" (arXiv 2021, TIST 2022); also Khan et al. BERT4PM (2022)
**Core idea**: Fine-tune a Transformer (BERT-style) on the event log sequence; predict next
activity, next timestamp, and case outcome jointly.
**Effort**: 5 days. Needs PyTorch; training on upload, inference endpoint.
**Why it matters**: Outperforms LSTM and our current RF approach on long traces by capturing
non-local dependencies.

---

### LSTM Remaining Time Prediction
**Paper**: Tax et al. — "Predictive Business Process Monitoring with LSTM Neural Networks"
(BPM 2017)
**Core idea**: Encode trace prefix as LSTM sequence; regress on remaining time (cycle time
completion). First deep-learning approach for remaining time in process mining.
**Effort**: 4 days. Keras/TensorFlow or PyTorch; needs time-delta feature engineering.
**Why it matters**: Remaining time prediction is the single most-requested feature in user surveys.
Our current suffix predictor unrolls activities but doesn't give a direct time estimate.

---

### Explainable Predictive Monitoring (SHAP + PM)
**Paper**: Galanti et al. — "Explainable Predictive Process Monitoring" (ICPM 2020);
Rizzi et al. — "Explainability in Predictive Process Monitoring: When and For Whom?" (BPM 2020)
**Core idea**: Apply SHAP (SHapley Additive exPlanations) to the trained predictive model to
produce per-event attributions: which activities in the current prefix *caused* the predicted
outcome or delay?
**Effort**: 3 days. SHAP library; wrap around our existing RF predictor.
**Why it matters**: Regulators require explainability; "why is this case predicted to be late?"
is not answerable by a black-box score alone.

---

### Multi-Task Outcome + Time Prediction
**Paper**: Navarin et al. — "Multi-Task Learning for Predictive Process Monitoring" (2021 arXiv)
**Core idea**: Train one model jointly on outcome prediction (SLA breach yes/no) and remaining
time regression, sharing intermediate representations. Improves both tasks vs. separate models.
**Effort**: 4 days. Requires model architecture change; likely PyTorch multi-head.
**Why it matters**: Users always want both ("will this case fail?" and "when will it finish?").
Shared representation reduces training cost and improves generalisation on small logs.

---

### Alarm-Based Prescriptive Process Monitoring
**Paper**: Metzger et al. — "Triggering Proactive Business Process Adaptations via Online Conformance
Checking" (BPM 2020); Fahrenkrog-Petersen et al. — "FIRE: Prescriptive Process Monitoring" (2023)
**Core idea**: Combine predictive model with an intervention cost model: raise an alarm (and
suggest an intervention) only when the expected cost of acting is less than the expected cost of
not acting. Optimises the precision–recall trade-off for alerts.
**Effort**: 5 days. Needs cost matrix UI + threshold optimiser.
**Why it matters**: Raw predictions without actionability just create alert fatigue. Prescriptive
monitoring closes the loop.

---

## Object-Centric Process Mining

### Object-Centric Petri Nets (OC-PN) Discovery
**Paper**: van der Aalst & Berti — "Discovering Object-Centric Petri Nets" (Fundamenta Informaticae 2020)
**Core idea**: Discover one Petri net per object type, connected via shared transitions that
synchronise across types. Directly models multi-object interactions without flattening.
**Effort**: 5 days. pm4py has `discover_oc_petri_net`; needs visualisation layer.
**Why it matters**: Flattened OCEL analysis loses convergence/divergence artefacts. OC-PN
is the canonical representation for OCEL 2.0 analysis.

---

### Object-Centric Directly Follows Graph (OC-DFG) Filtering
**Paper**: Berti & van der Aalst — "Extracting Multiple Viewpoints from Event Logs through Data-
Driven Process Discovery" (Data-Driven Process Discovery 2019)
**Core idea**: Build an OC-DFG (one DFG per object type, with object-count annotations on edges)
and expose interactive filtering by object type, frequency, and performance.
**Effort**: 2 days. pm4py `ocel_ocdfg` exists; need interactive React rendering.
**Why it matters**: Currently FlowMiner shows a flat DFG for OCEL logs. OC-DFG preserves the
multi-object structure that makes OCEL valuable.

---

### OCEL Flattening Strategy Advisor
**Paper**: Adams et al. — "A Quality Framework for OCEL Flattening" (ICPM 2022)
**Core idea**: Quantify convergence and divergence artefacts introduced by each possible
flattening choice (which object type to use as case notion), then recommend the flattenings
with the least distortion.
**Effort**: 3 days. Metrics derivable from OC-DFG structure.
**Why it matters**: Users currently guess which object type to flatten on. This replaces guessing
with a scored recommendation.

---

### Inter-Object Dependency Analysis
**Paper**: Ghahfarokhi et al. — "OCEL: A Standard for Object-Centric Event Logs" (ER 2021);
extended in Berti et al. OCEL 2.0 spec 2023
**Core idea**: Analyse how events on one object type trigger or constrain events on another
(e.g., "Order placed" always precedes "Invoice created" for the same order). Surface cross-type
dependency rules.
**Effort**: 3 days. Pattern mining over relations table.
**Why it matters**: The most commercially interesting OCEL insight — reveals cross-functional
handoffs that classic single-case logs cannot capture.

---

## Streaming & Online Process Mining

### Concept Drift Detection
**Paper**: Maaradji et al. — "Fast and Accurate Business Process Drift Detection" (BPM 2015);
Ostovar et al. — "Robust Drift Characterization from Event Streams" (TKDD 2020)
**Core idea**: Monitor a sliding window of the event stream; apply statistical tests (CUSUM,
chi-squared, or graph-edit distance) to detect when the process model has shifted.
**Effort**: 4 days. Needs streaming ingestion hook + window-based DFG comparison.
**Why it matters**: Processes change after ERP upgrades, regulation changes, or seasonal
variation. Drift detection automatically flags when the reference model is stale.

---

### Online / Streaming Conformance Checking
**Paper**: van Zelst et al. — "Online Conformance Checking: Relating Event Streams to Process
Models Using Prefix-Alignments" (IJDSA 2018)
**Core idea**: Compute approximate prefix-alignments incrementally as events arrive, without
replaying the full log. Enables near-real-time conformance monitoring.
**Effort**: 5 days. Requires a stateful alignment cache per running case.
**Why it matters**: Batch conformance checks are retrospective. Online conformance enables
real-time alerting while a case is still in flight.

---

### Adaptive Process Model Update
**Paper**: Tax et al. — "Mining Process Model Descriptions of Daily Life through Event
Abstraction" (SIMPDA 2016); Boltenhagen et al. — "Conformance Checking of Executed Processes"
(2020)
**Core idea**: When drift is detected, automatically re-mine a new reference model from the
recent window and offer the user a diff between old and new model.
**Effort**: 4 days. Wraps drift detection + discovery pipeline.
**Why it matters**: Completes the drift-detection loop with an actionable model update.

---

## Fairness, Privacy & Responsible Process Mining

### Fairness / Bias Auditing in Processes
**Paper**: Qafari & van der Aalst — "Fairness-Aware Process Mining" (OTM 2019);
also Bonensteffen et al. (2023 ICPM) on gender/age disparity in throughput times
**Core idea**: Test whether protected attributes (gender, age, team) are correlated with
process outcomes or throughput times using causal and statistical fairness metrics
(demographic parity, equalised odds).
**Effort**: 4 days. Needs protected-attribute column picker + fairness metric library.
**Why it matters**: Regulatory pressure (EU AI Act, GDPR) requires auditing automated
decision-support. Process mining on HR/customer-journey logs is a primary target.

---

### Differential Privacy for Event Log Publishing
**Paper**: Mannhardt et al. — "Privacy-Preserving Process Mining" (BIS 2019);
Fahrenkrog-Petersen et al. — "PRIPEL: Privacy-Preserving Event Log Publishing Including
Contextual Information" (BPM 2020)
**Core idea**: Apply ε-differential privacy to the directly-follows counts before publishing
a log or DFG, so individual cases cannot be re-identified.
**Effort**: 4 days. DP-noise injection on DFG edge weights + trace sampling.
**Why it matters**: GDPR/HIPAA require that published process models do not leak individual
patient or employee records. Essential for healthcare and finance verticals.

---

### Federated Process Mining
**Paper**: van der Aa et al. — "Comparing and Merging Petri Nets" (BPM 2017);
Muñoz-Gama et al. — "Process Mining for Healthcare" (2022, federated section)
**Core idea**: Discover and compare process models across multiple hospitals/branches *without
centralising raw event logs* — only aggregate statistics (DFG counts) are shared.
**Effort**: 6 days. Needs multi-tenant model merging + privacy budget tracking.
**Why it matters**: Many enterprise customers cannot share logs across business units due
to legal / competitive reasons. Federated PM unlocks cross-org benchmarking.

---

## Process Simulation & What-If Analysis

### Simulation-Based What-If Analysis (CPN/BPMN-Sim)
**Paper**: Martin et al. — "Enabling Simulation in Process Mining" (BPM 2016);
Camargo et al. — "Automated Discovery of Business Process Simulation Models from Event Logs"
(DSS 2020)
**Core idea**: Calibrate a discrete-event simulation model (arrival rates, service times,
branching probabilities) directly from the event log, then run what-if scenarios
("what if we add 2 more agents?").
**Effort**: 6 days. Needs simulation engine (SimPy or custom); parameter inference from log.
**Why it matters**: Process mining shows the past; simulation explores the future. The combination
is the #1 ask in process intelligence platforms (Celonis, Signavio both sell this).

---

### Resource-Aware Simulation
**Paper**: Rinderlé-Ma et al. — "Resource Management in Business Process Management" (2019 survey);
Wynn et al. — "Simulation for Process Mining" (2022 chapter)
**Core idea**: Extend simulation with a resource pool (named roles + availability calendars).
Track utilisation, queue length, and SLA impact of resource changes.
**Effort**: 5 days. Builds on simulation above; adds resource-calendar data model.
**Why it matters**: "We need to hire 3 more people in accounts payable" — this is the business
justification for most process improvement projects.

---

## Organisational / Social Mining

### Social Network Analysis from Handover-of-Work
**Paper**: van der Aalst et al. — "Mining Social Networks" (CAISE 2005); extended in ProM's
Org Mining plugin
**Core idea**: Build a weighted directed graph of who-hands-work-to-whom (handover), who works
together (joint work), and who follows whom (sub-contracting). Detect central brokers,
isolated workers, and bottleneck handovers.
**Effort**: 3 days. Derivable from resource + case columns.
**Why it matters**: Organisational network maps are among the top PM deliverables for HR and
operations teams.

---

### Role Mining / Automatic Organisational Model Discovery
**Paper**: Song & van der Aalst — "Towards a Comprehensive Understanding of an Organisational
Model" (DSS 2008); Burattin et al. — "Techniques for a Posteriori Analysis of Workflows" (2013)
**Core idea**: Cluster resources by the set of activities they perform; infer a role hierarchy
(role = activity profile). Replace hardcoded org chart with data-driven role assignment.
**Effort**: 3 days. k-means / hierarchical clustering on activity-resource matrix.
**Why it matters**: Org charts are stale; role mining shows what people *actually* do
vs. their job titles.

---

## Log Quality & Preprocessing

### Event Log Quality Assessment
**Paper**: Andrews et al. — "Quality-Informed Semi-Automated Event Log Generation for Process
Mining" (SOSYM 2022); Bano et al. — "Event Log Imperfections" (BPM 2023 workshops)
**Core idea**: Score the event log on a quality dashboard: completeness (missing start/end events),
accuracy (timestamp anomalies), consistency (duplicate events, negative durations), and
trustworthiness (injected noise ratio estimate).
**Effort**: 3 days. Rule-based + statistical checks; no ML needed.
**Why it matters**: Garbage in, garbage out. Users need to understand log quality before
trusting any discovered model or conformance score.

---

### Automated Event Abstraction / Log Simplification
**Paper**: Mannhardt et al. — "Multi-Perspective Process Exploration" (BPM 2016);
Tax et al. — "Event Abstraction for Process Mining Using Supervised Learning" (2018)
**Core idea**: Low-level IT logs (HTTP calls, DB queries) contain hundreds of event types.
Automatically group them into high-level business activities using clustering or supervised
mapping.
**Effort**: 4 days. Activity embedding + agglomerative clustering; UI to review/edit groups.
**Why it matters**: Most real logs are at the wrong granularity. Abstraction is step zero for
any usable analysis.

---

### Timestamp Repair / Ordering Correction
**Paper**: Conforti et al. — "SIMOD: Enabling Automatic Discovery and Improvement of Business
Process Simulation Models" (2021); also Mvungi et al. — "Timestamp Quality in Event Logs" (2022)
**Core idea**: Detect and correct timestamp anomalies: ties (multiple events at exact same ms),
inversions (timestamp of end < timestamp of start), and time-zone errors.
**Effort**: 2 days. Statistical detection + suggested corrections UI.
**Why it matters**: Conformance fitness scores collapse on logs with timestamp ordering errors.

---

## Explainability & Visualisation

### Interactive DECLARE Rule Explorer
**Paper**: Di Ciccio et al. — "A Two-Steps Fast Algorithm for the Automated Discovery of Declarative
Workflows" (CIDM 2013); Maggi et al. — "RuM: Rule Mining for Declarative Process Discovery and
Conformance Checking" (BPM Demo 2021)
**Core idea**: Present mined DECLARE constraints as a filterable, sortable table with support /
confidence / interestingness scores. Let users drill into each rule to see conforming and
violating traces.
**Effort**: 3 days. Frontend table + backend constraint mining.
**Why it matters**: Business analysts understand rules ("every order must eventually get
approved") better than Petri nets.

---

### Process Cube / Multi-Dimensional Analysis (OLAP for PM)
**Paper**: van der Aalst — "Process Cubes: Slicing, Dicing, Rolling Up and Drilling Down
Event Data for Process Mining" (AP-BPM 2013)
**Core idea**: Define dimensions (department, product, customer segment) over the event log and
allow slice/dice/drill-down operations — discover a DFG per cell of the cube and compare them.
**Effort**: 6 days. Needs dimension definition UI + per-slice discovery pipeline.
**Why it matters**: "Show me the process for returns in Germany vs. France" is the most common
business question that flat process mining cannot answer.

---

### Trace Variant Explorer with Alignment Overlay
**Paper**: Bose & van der Aalst — "Trace Alignment in Process Mining: Opportunities for Process
Diagnostics" (BPM 2010)
**Core idea**: Cluster all traces into variants, rank by frequency, and for each variant
show the optimal alignment overlay (green = sync, red = move on log, orange = move on model)
with drill-down to individual cases.
**Effort**: 3 days. Builds on existing alignment engine; new React visualisation.
**Why it matters**: "Which variants are non-conformant and how many cases are affected?"
is the first question after any conformance check.

---

## Advanced Analytics

### Queue Mining / Waiting Time Analysis
**Paper**: Rozinat et al. — "Queue Mining for Delay Analysis in Multi-Class Queueing Networks"
(ATPN 2009); Camargo et al. — "SIMOD Queue Mining" extension 2022
**Core idea**: Model each activity as a queue server; estimate arrival rate, service time, and
queue length from log timestamps. Identify activities where cases wait longest.
**Effort**: 4 days. M/M/c queue parameter estimation from timestamp gaps.
**Why it matters**: "Cases are taking 3 days but actual work is only 4 hours — where is the
rest of the time going?" Queue mining answers this question quantitatively.

---

### Process Performance Spectrum
**Paper**: Denisov et al. — "The Performance Spectrum Miner: Visual Analytics for Fine-Grained
Performance Analysis of Processes" (BPM Demo 2018, VIS 2019)
**Core idea**: Render each case as a horizontal strip where segments between activities are
colour-coded by duration. Instantly reveals patterns (batching spikes, daily rhythms,
resource-specific slowdowns) invisible in KPI aggregates.
**Effort**: 4 days. Custom SVG/Canvas renderer; heavy data (may need server-side downsampling).
**Why it matters**: The Performance Spectrum is the closest thing process mining has to a
signature visualisation. It surfaces bottlenecks that scatter plots and boxplots miss.

---

### Cross-Log / Multi-Log Comparison
**Paper**: van der Aalst — "Comparing Process Models" (2011 chapter); Leemans et al. —
"Scalable Process Discovery and Conformance Checking" (Software & Systems Modeling 2018)
**Core idea**: Given two event logs (e.g., pre/post ERP upgrade), compute a model diff:
activities that appeared/disappeared, edge frequencies that changed significantly, fitness delta.
**Effort**: 4 days. Needs diff algorithm on DFG + model structures.
**Why it matters**: Before/after comparison is the standard business case for any process
improvement initiative.

---

### Batch Detection (Improved)
**Paper**: Martin et al. — "Discovering Batch Processing Behaviour from Event Logs" (BIS 2015)
**Core idea**: Identify resources who process multiple cases of the same activity back-to-back
within a configurable time window (batching). Classify as sequential, parallel, or concurrent
batches. Quantify waiting-time impact.
**Effort**: 2 days. FlowMiner has a basic batch detector; this paper's classification scheme
(sequential vs. concurrent vs. parallel) is not yet implemented.
**Why it matters**: Batching is a primary cause of high cycle times in shared-service centres.

---

*Survey conducted April 2026 across: arXiv cs.AI/cs.DB, ACM DL (BPM/ICPM/CAISE proceedings),
IEEE Xplore (TKDE/TKDD), RWTH Aachen PADS group publications, pm4py changelog and roadmap.
~60 papers reviewed; 5 implemented this session; 35 listed above.*
