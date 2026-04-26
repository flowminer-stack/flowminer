/**
 * Module-level cache for analysis results.
 * Survives component remounts but resets on page reload.
 * Keyed by `${eventLogId}:${analysisType}`.
 *
 * Also tracks a "version" per eventLogId (derived from column mapping)
 * so stale results are automatically evicted when the mapping changes.
 */

const cache = new Map<string, unknown>();
const versionMap = new Map<string, string>();

function makeKey(eventLogId: string, analysisType: string): string {
  return `${eventLogId}:${analysisType}`;
}

export function getCached<T>(eventLogId: string, analysisType: string): T | null {
  const val = cache.get(makeKey(eventLogId, analysisType));
  return (val as T) ?? null;
}

export function setCached<T>(eventLogId: string, analysisType: string, data: T): void {
  cache.set(makeKey(eventLogId, analysisType), data);
}

export function clearForEventLog(eventLogId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${eventLogId}:`)) {
      cache.delete(key);
    }
  }
}

/**
 * Call after fetching event log metadata. If the column mapping changed
 * since the last check, all cached analysis for that eventLogId is evicted.
 */
export function checkVersion(eventLogId: string, version: string): void {
  const prev = versionMap.get(eventLogId);
  if (prev && prev !== version) {
    clearForEventLog(eventLogId);
  }
  versionMap.set(eventLogId, version);
}
