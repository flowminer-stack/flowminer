import axios, { AxiosInstance, AxiosProgressEvent } from 'axios';
import type {
  Token,
  LoginRequest,
  RegisterRequest,
  User,
  Project,
  ProjectCreate,
  EventLog,
  EventLogPreview,
  ColumnMapping,
  DiscoveryRequest,
  DiscoveryResponse,
  VariantResponse,
  BottleneckResponse,
  ConformanceResponse,
  RootCauseResponse,
  ProcessStatistics,
  ProcessSummary,
  Dashboard,
  DashboardCreate,
  Alert,
  AlertCreate,
  Connector,
  ProcessTemplate,
  Annotation,
  CaseListResponse,
  CaseDetailResponse,
  TimelineResponse,
  EdgeStatsResponse,
  OverviewResponse,
  Task,
  TaskStatus,
  TaskPriority,
  TaskSummary,
  DottedChartResponse,
  SocialNetworkResponse,
  ComparisonResponse,
  ReworkResponse,
  ActivityDetailResponse,
  OCELSummary,
  OCDFGResponse,
  ObjectInteractionsResponse,
  ObjectLifecycleResponse,
  ActivityObjectTypesResponse,
  FlattenResponse,
  OCPetriNetResponse,
  ObjectsGraphResponse,
  OCELFeaturesResponse,
  OCELTemporalResponse,
  ConnectedComponentsResponse,
  SimulationModification,
  SimulationResponse,
  SearchResponse,
  DataQualityResponse,
  InsightsResponse,
  FilterOptions,
  TimestampRepairResult,
} from '@/types';

// ─── Axios Instance ──────────────────────────────────────────────────────────

const api: AxiosInstance = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 120000, // 2 minutes — mining operations can be slow
});

// Request interceptor: attach auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('flowminer_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Response interceptor: handle 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('flowminer_token');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

// ─── Auth ────────────────────────────────────────────────────────────────────

export const auth = {
  login: async (data: LoginRequest): Promise<Token> => {
    const formData = new URLSearchParams();
    formData.append('username', data.email);
    formData.append('password', data.password);
    const response = await api.post<Token>('/auth/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data;
  },

  register: async (data: RegisterRequest): Promise<User> => {
    const response = await api.post<User>('/auth/register', data);
    return response.data;
  },

  getMe: async (): Promise<User> => {
    const response = await api.get<User>('/auth/me');
    return response.data;
  },

  // Server-side JWT revocation. We intentionally don't await the
  // response-level error — even if the request fails the client still
  // clears its local token so the user is signed out of this tab.
  logout: async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Silent — the blocklist entry is nice-to-have; the client
      // clearing its own token is the primary sign-out action.
    }
  },

  // Anonymous demo login. Only reachable when the backend has
  // DEMO_MODE=1 — returns 404 otherwise. The resulting JWT is
  // read-only outside an analytics allowlist enforced by the
  // demo write-guard middleware.
  demoLogin: async (): Promise<Token> => {
    const response = await api.post<Token>('/auth/demo');
    return response.data;
  },
};

// ─── Demo mode ────────────────────────────────────────────────────────────

export const demo = {
  status: async (): Promise<{ demo_mode: boolean; demo_user_email: string | null }> => {
    const response = await api.get('/demo/status');
    return response.data;
  },
};

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = {
  list: async (): Promise<Project[]> => {
    const response = await api.get<Project[]>('/projects');
    return response.data;
  },

  create: async (data: ProjectCreate): Promise<Project> => {
    const response = await api.post<Project>('/projects', data);
    return response.data;
  },

  get: async (id: string): Promise<Project> => {
    const response = await api.get<Project>(`/projects/${id}`);
    return response.data;
  },

  update: async (
    id: string,
    data: Partial<ProjectCreate>,
  ): Promise<Project> => {
    const response = await api.put<Project>(`/projects/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/projects/${id}`);
  },

  seedSample: async (): Promise<Project> => {
    const r = await api.post('/projects/seed-sample');
    return r.data;
  },
};

// ─── Event Logs ──────────────────────────────────────────────────────────────

