import api from './http';

// ─── BI connector API — flat tabular endpoints for Power BI / Tableau ─────────
//
// All table endpoints require `event_log_id` and return `list[dict]` with a
// stable column set. See /api/v1/bi/tables for the full schema catalogue.

export interface BiTableMeta {
  name: string;
  description: string;
  path: string;
  columns: { name: string; type: string }[];
}

export interface BiTablesResponse {
  tables: BiTableMeta[];
}

export interface BiStatisticsRow {
  event_log_id: string;
  total_cases: number;
  total_events: number;
  total_activities: number;
  avg_case_duration_hours: number;
  median_case_duration_hours: number;
  start_timestamp: string | null;
  end_timestamp: string | null;
}

export interface BiVariantRow {
  event_log_id: string;
  variant_rank: number;
  case_count: number;
  case_percentage: number;
  activity_sequence: string;
  step_count: number;
}

export interface BiBottleneckRow {
  event_log_id: string;
  activity: string;
  avg_duration_seconds: number;
  max_duration_seconds: number;
  frequency: number;
}

export interface BiActivityRow {
  event_log_id: string;
  activity: string;
  occurrences: number;
  cases_touching: number;
}

export interface BiCaseRow {
  event_log_id: string;
  case_id: string;
  event_count: number;
  duration_seconds: number;
  start_timestamp: string | null;
  end_timestamp: string | null;
  activity_count: number;
}

export interface BiEventRow {
  event_log_id: string;
  case_id: string | null;
  activity: string | null;
  timestamp: string | null;
  resource: string | null;
}

export const bi = {
  /** List the tables a BI tool can pull, with column schemas. */
  tables: async (): Promise<BiTablesResponse> => {
    const r = await api.get<BiTablesResponse>('/bi/tables');
    return r.data;
  },

  /** One-row KPI table for the event log. */
  statistics: async (eventLogId: string): Promise<BiStatisticsRow[]> => {
    const r = await api.get<BiStatisticsRow[]>('/bi/statistics', {
      params: { event_log_id: eventLogId },
    });
    return r.data;
  },

  /** Process variants ranked by frequency. */
  variants: async (eventLogId: string, limit = 500): Promise<BiVariantRow[]> => {
    const r = await api.get<BiVariantRow[]>('/bi/variants', {
      params: { event_log_id: eventLogId, limit },
    });
    return r.data;
  },

  /** Activities ranked by wait / duration (bottlenecks). */
  bottlenecks: async (eventLogId: string, limit = 500): Promise<BiBottleneckRow[]> => {
    const r = await api.get<BiBottleneckRow[]>('/bi/bottlenecks', {
      params: { event_log_id: eventLogId, limit },
    });
    return r.data;
  },

  /** One row per distinct activity with occurrence count. */
  activities: async (eventLogId: string): Promise<BiActivityRow[]> => {
    const r = await api.get<BiActivityRow[]>('/bi/activities', {
      params: { event_log_id: eventLogId },
    });
    return r.data;
  },

  /** One row per case with KPIs. Paginated. */
  cases: async (
    eventLogId: string,
    limit = 5000,
    offset = 0,
  ): Promise<BiCaseRow[]> => {
    const r = await api.get<BiCaseRow[]>('/bi/cases', {
      params: { event_log_id: eventLogId, limit, offset },
    });
    return r.data;
  },

  /** Flat event stream. Paginated. */
  events: async (
    eventLogId: string,
    limit = 10000,
    offset = 0,
  ): Promise<BiEventRow[]> => {
    const r = await api.get<BiEventRow[]>('/bi/events', {
      params: { event_log_id: eventLogId, limit, offset },
    });
    return r.data;
  },
};
