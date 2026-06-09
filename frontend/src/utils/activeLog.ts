// Shared helpers for resolving the active project / event-log from the URL.
//
// These power the global analysis palette and the context-aware sidebar, which
// both need to know "which log is the user currently looking at?" without being
// route components themselves. Previously this logic lived only inside
// ProjectSwitcher; it is centralised here so there is a single source of truth.
//
// NOTE: keep these two sets in sync with the parameterized routes in App.tsx —
// a project/log route missing here means the palette/sidebar silently won't
// resolve the active context on that route.

/** Routes whose 2nd path segment is a :projectId. */
export const PROJECT_ID_PARAM_ROUTES = new Set([
  'kpis', 'journeys', 'scheduled-reports', 'builder', 'benchmark', 'task-mining',
  'initiatives', 'upload', 'projects',
]);

/** Routes whose 2nd path segment is an :eventLogId (log-scoped views). */
export const LOG_ID_PARAM_ROUTES = new Set([
  'process', 'variants', 'bottlenecks', 'drift', 'conformance', 'root-cause',
  'dotted-chart', 'social-network', 'rework', 'comparison', 'simulate',
  'sustainability', 'automation-roi', 'health', 'cases-at-risk', 'causal-map',
  'pulse', 'process-city', 'animation', 'mission-control', 'lineage', 'ocpm',
]);

/** The 2nd path segment, but only when the 1st segment is in `routes`. */
export function secondSegment(pathname: string, routes: Set<string>): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && routes.has(segments[0])) return segments[1];
  return null;
}

/** The :eventLogId for the current path, if it is a log-scoped view. */
export function getActiveLogId(pathname: string): string | null {
  return secondSegment(pathname, LOG_ID_PARAM_ROUTES);
}

/** The :projectId for the current path, if it is a project-scoped view. */
export function getActiveProjectId(pathname: string): string | null {
  return secondSegment(pathname, PROJECT_ID_PARAM_ROUTES);
}