export const eventLogs = {
  upload: async (
    projectId: string,
    file: File,
    onProgress?: (event: AxiosProgressEvent) => void,
  ): Promise<EventLog> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('project_id', projectId);
    const response = await api.post<EventLog>(
      `/event-logs/upload`,
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: onProgress,
      },
    );
    return response.data;
  },

  list: async (projectId: string): Promise<EventLog[]> => {
    const response = await api.get<EventLog[]>(
      `/event-logs?project_id=${projectId}`,
    );
    return response.data;
  },

  get: async (id: string): Promise<EventLog> => {
    const response = await api.get<EventLog>(`/event-logs/${id}`);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/event-logs/${id}`);
  },

  preview: async (id: string): Promise<EventLogPreview> => {
    const response = await api.get<EventLogPreview>(
      `/event-logs/${id}/preview`,
    );
    return response.data;
  },

  setColumnMapping: async (
    id: string,
    mapping: ColumnMapping,
  ): Promise<EventLog> => {
    const response = await api.post<EventLog>(
      `/event-logs/${id}/column-mapping`,
      mapping,
    );
    return response.data;
  },

  previewTimestampRepair: async (id: string): Promise<TimestampRepairResult> => {
    const response = await api.get<TimestampRepairResult>(
      `/event-logs/${id}/repair-timestamps/preview`,
    );
    return response.data;
  },

  applyTimestampRepair: async (id: string): Promise<TimestampRepairResult> => {
    const response = await api.post<TimestampRepairResult>(
      `/event-logs/${id}/repair-timestamps`,
    );
    return response.data;
  },
};

// ─── Mining ──────────────────────────────────────────────────────────────────

// ─── Competitive-parity endpoints ───────────────────────────────────────

export interface WhatIfBottleneckResponse {
  original_case_avg_seconds: number;
  new_case_avg_seconds: number;
  saving_per_case_seconds: number;
  total_saving_seconds: number;
  pct_improvement: number;
  activity_avg_dwell_seconds: number;
  activity_new_dwell_seconds: number;
  activity_occurrences: number;
  cases_affected: number;
  cases_total: number;
}

export interface AutomationCandidate {
  activity: string;
  frequency: number;
  avg_duration_seconds: number;
  total_time_seconds: number;
  score: number;
  estimated_hours_saved: number;
  estimated_cost_saved: number;
}

export interface AutomationCandidatesResponse {
  candidates: AutomationCandidate[];
  hourly_cost_used: number;
  automation_rate_used: number;
}

export interface VariantEvolutionResponse {
  buckets: Array<{
    period: string;
    total_cases: number;
    top_variants: Array<{ rank: number; signature: string; case_count: number }>;
  }>;
  granularity: string;
}

export interface AttributeHistogramResponse {
  attribute: string;
  buckets: Array<{ label: string; count: number; min: number | null; max: number | null }>;
  min: number | null;
  max: number | null;
  is_numeric: boolean;
}

export interface ActivityTreemapResponse {
  activity: string;
  split_by: string;
  cells: Array<{ label: string; value: number; avg_duration_seconds: number | null }>;
}

export interface CaseGanttResponse {
  cases: Array<{
    case_id: string;
    start: string;
    end: string;
    events: Array<{ activity: string; start: string; end: string }>;
  }>;
  total: number;
}

export interface CohortSignificanceResponse {
  results: Array<{
    metric: string;
    cohort_a_value: number;
    cohort_b_value: number;
    p_value: number | null;
    significant: boolean;
  }>;
}

export interface ComplianceMatrixResponse {
  segments: string[];
  rules: string[];
  cells: Array<{ rule: string; segment: string; pass_rate: number; cases: number }>;
}

export interface InterAppGraphResponse {
  apps: string[];
  edges: Array<{
    source_app: string;
    target_app: string;
    count: number;
    avg_dwell_seconds: number;
  }>;
}

export interface AppTeamHeatmapResponse {
  teams: string[];
  apps: string[];
  cells: Array<{ team: string; app: string; seconds: number }>;
}

// ─── Governance + capability + log versions ────────────────────────────

export type GovernanceStatus = 'draft' | 'review' | 'approved' | 'published' | 'retired';

export interface GovernanceEntry {
  id: string;
  name: string;
  owner_id: string | null;
  event_log_id: string | null;
  version: string;
  status: GovernanceStatus;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  linked_event_log_ids: string[];
  owner_id: string | null;
  created_at: string;
}

export interface LogVersion {
  id: string;
  event_log_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  filter_payload: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
}

export const governance = {
  // Governance entries
  listEntries: async (): Promise<GovernanceEntry[]> =>
    (await api.get('/governance/entries')).data,
  createEntry: async (body: {
    name: string;
    event_log_id?: string | null;
    version?: string;
    notes?: string | null;
  }): Promise<GovernanceEntry> => (await api.post('/governance/entries', body)).data,
  updateEntry: async (
    id: string,
    body: Partial<Pick<GovernanceEntry, 'name' | 'version' | 'notes' | 'owner_id'>>,
  ): Promise<GovernanceEntry> => (await api.put(`/governance/entries/${id}`, body)).data,
  promoteEntry: async (
    id: string,
    toStatus: GovernanceStatus,
    comment?: string,
  ): Promise<GovernanceEntry> =>
    (await api.post(`/governance/entries/${id}/promote`, { to_status: toStatus, comment })).data,
  entryHistory: async (id: string) =>
    (await api.get(`/governance/entries/${id}/history`)).data as Array<{
      id: string;
      from_status: GovernanceStatus | null;
      to_status: GovernanceStatus;
      actor_id: string;
      comment: string | null;
      created_at: string;
    }>,
  deleteEntry: async (id: string) => (await api.delete(`/governance/entries/${id}`)).data,

  // Capabilities
  listCapabilities: async (): Promise<Capability[]> =>
    (await api.get('/governance/capabilities')).data,
  createCapability: async (body: {
    name: string;
    description?: string | null;
    parent_id?: string | null;
    linked_event_log_ids?: string[];
  }): Promise<Capability> => (await api.post('/governance/capabilities', body)).data,
  updateCapability: async (
    id: string,
    body: Partial<Pick<Capability, 'name' | 'description' | 'parent_id' | 'linked_event_log_ids'>>,
  ): Promise<Capability> => (await api.put(`/governance/capabilities/${id}`, body)).data,
  deleteCapability: async (id: string) =>
    (await api.delete(`/governance/capabilities/${id}`)).data,

  // Log versions
  listLogVersions: async (eventLogId: string): Promise<LogVersion[]> =>
    (await api.get(`/governance/log-versions?event_log_id=${eventLogId}`)).data,
  createLogVersion: async (body: {
    event_log_id: string;
    name: string;
    description?: string | null;
    parent_id?: string | null;
    filter_payload?: Record<string, unknown> | null;
  }): Promise<LogVersion> => (await api.post('/governance/log-versions', body)).data,
  deleteLogVersion: async (id: string) =>
    (await api.delete(`/governance/log-versions/${id}`)).data,
};

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
};

// ─── OCEL ────────────────────────────────────────────────────────────────────

export const ocel = {
  upload: async (file: File): Promise<OCELSummary> => {
    const formData = new FormData();
    formData.append('file', file);
    const r = await api.post<OCELSummary>('/ocel/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return r.data;
  },

  convert: async (eventLogId: string, objectTypeColumns: string[]): Promise<OCELSummary> => {
    const r = await api.post<OCELSummary>(`/ocel/convert/${eventLogId}`, {
      object_type_columns: objectTypeColumns,
    });
    return r.data;
  },

  getSummary: async (ocelId: string): Promise<OCELSummary> => {
    const r = await api.get<OCELSummary>(`/ocel/${ocelId}/summary`);
    return r.data;
  },

  discover: async (ocelId: string): Promise<OCDFGResponse> => {
    const r = await api.get<OCDFGResponse>(`/ocel/${ocelId}/discover`);
    return r.data;
  },

  flatten: async (ocelId: string, objectType: string): Promise<FlattenResponse> => {
    const r = await api.post<FlattenResponse>(`/ocel/${ocelId}/flatten/${encodeURIComponent(objectType)}`);
    return r.data;
  },

  getObjectInteractions: async (ocelId: string): Promise<ObjectInteractionsResponse> => {
    const r = await api.get<ObjectInteractionsResponse>(`/ocel/${ocelId}/object-interactions`);
    return r.data;
  },

  getObjectLifecycle: async (ocelId: string): Promise<ObjectLifecycleResponse> => {
    const r = await api.get<ObjectLifecycleResponse>(`/ocel/${ocelId}/object-lifecycle`);
    return r.data;
  },

  getActivityObjectTypes: async (ocelId: string): Promise<ActivityObjectTypesResponse> => {
    const r = await api.get<ActivityObjectTypesResponse>(`/ocel/${ocelId}/activity-object-types`);
    return r.data;
  },

  getOCPetriNet: async (ocelId: string): Promise<OCPetriNetResponse> =>
    (await api.get<OCPetriNetResponse>(`/ocel/${ocelId}/oc-petri-net`)).data,

  getObjectsGraph: async (ocelId: string, graphType: string): Promise<ObjectsGraphResponse> =>
    (await api.get<ObjectsGraphResponse>(`/ocel/${ocelId}/objects-graph`, { params: { graph_type: graphType } })).data,

  getOCELFeatures: async (ocelId: string, objectType: string): Promise<OCELFeaturesResponse> =>
    (await api.get<OCELFeaturesResponse>(`/ocel/${ocelId}/features/${encodeURIComponent(objectType)}`)).data,

  getTemporalSummary: async (ocelId: string): Promise<OCELTemporalResponse> =>
    (await api.get<OCELTemporalResponse>(`/ocel/${ocelId}/temporal-summary`)).data,

  getConnectedComponents: async (ocelId: string): Promise<ConnectedComponentsResponse> =>
    (await api.get<ConnectedComponentsResponse>(`/ocel/${ocelId}/connected-components`)).data,

  getInsights: async (ocelId: string) =>
    (await api.get(`/ocel/${ocelId}/insights`)).data as { insights: Array<{ severity: string; title: string; description: string; recommendation: string | null }>; summary: string },

  getImprovementReport: async (ocelId: string) =>
    (await api.get(`/ocel/${ocelId}/improvement-report`)).data as OCPMImprovementReport,

  narrateImprovementReport: async (ocelId: string) =>
    (await api.post(`/ocel/${ocelId}/improvement-report/narrate`)).data as {
      narrative: string;
      llm_configured: boolean;
    },

  explainImprovementFinding: async (
    ocelId: string,
    finding: OCPMImprovementFinding,
    ocelContext = true,
  ) =>
    (
      await api.post(`/ocel/${ocelId}/improvement-report/explain`, {
        finding,
        ocel_context: ocelContext,
      })
    ).data as { explanation: string; llm_configured: boolean },

  getReport: async (ocelId: string) =>
    (await api.get(`/ocel/${ocelId}/report`)).data as {
      html: string;
      event_log_name: string | null;
    },
};

// Shape of the new unified OCPM improvement report. Matches the
// pydantic models in backend/app/api/ocel.py.
export interface OCPMImprovementFinding {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  recommendation: string | null;
  metric_value: number | null;
  impact_estimate: string | null;
  related_activities: string[] | null;
  object_type: string | null;
}

export interface OCPMObjectTypeSection {
  object_type: string;
  total_cases: number;
  total_events: number;
  total_activities: number;
  critical_count: number;
  warning_count: number;
  findings: OCPMImprovementFinding[];
  error: string | null;
}

export interface OCPMImprovementReport {
  summary: string;
  ocel_event_count: number;
  ocel_object_count: number;
  object_type_count: number;
  total_findings: number;
  critical_count: number;
  warning_count: number;
  ocel_findings: OCPMImprovementFinding[];
  per_object_type: OCPMObjectTypeSection[];
  cross_object_findings: OCPMImprovementFinding[];
}

// ─── Dashboards ──────────────────────────────────────────────────────────────

export const dashboards = {
  list: async (projectId?: string): Promise<Dashboard[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<Dashboard[]>(`/dashboards${params}`);
    return response.data;
  },

  create: async (data: DashboardCreate): Promise<Dashboard> => {
    const response = await api.post<Dashboard>('/dashboards', data);
    return response.data;
  },

  get: async (id: string): Promise<Dashboard> => {
    const response = await api.get<Dashboard>(`/dashboards/${id}`);
    return response.data;
  },

  update: async (id: string, data: Partial<Dashboard>): Promise<Dashboard> => {
    const response = await api.put<Dashboard>(`/dashboards/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/dashboards/${id}`);
  },

  getShared: async (shareToken: string): Promise<Dashboard> => {
    const response = await api.get<Dashboard>(
      `/dashboards/shared/${shareToken}`,
    );
    return response.data;
  },
};

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const alerts = {
  list: async (projectId?: string): Promise<Alert[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<Alert[]>(`/alerts${params}`);
    return response.data;
  },

  create: async (data: AlertCreate): Promise<Alert> => {
    const response = await api.post<Alert>('/alerts', data);
    return response.data;
  },

  get: async (id: string): Promise<Alert> => {
    const response = await api.get<Alert>(`/alerts/${id}`);
    return response.data;
  },

  update: async (id: string, data: Partial<AlertCreate>): Promise<Alert> => {
    const response = await api.put<Alert>(`/alerts/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/alerts/${id}`);
  },

  test: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post<{ success: boolean; message: string }>(
      `/alerts/${id}/test`,
    );
    return response.data;
  },
};

// ─── Connectors ──────────────────────────────────────────────────────────────

export const connectors = {
  list: async (projectId?: string): Promise<Connector[]> => {
    const params = projectId ? `?project_id=${projectId}` : '';
    const response = await api.get<Connector[]>(`/connectors${params}`);
    return response.data;
  },

  create: async (data: Partial<Connector>): Promise<Connector> => {
    const response = await api.post<Connector>('/connectors', data);
    return response.data;
  },

  get: async (id: string): Promise<Connector> => {
    const response = await api.get<Connector>(`/connectors/${id}`);
    return response.data;
  },

  update: async (
    id: string,
    data: Partial<Connector>,
  ): Promise<Connector> => {
    const response = await api.put<Connector>(`/connectors/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/connectors/${id}`);
  },

  test: async (
    id: string,
  ): Promise<{ success: boolean; message: string }> => {
    const response = await api.post<{ success: boolean; message: string }>(
      `/connectors/${id}/test`,
    );
    return response.data;
  },

  sync: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post<{ success: boolean; message: string }>(
      `/connectors/${id}/sync`,
    );
    return response.data;
  },
};

// ─── Templates ───────────────────────────────────────────────────────────────

export const templates = {
  list: async (): Promise<ProcessTemplate[]> => {
    const response = await api.get<ProcessTemplate[]>('/templates');
    return response.data;
  },

  get: async (id: string): Promise<ProcessTemplate> => {
    const response = await api.get<ProcessTemplate>(`/templates/${id}`);
    return response.data;
  },

  create: async (data: Partial<ProcessTemplate>): Promise<ProcessTemplate> => {
    const response = await api.post<ProcessTemplate>('/templates', data);
    return response.data;
  },

  seed: async (): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/templates/seed');
    return response.data;
  },
};

// ─── Annotations ─────────────────────────────────────────────────────────────

export const annotations = {
  list: async (eventLogId: string): Promise<Annotation[]> => {
    const response = await api.get<Annotation[]>(
      `/annotations?event_log_id=${eventLogId}`,
    );
    return response.data;
  },

  create: async (data: Partial<Annotation>): Promise<Annotation> => {
    const response = await api.post<Annotation>('/annotations', data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/annotations/${id}`);
  },
};

