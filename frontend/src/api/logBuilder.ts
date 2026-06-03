import api from './http';
import type {
  LogBuilderBuildRequest,
  LogBuilderUploadResponse,
  LogBuilderBuildResponse,
} from '@/types';

// ─── Log Builder ─────────────────────────────────────────────────────────────

export const logBuilder = {
  uploadRaw: async (file: File): Promise<LogBuilderUploadResponse> => {
    const formData = new FormData();
    formData.append('file', file);
    const r = await api.post<LogBuilderUploadResponse>(
      '/log-builder/upload-raw',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    );
    return r.data;
  },
  // Build a long event log from one staging table, optionally joining in
  // additional sources first. Upload each extra table via uploadRaw,
  // collect their staging paths into `additional_sources`, and reference
  // them by index from each join's `right_source`. `case_id_column` must
  // exist on the assembled wide table (after joins).
  build: async (body: LogBuilderBuildRequest): Promise<LogBuilderBuildResponse> => {
    const r = await api.post<LogBuilderBuildResponse>('/log-builder/build', body);
    return r.data;
  },
};
