import api from './http';
import type {
  CasesAtRiskResponse,
  ExplainResponse,
  ModelHealthResponse,
  CasesAtRiskParams,
  ExplainParams,
} from '@/types/predictive';

// ─── Predictive (Close-the-Loop) API ─────────────────────────────────────────
// Wraps the backend endpoints mounted at /api/v1/mining/predict/*.

export const predictive = {
  /**
   * Open cases at risk of breaching the given SLA, sorted server-side by
   * breach probability. `slaHours` is required; `riskThreshold` defaults to
   * the backend value (0.7) when omitted.
   */
  getCasesAtRisk: async (
    eventLogId: string,
    { slaHours, riskThreshold }: CasesAtRiskParams,
  ): Promise<CasesAtRiskResponse> => {
    const response = await api.get<CasesAtRiskResponse>(
      `/mining/predict/cases-at-risk/${eventLogId}`,
      {
        params: {
          sla_hours: slaHours,
          ...(riskThreshold !== undefined ? { risk_threshold: riskThreshold } : {}),
        },
      },
    );
    return response.data;
  },

  /**
   * SHAP-style explanation for a single case's prediction. Always check
   * `available` on the response before rendering contributions.
   */
  explainCase: async (
    eventLogId: string,
    caseId: string,
    { kind = 'outcome', topN, slaThreshold }: ExplainParams = {},
  ): Promise<ExplainResponse> => {
    const response = await api.get<ExplainResponse>(
      `/mining/predict/explain/${eventLogId}/${encodeURIComponent(caseId)}`,
      {
        params: {
          kind,
          ...(topN !== undefined ? { top_n: topN } : {}),
          ...(slaThreshold !== undefined ? { sla_threshold: slaThreshold } : {}),
        },
      },
    );
    return response.data;
  },

  /** Training status + metrics for each predictive model on this log. */
  getModelHealth: async (eventLogId: string): Promise<ModelHealthResponse> => {
    const response = await api.get<ModelHealthResponse>(
      `/mining/predict/model-health/${eventLogId}`,
    );
    return response.data;
  },
};

export default predictive;
