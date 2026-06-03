import api from './http';
import type { Connector, ConnectorSchemaResponse } from '@/types';

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

  // Introspect the connector's data source for column-mapping dropdowns.
  // Never 500s — failures come back as columns:[] with `error` populated;
  // treat an empty `columns` array as "fall back to free text".
  getSchema: async (id: string): Promise<ConnectorSchemaResponse> => {
    const response = await api.get<ConnectorSchemaResponse>(
      `/connectors/${id}/schema`,
    );
    return response.data;
  },
};
