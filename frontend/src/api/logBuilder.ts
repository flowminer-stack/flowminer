import api from './http';
import type {
  LogBuilderBuildRequest,
  LogBuilderUploadResponse,
  LogBuilderBuildResponse,
} from '@/types';

// ─── Log Builder ─────────────────────────────────────────────────────────────

// A prebuilt process content pack (recipe): a system-specific template that
// pre-fills the builder's tables/joins/events so a known process goes from
// "upload your tables" to a mineable log without writing the extraction.
export interface ProcessRecipeTable {
  name: string;
  description: string;
  role: string;
  source_hint?: string | null;
}

export interface ProcessRecipe {
  id: string;
  process_name: string;
  description: string;
  connector_type: string | null;
  category: string;
  required_tables: ProcessRecipeTable[];
  joins: unknown[];
  case_id_column: string;
  events: {
    activity_name: string;
    source_table: string;
    timestamp_column: string;
    resource_column?: string | null;
  }[];
  additional_columns: Record<string, string>;
  sample_kpis: string[];
  notes?: string | null;
}

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

  // Prebuilt process content packs (recipes). Optionally filter by the source
  // system (connector_type). Best-effort surface for onboarding.
  getTemplates: async (connectorType?: string): Promise<ProcessRecipe[]> => {
    const q = connectorType
      ? `?connector_type=${encodeURIComponent(connectorType)}`
      : '';
    const r = await api.get<ProcessRecipe[]>(`/log-builder/templates${q}`);
    return r.data;
  },

  getTemplate: async (id: string): Promise<ProcessRecipe> => {
    const r = await api.get<ProcessRecipe>(`/log-builder/templates/${id}`);
    return r.data;
  },
};
