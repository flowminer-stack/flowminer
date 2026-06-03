import api from './http';
import type {
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
  OPeraPerformanceResponse,
  StateAwareResponse,
  OCPMImprovementReport,
  OCPMImprovementFinding,
} from '@/types';

// Re-export the OCPM improvement-report domain types so the historical
// '@/api/client' surface keeps resolving unchanged.
export type {
  OCPMImprovementFinding,
  OCPMObjectTypeSection,
  OCPMImprovementReport,
} from '@/types';

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

  // OPerA object-centric performance metrics (flow / synchronization /
  // pooling / lagging time per activity, all in seconds). Returns HTTP 501
  // when the optional `ocpa` package is not installed — callers should
  // surface that as a "feature requires ocpa" state rather than an error.
  getOPeraPerformance: async (ocelId: string): Promise<OPeraPerformanceResponse> =>
    (await api.get<OPeraPerformanceResponse>(`/ocel/${ocelId}/opera-performance`)).data,

  // State-Aware OCPM: materialize object-state transitions into synthetic
  // events and annotate existing events with current object state.
  // `stateColumn` is the object attribute carrying the state label;
  // `objectType` optionally restricts enrichment to one object type.
  getStateAware: async (
    ocelId: string,
    stateColumn: string,
    objectType?: string,
  ): Promise<StateAwareResponse> =>
    (
      await api.post<StateAwareResponse>(`/ocel/${ocelId}/state-aware`, null, {
        params: { state_column: stateColumn, object_type: objectType },
      })
    ).data,
};
