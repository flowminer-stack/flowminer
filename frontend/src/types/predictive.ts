// ─── Predictive (Close-the-Loop) Types ──────────────────────────────────────
// Mirrors the backend contract mounted at /api/v1/mining/predict/*.

/** A single predicted-next-activity suggestion for an open case. */
export interface NextActivityPrediction {
  activity: string;
  probability: number;
}

/** One open case flagged as at risk of breaching its SLA. */
export interface CaseAtRisk {
  case_id: string;
  prefix_length: number;
  last_activity: string;
  elapsed_seconds: number;
  breach_probability: number;
  risk_label: string;
  predicted_remaining_seconds?: number | null;
  predicted_total_seconds?: number | null;
  predicted_finish_over_sla?: boolean | null;
  top_next_activities: NextActivityPrediction[];
}

/** Response for GET /predict/cases-at-risk/{event_log_id}. */
export interface CasesAtRiskResponse {
  event_log_id: string;
  sla_hours: number;
  sla_seconds: number;
  risk_threshold: number;
  count: number;
  cases_at_risk: CaseAtRisk[];
}

/** A single SHAP-style feature contribution toward the predicted outcome. */
export interface FeatureContribution {
  feature: string;
  value: number | string | boolean | null;
  contribution: number;
}

/** Response for GET /predict/explain/{event_log_id}/{case_id}. */
export interface ExplainResponse {
  available: boolean;
  reason?: string;
  case_id?: string;
  kind?: string;
  prefix_length?: number;
  current_activity?: string;
  top_contributions: FeatureContribution[];
  model_info?: Record<string, unknown>;
}

/** Per-kind model metrics — shape varies by model kind, kept open. */
export interface ModelMetrics {
  auc?: number;
  mae?: number;
  accuracy?: number;
  f1?: number;
  rmse?: number;
  [key: string]: number | undefined;
}

/** Health/metadata for one trained predictive model. */
export interface ModelHealthEntry {
  kind: string;
  trained: boolean;
  trained_at?: string | null;
  n_cases?: number | null;
  metrics: ModelMetrics;
  content_hash?: string | null;
  serializer?: string | null;
}

/** Response for GET /predict/model-health/{event_log_id}. */
export interface ModelHealthResponse {
  event_log_id: string;
  models: ModelHealthEntry[];
}

// ─── Request option shapes ───────────────────────────────────────────────────

export interface CasesAtRiskParams {
  slaHours: number;
  riskThreshold?: number;
}

export interface ExplainParams {
  kind?: string;
  topN?: number;
  slaThreshold?: number;
}
