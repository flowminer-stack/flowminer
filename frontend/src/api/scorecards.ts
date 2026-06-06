// Scorecards API — thin wrapper around the orphaned backend endpoints in
// app/api/scorecards.py (mounted at /api/v1/scorecards).
// Import the shared Axios instance from './http' (NOT from '@/api/client',
// which is the hub barrel and not owned by this bundle).

import api from './http';
import type {
  CostInputs,
  CostOfQualityResult,
  ExportTarget,
  ExportWorkflowResult,
  DpBenchmarkRequest,
  DpBenchmarkResult,
} from '@/types/scorecards';

/**
 * Compute the dollar cost of quality issues (rework + bottleneck queues +
 * escalations) for one event log.
 *
 * @param eventLogId  UUID of the event log.
 * @param body        Optional dollar assumptions. The server applies its own
 *                    defaults (fte_cost_per_hour=50, cost_per_rework_case=25,
 *                    cost_per_escalation=100) for any field omitted — so an
 *                    empty body returns the default scenario.
 */
export async function costOfQuality(
  eventLogId: string,
  body?: Partial<CostInputs>,
): Promise<CostOfQualityResult> {
  const response = await api.post<CostOfQualityResult>(
    `/scorecards/cost-of-quality/${eventLogId}`,
    body ?? {},
  );
  return response.data;
}

/**
 * Emit the happy-path variant of an event log as runnable workflow code.
 *
 * @param eventLogId  UUID of the event log.
 * @param target      One of 'temporal' | 'n8n' | 'airflow'.
 */
export async function exportWorkflow(
  eventLogId: string,
  target: ExportTarget,
): Promise<ExportWorkflowResult> {
  const response = await api.get<ExportWorkflowResult>(
    `/scorecards/export-workflow/${eventLogId}`,
    { params: { target } },
  );
  return response.data;
}

/**
 * Run a cross-team benchmark over several event logs with differential-privacy
 * (Laplace) noise calibrated to the epsilon budget.
 *
 * @param body  event_log_ids (≥1) and epsilon (> 0).
 */
export async function dpBenchmark(
  body: DpBenchmarkRequest,
): Promise<DpBenchmarkResult> {
  const response = await api.post<DpBenchmarkResult>(
    `/scorecards/dp-benchmark`,
    body,
  );
  return response.data;
}

export const scorecards = { costOfQuality, exportWorkflow, dpBenchmark };
