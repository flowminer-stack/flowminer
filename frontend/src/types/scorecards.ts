// ─── Scorecards ────────────────────────────────────────────────────────────
// Mirrors backend app/api/scorecards.py (mounted at /api/v1/scorecards).
// Three orphaned endpoints surfaced here:
//   - POST   /cost-of-quality/{event_log_id}   → CostOfQualityResult
//   - GET    /export-workflow/{event_log_id}    → ExportWorkflowResult
//   - POST   /dp-benchmark                       → DpBenchmarkResult

// ── Cost of quality ─────────────────────────────────────────────────────────

/** Dollar assumptions fed into the cost-of-quality computation. */
export interface CostInputs {
  /** Fully-loaded cost per FTE-hour (drives bottleneck-queue cost). */
  fte_cost_per_hour: number;
  /** Cost incurred per case that had to be reworked. */
  cost_per_rework_case: number;
  /** Cost incurred per escalation event. */
  cost_per_escalation: number;
}

/** One line of the cost breakdown (Rework / Bottleneck queues / Escalations). */
export interface CostLineItem {
  label: string;
  /** Dollar value for this line. */
  value: number;
  /** Human detail, e.g. "42 cases" or "13.5 FTE hours". */
  detail: string;
}

export interface CostOfQualityResult {
  /** Total dollar cost of quality issues across all line items. */
  total: number;
  line_items: CostLineItem[];
  /** Echo of the inputs the server used. */
  inputs: CostInputs;
}

// ── Process-to-code export ──────────────────────────────────────────────────

/** Workflow engines the happy path can be emitted to. */
export type ExportTarget = 'temporal' | 'n8n' | 'airflow';

export interface ExportWorkflowResult {
  target: ExportTarget;
  /** The generated source (Python skeleton or n8n JSON). */
  code: string;
  /** Language hint for syntax/filename, e.g. "python" | "json". */
  language: string;
}

// ── Differential-privacy cross-team benchmark ───────────────────────────────

export interface DpBenchmarkRequest {
  event_log_ids: string[];
  /** Lower epsilon = more privacy, more noise. Must be > 0. */
  epsilon: number;
}

export interface DpBenchmarkResultItem {
  event_log_id: string;
  /** Average case duration (seconds) with calibrated Laplace noise applied. */
  dp_avg_case_duration_seconds: number;
  /** Case count with calibrated Laplace noise applied. */
  dp_case_count: number;
  epsilon_used: number;
  noise_scale_mean: number;
  noise_scale_count: number;
}

export interface DpBenchmarkResult {
  epsilon: number;
  /** Number of logs that returned a result (inaccessible logs are skipped). */
  count: number;
  results: DpBenchmarkResultItem[];
  note: string;
}
