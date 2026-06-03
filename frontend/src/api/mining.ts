import api from './http';
import type {
  DiscoveryRequest,
  DiscoveryResponse,
  VariantResponse,
  BottleneckResponse,
  ConformanceResponse,
  RootCauseResponse,
  ProcessStatistics,
  ProcessSummary,
  CaseListResponse,
  CaseDetailResponse,
  TimelineResponse,
  EdgeStatsResponse,
  OverviewResponse,
  DottedChartResponse,
  SocialNetworkResponse,
  ComparisonResponse,
  ReworkResponse,
  ActivityDetailResponse,
  SimulationModification,
  SimulationResponse,
  DataQualityResponse,
  InsightsResponse,
  FilterOptions,
  DriftResponse,
  QueueMiningResponse,
  DESParameters,
  DESScenario,
  DESSimulationResult,
} from '@/types';

// ─── Mining ──────────────────────────────────────────────────────────────────

export const mining = {
  discover: async (data: DiscoveryRequest): Promise<DiscoveryResponse> => {
    const response = await api.post<DiscoveryResponse>(
      '/mining/discover',
      data,
    );
    return response.data;
  },

  getFilterOptions: async (eventLogId: string): Promise<FilterOptions> => {
    const response = await api.get<FilterOptions>(`/mining/filter-options/${eventLogId}`);
    return response.data;
  },

  exportCsv: async (eventLogId: string, analysis: string): Promise<void> => {
    const response = await api.get(`/mining/export/${eventLogId}/csv`, {
      params: { analysis },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analysis}_${eventLogId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  exportExcel: async (eventLogId: string, analysis: string): Promise<void> => {
    const response = await api.get(`/mining/export/${eventLogId}/excel`, {
      params: { analysis },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analysis}_${eventLogId}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  },

  getVariants: async (eventLogId: string): Promise<VariantResponse> => {
    const response = await api.get<VariantResponse>(
      `/mining/variants/${eventLogId}`,
    );
    return response.data;
  },

  getBottlenecks: async (eventLogId: string): Promise<BottleneckResponse> => {
    const response = await api.get<BottleneckResponse>(
      `/mining/bottlenecks/${eventLogId}`,
    );
    return response.data;
  },

  getQueueAnalysis: async (eventLogId: string): Promise<QueueMiningResponse> => {
    const response = await api.get<QueueMiningResponse>(
      `/mining/queue-mining/${eventLogId}`,
    );
    return response.data;
  },

  getConformance: async (
    eventLogId: string,
    templateId?: string,
  ): Promise<ConformanceResponse> => {
    const params = templateId ? `?template_id=${templateId}` : '';
    const response = await api.get<ConformanceResponse>(
      `/mining/conformance/${eventLogId}${params}`,
    );
    return response.data;
  },

  downloadConformancePdf: async (
    eventLogId: string,
    method: 'token_replay' | 'alignment' | 'footprints' = 'alignment',
  ): Promise<void> => {
    const response = await api.get(`/mining/conformance/${eventLogId}/pdf`, {
      params: { method },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conformance_${eventLogId}_${method}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  },

  getRootCause: async (eventLogId: string): Promise<RootCauseResponse> => {
    const response = await api.get<RootCauseResponse>(
      `/mining/root-cause/${eventLogId}`,
    );
    return response.data;
  },

  getStatistics: async (eventLogId: string): Promise<ProcessStatistics> => {
    const response = await api.get<ProcessStatistics>(
      `/mining/statistics/${eventLogId}`,
    );
    return response.data;
  },

  getSummary: async (eventLogId: string): Promise<ProcessSummary> => {
    const response = await api.get<ProcessSummary>(
      `/mining/summary/${eventLogId}`,
    );
    return response.data;
  },

  getCases: async (eventLogId: string): Promise<CaseListResponse> => {
    const response = await api.get<CaseListResponse>(`/mining/cases/${eventLogId}`);
    return response.data;
  },

  getCaseDetail: async (eventLogId: string, caseId: string): Promise<CaseDetailResponse> => {
    const response = await api.get<CaseDetailResponse>(`/mining/cases/${eventLogId}/${encodeURIComponent(caseId)}`);
    return response.data;
  },

  getTimeline: async (eventLogId: string): Promise<TimelineResponse> => {
    const response = await api.get<TimelineResponse>(`/mining/timeline/${eventLogId}`);
    return response.data;
  },

  getEdgeStats: async (
    eventLogId: string,
    source: string,
    target: string,
  ): Promise<EdgeStatsResponse> => {
    const response = await api.get<EdgeStatsResponse>(
      `/mining/edges/${eventLogId}`,
      { params: { source, target } },
    );
    return response.data;
  },

  getOverview: async (): Promise<OverviewResponse> => {
    const response = await api.get<OverviewResponse>('/overview');
    return response.data;
  },

  exportBpmn: async (eventLogId: string): Promise<{ event_log_id: string; bpmn_xml: string; algorithm: string }> => {
    const response = await api.get(`/mining/export-bpmn/${eventLogId}`);
    return response.data;
  },

  getDottedChart: async (eventLogId: string): Promise<DottedChartResponse> => {
    const r = await api.get<DottedChartResponse>(`/mining/dotted-chart/${eventLogId}`);
    return r.data;
  },

  getSocialNetwork: async (eventLogId: string): Promise<SocialNetworkResponse> => {
    const r = await api.get<SocialNetworkResponse>(`/mining/social-network/${eventLogId}`);
    return r.data;
  },

  compare: async (data: {
    event_log_id: string;
    split_attribute: string;
    split_value_a: string;
    split_value_b: string;
  }): Promise<ComparisonResponse> => {
    const r = await api.post<ComparisonResponse>('/mining/compare', data);
    return r.data;
  },

  getRework: async (eventLogId: string): Promise<ReworkResponse> => {
    const r = await api.get<ReworkResponse>(`/mining/rework/${eventLogId}`);
    return r.data;
  },

  getActivityDetail: async (
    eventLogId: string,
    activityName: string,
  ): Promise<ActivityDetailResponse> => {
    const r = await api.get<ActivityDetailResponse>(
      `/mining/activity-detail/${eventLogId}/${encodeURIComponent(activityName)}`,
    );
    return r.data;
  },

  simulate: async (data: {
    event_log_id: string;
    num_traces?: number;
    modifications: SimulationModification[];
  }): Promise<SimulationResponse> => {
    const r = await api.post<SimulationResponse>('/mining/simulate', data);
    return r.data;
  },

  getDESParams: async (eventLogId: string): Promise<DESParameters> => {
    const r = await api.get<DESParameters>(`/mining/simulate/des-params/${eventLogId}`);
    return r.data;
  },

  runDESSimulation: async (
    eventLogId: string,
    scenario: DESScenario,
    runs = 5,
    maxCases = 500,
  ): Promise<DESSimulationResult> => {
    const r = await api.post<DESSimulationResult>(
      `/mining/simulate/des/${eventLogId}`,
      scenario,
      { params: { runs, max_cases: maxCases } },
    );
    return r.data;
  },

  getQuality: async (eventLogId: string): Promise<DataQualityResponse> => {
    const r = await api.get<DataQualityResponse>(`/mining/quality/${eventLogId}`);
    return r.data;
  },

  getReport: async (eventLogId: string): Promise<{ html: string; event_log_name: string }> => {
    const r = await api.get(`/mining/report/${eventLogId}`);
    return r.data;
  },

  getInsights: async (eventLogId: string): Promise<InsightsResponse> => {
    const r = await api.get(`/mining/insights/${eventLogId}`);
    return r.data;
  },

  getPerformanceDFG: async (id: string) => (await api.get(`/mining/performance-dfg/${id}`)).data,
  getEFG: async (id: string) => (await api.get(`/mining/efg/${id}`)).data,
  getTemporalProfile: async (id: string) => (await api.get(`/mining/temporal-profile/${id}`)).data,
  getBatches: async (id: string) => (await api.get(`/mining/batches/${id}`)).data,
  getCaseOverlap: async (id: string) => (await api.get(`/mining/case-overlap/${id}`)).data,
  getOrgRoles: async (id: string) => (await api.get(`/mining/org-roles/${id}`)).data,
  getSNA: async (id: string, type: string) => (await api.get(`/mining/sna/${id}`, { params: { network_type: type } })).data,
  clusterCases: async (id: string, nClusters: number) => (await api.post(`/mining/cluster/${id}`, { n_clusters: nClusters })).data,
  getLogSkeleton: async (id: string) => (await api.get(`/mining/log-skeleton/${id}`)).data,
  getDeclare: async (id: string) => (await api.get(`/mining/declare/${id}`)).data,
  checkFourEyes: async (id: string, act1: string, act2: string) => (await api.post(`/mining/four-eyes/${id}`, { activity1: act1, activity2: act2 })).data,
  getPerformanceSpectrum: async (id: string) => (await api.get(`/mining/performance-spectrum/${id}`)).data,
  getFeatures: async (id: string) => (await api.get(`/mining/features/${id}`)).data,

  getDrift: async (
    eventLogId: string,
    params?: { window?: string; sensitivity?: number },
  ): Promise<DriftResponse> => {
    const response = await api.get<DriftResponse>(
      `/mining/drift/${eventLogId}`,
      { params },
    );
    return response.data;
  },
};
