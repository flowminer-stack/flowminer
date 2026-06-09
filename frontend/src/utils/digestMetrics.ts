// Backend-free "what changed since last visit" baseline. We keep the last two
// DISTINCT metric snapshots per log in localStorage and always diff the newest
// against the one before it. Recording identical metrics is a no-op, so the
// digest is idempotent: page refreshes (and React StrictMode's double effects)
// don't shift the comparison window, and deltas stay visible until the metrics
// genuinely change again — or the user dismisses them.

const KEY = 'fm-inbox-digest';

export interface LogMetricSnapshot {
  avgDuration: number;
  totalCases: number;
  slaCompliance: number | null; // normalized to 0–100, or null if unavailable
}

interface LogMetricHistory {
  current: LogMetricSnapshot;
  previous: LogMetricSnapshot | null;
}

type DigestStore = Record<string, LogMetricHistory>;

function snapshotsEqual(a: LogMetricSnapshot, b: LogMetricSnapshot): boolean {
  return (
    a.avgDuration === b.avgDuration &&
    a.totalCases === b.totalCases &&
    a.slaCompliance === b.slaCompliance
  );
}

function readStore(): DigestStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    const store: DigestStore = {};
    for (const [logId, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object') continue;
      // Migrate the earlier flat-snapshot shape ({avgDuration, ...}).
      if (typeof (entry as LogMetricSnapshot).avgDuration === 'number') {
        store[logId] = { current: entry as LogMetricSnapshot, previous: null };
      } else if ((entry as LogMetricHistory).current) {
        store[logId] = entry as LogMetricHistory;
      }
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: DigestStore): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota / disabled storage — non-fatal, just skip persistence */
  }
}

/**
 * Record the latest metrics for a log and return the snapshot to diff against
 * (or null when there is nothing meaningful to compare yet).
 */
export function recordSnapshot(
  logId: string,
  cur: LogMetricSnapshot,
): LogMetricSnapshot | null {
  const store = readStore();
  const entry = store[logId];
  if (!entry) {
    store[logId] = { current: cur, previous: null };
    writeStore(store);
    return null;
  }
  if (snapshotsEqual(entry.current, cur)) return entry.previous;
  store[logId] = { current: cur, previous: entry.current };
  writeStore(store);
  return entry.current;
}

/** Dismiss: stop showing deltas for this log until its metrics change again. */
export function acknowledgeLog(logId: string): void {
  const store = readStore();
  const entry = store[logId];
  if (!entry) return;
  store[logId] = { current: entry.current, previous: entry.current };
  writeStore(store);
}
