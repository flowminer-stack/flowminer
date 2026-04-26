import { useState, useEffect, useCallback, useRef } from 'react';
import { getCached, setCached } from '@/store/analysisCache';
import { useFilterStore } from '@/store/filterStore';

interface AnalysisDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Seconds elapsed since the current fetch started. Useful for UI
   *  components that want to show progress feedback on slow analyses. */
  elapsedSec: number;
}

/**
 * Shared hook for analysis components that fetch data on mount.
 * Checks the module-level cache first; only calls the API on a miss.
 */
export function useAnalysisData<T>(
  eventLogId: string,
  analysisType: string,
  fetchFn: (eventLogId: string) => Promise<T>,
  errorMessage = `Failed to load ${analysisType}`,
): AnalysisDataResult<T> {
  // Associative cross-filter (Mehrwerk mpmX) — subscribe to the
  // shared filter store so any chip change invalidates the cache
  // key and re-fetches. The effective cache key folds in a stable
  // hash of the active chip list, so two different filter sets
  // don't clobber each other in the module cache.
  const chips = useFilterStore((s) => s.chips);
  const disabledChips = useFilterStore((s) => s.disabled);
  const filterKey = (() => {
    const active = chips.filter((c) => !disabledChips[c.id]);
    if (active.length === 0) return '';
    // Fast stable hash: type + JSON.stringify of payload, joined.
    return active
      .map((c) => `${c.type}:${JSON.stringify(c.payload)}`)
      .sort()
      .join('|');
  })();
  const cacheKey = filterKey ? `${analysisType}::${filterKey}` : analysisType;

  const cached = getCached<T>(eventLogId, cacheKey);
  const [data, setData] = useState<T | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  const retry = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let ignore = false;

    // On an explicit retry, skip the cache and force a fresh fetch.
    if (version === 0) {
      const existing = getCached<T>(eventLogId, cacheKey);
      if (existing) {
        setData(existing);
        setLoading(false);
        setError(null);
        setElapsedSec(0);
        return;
      }
    }

    setLoading(true);
    setError(null);
    setElapsedSec(0);
    startTimeRef.current = Date.now();

    // Tick elapsed seconds while loading so slow analyses can show progress.
    const tick = setInterval(() => {
      if (!ignore && startTimeRef.current) {
        setElapsedSec(Math.round((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    fetchFn(eventLogId)
      .then((result) => {
        setCached(eventLogId, cacheKey, result);
        if (!ignore) setData(result);
      })
      .catch((err) => {
        if (ignore) return;
        // Prefer the backend's detail message (e.g. timeout diagnostics)
        // over the generic fallback so users see *why* an analysis failed.
        const detail =
          err?.response?.data?.detail ||
          (err instanceof Error ? err.message : null);
        setError(detail || errorMessage);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
        clearInterval(tick);
      });

    return () => {
      ignore = true;
      clearInterval(tick);
    };
  }, [eventLogId, cacheKey, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, retry, elapsedSec };
}
