import api from './http';
import type {
  LogBuilderBuildRequest as BaseLogBuilderBuildRequest,
  LogBuilderUploadResponse,
  LogBuilderBuildResponse as BaseLogBuilderBuildResponse,
} from '@/types';

// ─── OCEL-aware build contract ───────────────────────────────────────────────
//
// The /log-builder/build endpoint branches on an `ocel_mode` flag. We extend the
// shared base types here (rather than in the shared types module) so the two
// modes share one request/response surface:
//
//  • Standard mode (`ocel_mode` falsy): unchanged — a `case_id_column` is
//    required and the response carries case/event counts.
//  • OCEL mode (`ocel_mode: true`): `case_id_column` is ignored (and so made
//    optional here); each column listed in `object_type_columns` becomes one
//    OCEL object type. Activity + timestamp are still designated via `events`.
//    The response additionally carries `ocel_id`, `object_types`, etc.
export type LogBuilderBuildRequest = Omit<BaseLogBuilderBuildRequest, 'case_id_column'> & {
  /** Optional in both modes; ignored by the backend when `ocel_mode` is true. */
  case_id_column?: string;
  /** Switch the backend to the object-centric (OCEL) build path. */
  ocel_mode?: boolean;
  /** Wide-table columns to materialise as OCEL object types (OCEL mode only). */
  object_type_columns?: string[];
  /**
   * Optional process content pack (recipe) id. When set, the backend
   * auto-creates the recipe's default Alert rows + CustomKPIs and attaches its
   * reference_model after the build, returning a `recipe_applied` summary.
   */
  recipe_id?: string;
};

// Standard-mode fields (`total_events`, `total_cases`) are relaxed to optional
// since an OCEL build reports counts via `event_count` / `object_count` instead.
export type LogBuilderBuildResponse = Omit<
  BaseLogBuilderBuildResponse,
  'total_events' | 'total_cases'
> & {
  total_events?: number;
  total_cases?: number;
  /** Present on a successful OCEL build; navigate to /ocpm/:id with this. */
  ocel_id?: string;
  object_types?: string[];
  object_count?: number;
  event_count?: number;
  /**
   * Present when the build request carried a `recipe_id`. Summarises what the
   * content pack provisioned alongside the event log.
   */
  recipe_applied?: {
    recipe_id: string;
    alerts_created: number;
    kpis_created: number;
    reference_model_attached: boolean;
  };
};

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