// ─── Search ──────────────────────────────────────────────────────────────────

export const search = {
  query: async (q: string): Promise<SearchResponse> => {
    const r = await api.get<SearchResponse>('/search', { params: { q } });
    return r.data;
  },
};

// ─── Admin ───────────────────────────────────────────────────────────────────

export const admin = {
  listUsers: async (): Promise<User[]> => {
    const r = await api.get<User[]>('/users');
    return r.data;
  },

  updateRole: async (userId: string, role: string): Promise<User> => {
    const r = await api.put<User>(`/users/${userId}/role`, { role });
    return r.data;
  },

  updateStatus: async (userId: string, isActive: boolean): Promise<User> => {
    const r = await api.put<User>(`/users/${userId}/status`, { is_active: isActive });
    return r.data;
  },

  deleteUser: async (userId: string): Promise<void> => {
    await api.delete(`/users/${userId}`);
  },
};

// ─── Initiatives (Value/ROI Tracker) ─────────────────────────────────────────

export const initiatives = {
  list: async (projectId: string): Promise<any[]> => {
    const r = await api.get('/initiatives', { params: { project_id: projectId } });
    return r.data;
  },
  create: async (body: any): Promise<any> => {
    const r = await api.post('/initiatives', body);
    return r.data;
  },
  update: async (id: string, body: any): Promise<any> => {
    const r = await api.put(`/initiatives/${id}`, body);
    return r.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/initiatives/${id}`);
  },
  measure: async (id: string): Promise<any> => {
    const r = await api.post(`/initiatives/${id}/measure`);
    return r.data;
  },
  summary: async (projectId: string): Promise<any> => {
    const r = await api.get(`/initiatives/summary/${projectId}`);
    return r.data;
  },
};

// ─── Action Rules ────────────────────────────────────────────────────────────

export const actionRules = {
  list: async (projectId: string): Promise<any[]> => {
    const r = await api.get('/action-rules', { params: { project_id: projectId } });
    return r.data;
  },
  create: async (body: any): Promise<any> => {
    const r = await api.post('/action-rules', body);
    return r.data;
  },
  update: async (id: string, body: any): Promise<any> => {
    const r = await api.put(`/action-rules/${id}`, body);
    return r.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/action-rules/${id}`);
  },
  evaluate: async (id: string, dryRun = true): Promise<any> => {
    const r = await api.post(`/action-rules/${id}/evaluate`, null, { params: { dry_run: dryRun } });
    return r.data;
  },
  executions: async (id: string, limit = 100): Promise<any[]> => {
    const r = await api.get(`/action-rules/${id}/executions`, { params: { limit } });
    return r.data;
  },
};

