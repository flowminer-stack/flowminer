// Stochastic conformance API — thin wrapper around the existing backend
// endpoint GET /mining/conformance/{event_log_id}/stochastic.
// Do NOT import from '@/api/mining' (hub file, not owned by this bundle).
// Import the shared Axios instance from './http' instead.

import api from './http';
import type { StochasticConformanceResult } from '@/types/stochastic';

/**
 * Fetch EMD-based stochastic conformance for an event log.
 *
 * @param eventLogId  UUID of the event log.
 * @param referenceModel  Optional serialized Petri net (JSON string).
 *                        When omitted the server discovers a model via
 *                        the Inductive Miner.
 */
export async function getStochasticConformance(
  eventLogId: string,
  referenceModel?: string,
): Promise<StochasticConformanceResult> {
  const params: Record<string, string> = {};
  if (referenceModel) {
    params.reference_model = referenceModel;
  }
  const response = await api.get<StochasticConformanceResult>(
    `/mining/conformance/${eventLogId}/stochastic`,
    { params },
  );
  return response.data;
}

export const stochasticConformance = { getStochasticConformance };
