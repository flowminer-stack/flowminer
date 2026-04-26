import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  EventLog,
  EventLogPreview,
  ProcessSummary,
  DiscoveryResponse,
  ProcessFilter,
  Dashboard,
  DriftResponse,
} from '@/types';
import { eventLogs as eventLogsApi, mining, dashboards } from '@/api/client';
import { getCached, setCached, checkVersion } from '@/store/analysisCache';

// ─── useEventLogData ─────────────────────────────────────────────────────────

interface EventLogDataState {
  eventLog: EventLog | null;
  preview: EventLogPreview | null;
  summary: ProcessSummary | null;
  loading: boolean;
  previewLoading: boolean;
  summaryLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEventLogData(eventLogId: string | undefined): EventLogDataState {
  const cachedLog = eventLogId ? getCached<EventLog>(eventLogId, 'eventLog') : null;
  const cachedPreview = eventLogId ? getCached<EventLogPreview>(eventLogId, 'preview') : null;
  const cachedSummary = eventLogId ? getCached<ProcessSummary>(eventLogId, 'summary') : null;

  const [eventLog, setEventLog] = useState<EventLog | null>(cachedLog);
  const [preview, setPreview] = useState<EventLogPreview | null>(cachedPreview);
  const [summary, setSummary] = useState<ProcessSummary | null>(cachedSummary);
  const [loading, setLoading] = useState(!cachedLog);
  const [previewLoading, setPreviewLoading] = useState(!cachedPreview);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forceRefresh = useRef(false);

  const fetchData = useCallback(async () => {
    if (!eventLogId) return;

    // Check cache (skip on explicit refresh)
    if (!forceRefresh.current) {
      const cl = getCached<EventLog>(eventLogId, 'eventLog');
      const cp = getCached<EventLogPreview>(eventLogId, 'preview');
      const cs = getCached<ProcessSummary>(eventLogId, 'summary');
      if (cl) {
        setEventLog(cl);
        setPreview(cp);
        setSummary(cs);
        setLoading(false);
        setPreviewLoading(false);
        return;
      }
    }
    forceRefresh.current = false;

    setLoading(true);
    setError(null);

    try {
      const log = await eventLogsApi.get(eventLogId);
      setEventLog(log);
      setCached(eventLogId, 'eventLog', log);

      // Detect column-mapping changes and clear stale analysis data
      const version = [log.case_id_column, log.activity_column, log.timestamp_column, log.resource_column, log.cost_column].join('|');
      checkVersion(eventLogId, version);

      // Fetch preview in parallel
      setPreviewLoading(true);
      eventLogsApi
        .preview(eventLogId)
        .then((p) => {
          setPreview(p);
          setCached(eventLogId, 'preview', p);
          setPreviewLoading(false);
        })
        .catch(() => {
          setPreviewLoading(false);
        });

      // If the event log is ready, fetch the summary
      if (log.status === 'ready') {
        setSummaryLoading(true);
        try {
          const s = await mining.getSummary(eventLogId);
          setSummary(s);
          setCached(eventLogId, 'summary', s);
        } catch {
          // Summary may not be available yet
        } finally {
          setSummaryLoading(false);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load event log data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [eventLogId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const refresh = useCallback(async () => {
    forceRefresh.current = true;
    await fetchData();
  }, [fetchData]);

  return {
    eventLog,
    preview,
    summary,
    loading,
    previewLoading,
    summaryLoading,
    error,
    refresh,
  };
}

// ─── useProcessMap ───────────────────────────────────────────────────────────

interface ProcessMapState {
  discovery: DiscoveryResponse | null;
  loading: boolean;
  error: string | null;
  refetch: (algorithm?: 'dfg' | 'alpha' | 'heuristic' | 'inductive') => Promise<void>;
}

function filterCacheKey(algorithm: string, filters?: ProcessFilter, parameters?: Record<string, unknown>): string {
  const base = `discovery:${algorithm}`;
  const filterPart = (!filters || Object.keys(filters).length === 0) ? '' : `:${JSON.stringify(filters)}`;
  const paramPart = (!parameters || Object.keys(parameters).length === 0) ? '' : `:${JSON.stringify(parameters)}`;
  return `${base}${filterPart}${paramPart}`;
}

export function useProcessMap(
  eventLogId: string | undefined,
  algorithm: 'dfg' | 'alpha' | 'heuristic' | 'inductive' = 'dfg',
  filters?: ProcessFilter,
  parameters?: Record<string, unknown>,
): ProcessMapState {
  const cacheKey = filterCacheKey(algorithm, filters, parameters);
  const cached = eventLogId ? getCached<DiscoveryResponse>(eventLogId, cacheKey) : null;
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const fetchDiscovery = useCallback(
    async (algo?: 'dfg' | 'alpha' | 'heuristic' | 'inductive') => {
      if (!eventLogId) return;

      const key = filterCacheKey(algo ?? algorithm, filters, parameters);
      const existing = getCached<DiscoveryResponse>(eventLogId, key);
      if (existing) {
        setDiscovery(existing);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const hasFilters = filters && Object.keys(filters).length > 0;
        const hasParams = parameters && Object.keys(parameters).length > 0;
        const result = await mining.discover({
          event_log_id: eventLogId,
          algorithm: algo ?? algorithm,
          ...(hasFilters ? { filters } : {}),
          ...(hasParams ? { parameters } : {}),
        });
        setCached(eventLogId, key, result);
        setDiscovery(result);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to discover process map';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [eventLogId, algorithm, filters, parameters],
  );

  useEffect(() => {
    fetchDiscovery();
  }, [fetchDiscovery]);

  return { discovery, loading, error, refetch: fetchDiscovery };
}

// ─── useDashboard ────────────────────────────────────────────────────────────

interface DashboardState {
  dashboard: Dashboard | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateDashboard: (data: Partial<Dashboard>) => Promise<void>;
}

export function useDashboard(dashboardId: string | undefined): DashboardState {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    if (!dashboardId) return;

    setLoading(true);
    setError(null);

    try {
      const d = await dashboards.get(dashboardId);
      setDashboard(d);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load dashboard';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  const updateDashboard = useCallback(
    async (data: Partial<Dashboard>) => {
      if (!dashboardId) return;

      try {
        const updated = await dashboards.update(dashboardId, data);
        setDashboard(updated);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update dashboard';
        setError(message);
      }
    },
    [dashboardId],
  );

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return {
    dashboard,
    loading,
    error,
    refresh: fetchDashboard,
    updateDashboard,
  };
}

// ─── useDrift ─────────────────────────────────────────────────────────────────

interface DriftState {
  data: DriftResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetch concept-drift analysis for an event log.
 *
 * Re-fetches automatically when eventLogId, window, or sensitivity change.
 */
export function useDrift(
  eventLogId: string | undefined,
  window: string = 'auto',
  sensitivity: number = 0.15,
): DriftState {
  const [data, setData] = useState<DriftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!eventLogId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    mining
      .getDrift(eventLogId, { window, sensitivity })
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load drift analysis',
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [eventLogId, window, sensitivity, tick]);

  return { data, loading, error, refetch };
}