// ─── Analytics (sustainability, agent mining, benchmarks, SQL, NL) ───────────

export const analytics = {
  sustainability: async (body: {
    event_log_id: string;
    factors?: Record<string, number>;
    activity_overrides?: Record<string, Record<string, number>>;
  }): Promise<any> => {
    const r = await api.post('/analytics/sustainability', body);
    return r.data;
  },
  agentMining: async (eventLogId: string): Promise<any> => {
    const r = await api.get(`/analytics/agent-mining/${eventLogId}`);
    return r.data;
  },
  benchmark: async (eventLogIds: string[]): Promise<any> => {
    const r = await api.post('/analytics/benchmark', { event_log_ids: eventLogIds });
    return r.data;
  },
  sqlSandbox: async (body: { event_log_id: string; query: string; limit?: number }): Promise<any> => {
    const r = await api.post('/analytics/sql-sandbox', body);
    return r.data;
  },
  calendarHeatmap: async (eventLogId: string): Promise<any> => {
    const r = await api.get(`/analytics/calendar-heatmap/${eventLogId}`);
    return r.data;
  },
  textToWidget: async (eventLogId: string, question: string): Promise<any> => {
    const r = await api.post('/analytics/text-to-widget', {
      event_log_id: eventLogId,
      question,
    });
    return r.data;
  },
};

