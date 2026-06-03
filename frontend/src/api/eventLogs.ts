import api from './http';
import type { AxiosProgressEvent } from 'axios';
import type {
  EventLog,
  EventLogPreview,
  ColumnMapping,
  TimestampRepairResult,
} from '@/types';

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
