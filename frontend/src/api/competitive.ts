import api from './http';
import type {
  WhatIfBottleneckResponse,
  AutomationCandidatesResponse,
  VariantEvolutionResponse,
  AttributeHistogramResponse,
  ActivityTreemapResponse,
  CaseGanttResponse,
  CohortSignificanceResponse,
  ComplianceMatrixResponse,
  InterAppGraphResponse,
  AppTeamHeatmapResponse,
} from '@/types';

// Re-export the competitive-parity domain types so the historical
// '@/api/client' surface (which exposed these alongside the `competitive`
// resource) keeps resolving unchanged.
export type {
  WhatIfBottleneckResponse,
  AutomationCandidate,
  AutomationCandidatesResponse,
  VariantEvolutionResponse,
  AttributeHistogramResponse,
  ActivityTreemapResponse,
  CaseGanttResponse,
  CohortSignificanceResponse,
  ComplianceMatrixResponse,
  InterAppGraphResponse,
  AppTeamHeatmapResponse,
} from '@/types';

// ─── Competitive-parity endpoints ───────────────────────────────────────

export const competitive = {
  whatIfBottleneck: async (
    eventLogId: string,
    activity: string,
    speedupPct: number,
  ): Promise<WhatIfBottleneckResponse> =>
    (
      await api.post('/competitive/whatif-bottleneck', {
        event_log_id: eventLogId,
        activity,
        speedup_pct: speedupPct,
      })
    ).data,

  automationCandidates: async (
    eventLogId: string,
    hourlyCost = 50,
    automationRate = 0.7,
  ): Promise<AutomationCandidatesResponse> =>
    (
      await api.get(
        `/competitive/automation-candidates/${eventLogId}?hourly_cost=${hourlyCost}&automation_rate=${automationRate}`,
      )
    ).data,

  variantEvolution: async (
    eventLogId: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' = 'month',
  ): Promise<VariantEvolutionResponse> =>
    (await api.get(`/competitive/variant-evolution/${eventLogId}?granularity=${granularity}`)).data,

  attributeHistogram: async (
    eventLogId: string,
    attribute: string,
    bins = 15,
  ): Promise<AttributeHistogramResponse> =>
    (
      await api.get(
        `/competitive/attribute-histogram/${eventLogId}?attribute=${encodeURIComponent(attribute)}&bins=${bins}`,
      )
    ).data,

  activityTreemap: async (
    eventLogId: string,
    activity: string,
    splitBy = 'org:resource',
  ): Promise<ActivityTreemapResponse> =>
    (
      await api.get(
        `/competitive/activity-treemap/${eventLogId}?activity=${encodeURIComponent(activity)}&split_by=${encodeURIComponent(splitBy)}`,
      )
    ).data,

  caseGantt: async (eventLogId: string, limit = 30): Promise<CaseGanttResponse> =>
    (await api.get(`/competitive/case-gantt/${eventLogId}?limit=${limit}`)).data,

  cohortSignificance: async (
    eventLogId: string,
    cohortA: string[],
    cohortB: string[],
  ): Promise<CohortSignificanceResponse> =>
    (
      await api.post('/competitive/cohort-significance', {
        event_log_id: eventLogId,
        cohort_a_cases: cohortA,
        cohort_b_cases: cohortB,
      })
    ).data,

  complianceMatrix: async (
    eventLogId: string,
    segmentBy: string,
  ): Promise<ComplianceMatrixResponse> =>
    (
      await api.get(
        `/competitive/compliance-matrix/${eventLogId}?segment_by=${encodeURIComponent(segmentBy)}`,
      )
    ).data,

  interAppGraph: async (
    eventLogId: string,
    appColumn = 'application',
  ): Promise<InterAppGraphResponse> =>
    (
      await api.get(
        `/competitive/inter-app-graph/${eventLogId}?app_column=${encodeURIComponent(appColumn)}`,
      )
    ).data,

  appTeamHeatmap: async (
    eventLogId: string,
    appColumn = 'application',
    teamColumn = 'org:resource',
  ): Promise<AppTeamHeatmapResponse> =>
    (
      await api.get(
        `/competitive/app-team-heatmap/${eventLogId}?app_column=${encodeURIComponent(appColumn)}&team_column=${encodeURIComponent(teamColumn)}`,
      )
    ).data,
};