// ─── Task Mining ─────────────────────────────────────────────────────────────

export interface TaskPattern {
  id: string;
  name: string;
  sequence: Array<[string, string]>;
  frequency: number;
  avg_duration_sec: number;
  unique_users: number;
  automatable_score: number;
  discovered_at: string | null;
}

export interface TaskPatternCrossLink {
  pattern_id: string;
  pattern_name: string;
  frequency: number;
  automatable_score: number;
  step_count: number;
  overall_similarity: number;
  top_activities: Array<{ activity: string; score: number }>;
  per_step: Array<{ probe: string; best_match: string; score: number }>;
}

export const tasks = {
  list: async (params?: {
    status?: TaskStatus;
    project_id?: string;
    assignee_id?: string;
    case_id?: string;
  }): Promise<Task[]> => {
    const response = await api.get<Task[]>('/tasks', { params });
    return response.data;
  },
  summary: async (): Promise<TaskSummary> => {
    const response = await api.get<TaskSummary>('/tasks/summary');
    return response.data;
  },
  get: async (id: string): Promise<Task> => {
    const response = await api.get<Task>(`/tasks/${id}`);
    return response.data;
  },
  create: async (data: {
    project_id: string;
    event_log_id?: string | null;
    case_id?: string | null;
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    assignee_id?: string | null;
    source_rule_id?: string | null;
    context?: Record<string, unknown> | null;
  }): Promise<Task> => {
    const response = await api.post<Task>('/tasks', data);
    return response.data;
  },
  update: async (
    id: string,
    data: {
      title?: string;
      description?: string | null;
      priority?: TaskPriority;
      status?: TaskStatus;
      assignee_id?: string | null;
      snoozed_until?: string | null;
    },
  ): Promise<Task> => {
    const response = await api.patch<Task>(`/tasks/${id}`, data);
    return response.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/tasks/${id}`);
  },
};

export const taskMining = {
  listPatterns: async (projectId: string): Promise<TaskPattern[]> => {
    const r = await api.get<TaskPattern[]>('/task-mining/patterns', {
      params: { project_id: projectId },
    });
    return r.data;
  },

  mine: async (
    projectId: string,
    opts?: { min_frequency?: number; min_sequence_length?: number; max_sequence_length?: number },
  ): Promise<{ patterns: number; stored?: number; message?: string }> => {
    const r = await api.post('/task-mining/mine', {
      project_id: projectId,
      min_frequency: opts?.min_frequency ?? 3,
      min_sequence_length: opts?.min_sequence_length ?? 3,
      max_sequence_length: opts?.max_sequence_length ?? 8,
    });
    return r.data;
  },

  crossLink: async (
    projectId: string,
    eventLogId: string,
    minSimilarity: number = 0.5,
  ): Promise<{
    cross_links: TaskPatternCrossLink[];
    activities_considered: number;
    patterns_considered: number;
  }> => {
    const r = await api.post('/task-mining/cross-link', {
      project_id: projectId,
      event_log_id: eventLogId,
      min_similarity: minSimilarity,
    });
    return r.data;
  },

  listRecordings: async (
    projectId: string,
  ): Promise<
    Array<{
      id: string;
      agent_version: string | null;
      hostname: string | null;
      started_at: string | null;
      ended_at: string | null;
      event_count: number;
    }>
  > => {
    const r = await api.get('/task-mining/recordings', { params: { project_id: projectId } });
    return r.data;
  },
};

// ─── System settings (admin-only) ─────────────────────────────────────────

export interface LLMConfigResponse {
  provider: string;
  provider_source: 'db' | 'env' | 'unset';
  model: string;
  model_source: 'db' | 'env' | 'unset';
  has_api_key: boolean;
  api_key_source: 'db' | 'env' | 'unset';
  api_key_preview: string | null;
  is_configured: boolean;
}

export interface LLMConfigUpdate {
  provider?: string;
  model?: string;
  /** Empty string clears the stored key; omit to leave alone. */
  api_key?: string;
}

export const systemSettings = {
  getLLMConfig: async (): Promise<LLMConfigResponse> => {
    const r = await api.get('/system-settings/llm');
    return r.data;
  },
  updateLLMConfig: async (body: LLMConfigUpdate): Promise<LLMConfigResponse> => {
    const r = await api.put('/system-settings/llm', body);
    return r.data;
  },
};

// ─── AI (LLM chat, agent, text-to-bpmn, narrate) ─────────────────────────────

export interface ChatToolRenderBarChart {
  type: 'bar_chart';
  title: string;
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
  y_formatter?: 'duration_seconds' | 'percent' | null;
  orientation?: 'horizontal' | 'vertical';
  data: Array<Record<string, unknown>>;
}

export interface ChatToolRenderLineChart {
  type: 'line_chart';
  title: string;
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
  data: Array<Record<string, unknown>>;
}

export interface ChatToolRenderMetricCard {
  type: 'metric_card';
  title: string;
  metrics: Array<{ label: string; value: string }>;
}

export interface ChatToolRenderFilterProposal {
  type: 'filter_proposal';
  title: string;
  chips: Array<{
    type: string;
    label: string;
    payload: Record<string, unknown>;
  }>;
}

export type ChatToolRender =
  | ChatToolRenderBarChart
  | ChatToolRenderLineChart
  | ChatToolRenderMetricCard
  | ChatToolRenderFilterProposal;

export interface ChatToolResult {
  data?: unknown;
  render?: ChatToolRender | null;
  summary?: string;
  error?: string;
}

export interface ChatToolStartEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatToolResultEvent {
  id: string;
  name: string;
  result: ChatToolResult;
}

export interface ChatStreamHandlers {
  onChunk: (text: string) => void;
  onToolStart?: (event: ChatToolStartEvent) => void;
  onToolResult?: (event: ChatToolResultEvent) => void;
  onWarning?: (message: string) => void;
}

interface ChatStreamMessage {
  type?: string;
  text?: string;
  message?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: ChatToolResult;
}

export const ai = {
  /**
   * Stream a chat response from the LLM for the given event log.
   * Yields partial text chunks via the callback as they arrive.
   */
  chatStream: async (
    eventLogId: string,
    question: string,
    handlers: ChatStreamHandlers,
  ): Promise<void> => {
    const token = localStorage.getItem('flowminer_token');
    const response = await fetch('/api/v1/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event_log_id: eventLogId,
        question,
        stream: true,
        use_tools: true,
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Chat request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawAnything = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: ChatStreamMessage;
        try {
          msg = JSON.parse(line) as ChatStreamMessage;
        } catch {
          continue;
        }
        sawAnything = true;
        if (msg.type === 'chunk' && typeof msg.text === 'string') {
          handlers.onChunk(msg.text);
        } else if (msg.type === 'tool_start') {
          handlers.onToolStart?.({
            id: msg.id ?? '',
            name: msg.name ?? '',
            args: msg.args ?? {},
          });
        } else if (msg.type === 'tool_result') {
          handlers.onToolResult?.({
            id: msg.id ?? '',
            name: msg.name ?? '',
            result: msg.result ?? {},
          });
        } else if (msg.type === 'warning') {
          handlers.onWarning?.(msg.message ?? '');
        } else if (msg.type === 'error') {
          throw new Error(msg.message ?? 'Chat stream failed');
        }
        // 'done' is a no-op — the loop ends when the reader closes.
      }
    }
    if (!sawAnything) {
      throw new Error('Chat stream closed without any content');
    }
  },

  chat: async (
    eventLogId: string,
    question: string,
  ): Promise<{ answer: string; llm_configured: boolean }> => {
    const r = await api.post('/ai/chat', {
      event_log_id: eventLogId,
      question,
      stream: false,
    });
    return r.data;
  },

  agentRun: async (
    eventLogId: string,
    instruction: string,
  ): Promise<{
    text: string;
    tool_calls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
    turns: number;
    provider: string;
  }> => {
    const r = await api.post('/ai/agent/run', {
      event_log_id: eventLogId,
      instruction,
    });
    return r.data;
  },

  textToBpmn: async (description: string): Promise<{ bpmn_xml: string; llm_configured: boolean }> => {
    const r = await api.post('/ai/text-to-bpmn', { description });
    return r.data;
  },

  narrate: async (eventLogId: string): Promise<{ markdown: string; llm_configured: boolean }> => {
    const r = await api.get(`/ai/narrate/${eventLogId}`);
    return r.data;
  },

  suggestBestPractice: async (
    eventLogId: string,
  ): Promise<{ recommendations: Array<{ name: string; why: string; expected_impact: string }>; raw?: string }> => {
    const r = await api.get(`/ai/suggest-best-practice/${eventLogId}`);
    return r.data;
  },

  chatSuggestions: async (
    eventLogId: string,
  ): Promise<{
    suggestions: string[];
    top_findings: Array<{ severity: string; title: string; description: string }>;
  }> => {
    const r = await api.get(`/ai/chat-suggestions/${eventLogId}`);
    return r.data;
  },

  explainVariant: async (
    eventLogId: string,
    variantActivities: string[],
  ): Promise<VariantExplanation> => {
    const r = await api.post('/ai/explain-variant', {
      event_log_id: eventLogId,
      variant_activities: variantActivities,
    });
    return r.data;
  },
};

// Response shape for /ai/explain-variant — structured delta stats
// computed by the backend plus the LLM's plain-English paragraph.
export interface VariantExplanation {
  explanation: string;
  llm_configured: boolean;
  stats: {
    variant_case_count: number;
    other_case_count: number;
    variant_avg_duration_seconds: number;
    other_avg_duration_seconds: number;
    duration_ratio: number | null;
    activities: string[];
    longest_step: { activity: string; avg_seconds: number } | null;
    top_resources_in_variant: Array<{ name: string; share: number }>;
    top_resources_in_other: Array<{ name: string; share: number }>;
    root_cause_factor: {
      attribute: string;
      value: string;
      avg_duration_affected: number;
      avg_duration_normal: number;
      overlap_pct: number;
    } | null;
    happy_path: {
      activities: string[];
      case_count: number;
      avg_duration: number;
    } | null;
  };
}

// ─── Log Builder ─────────────────────────────────────────────────────────────

export const logBuilder = {
  uploadRaw: async (file: File): Promise<any> => {
    const formData = new FormData();
    formData.append('file', file);
    const r = await api.post('/log-builder/upload-raw', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return r.data;
  },
  build: async (body: {
    project_id: string;
    name: string;
    staging_path: string;
    case_id_column: string;
    events: { activity_name: string; timestamp_column: string }[];
    resource_column?: string | null;
    passthrough_columns?: string[];
  }): Promise<any> => {
    const r = await api.post('/log-builder/build', body);
    return r.data;
  },
};

export default api;
