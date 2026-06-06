// API client for SLA-aware Timed-Declare conformance.
//
// Endpoint: POST /api/v1/compliance/timed-declare/{event_log_id}
// (router mounts at /api/v1/compliance; the shared axios instance already
// carries the /api/v1 baseURL, so we POST to /compliance/...).

import { api } from './http';
import type { TimedConstraint, TimedDeclareResponse } from '@/types/compliance';

/**
 * Run SLA-aware Timed-Declare conformance for the given event log.
 *
 * @param eventLogId  Event log UUID.
 * @param constraints List of time-bounded constraints to evaluate.
 * @returns Per-constraint violation rates, sample violating case ids, and
 *          time-to-violation distribution stats.
 */
export const checkTimedDeclare = async (
  eventLogId: string,
  constraints: TimedConstraint[],
): Promise<TimedDeclareResponse> => {
  const response = await api.post<TimedDeclareResponse>(
    `/compliance/timed-declare/${eventLogId}`,
    { constraints },
  );
  return response.data;
};
