import type { EventLog } from '@/types';

// Which analyses need which mapped column to produce anything. Used to grey out
// analyses whose prerequisite is missing (Tableau "Show Me" greys invalid chart
// types and explains why), rather than letting the user run them into an empty
// result. Conformance is intentionally absent — the backend auto-discovers a
// reference model, so it always works.
// Keys are hub analysis ids and full-page route segments — the two namespaces
// don't collide, so the palette can pass either.
const RESOURCE_REQUIRED = new Set([
  'org-roles', 'sna', 'agent-mining', 'four-eyes', 'social-network',
]);
const COST_REQUIRED = new Set(['automation-roi', 'sustainability']);

export interface AnalysisHints {
  /** A human-readable reason the analysis can't run on this log, or null. */
  disabledReason: (id: string) => string | null;
  /** A "start here" suggestion tailored to the log's shape. */
  isRecommended: (id: string) => boolean;
}

export function getAnalysisHints(eventLog: EventLog | null): AnalysisHints {
  // While the log is still loading we don't know what's mapped — stay neutral
  // rather than flashing every resource analysis as locked.
  if (!eventLog) {
    return {
      disabledReason: () => null,
      isRecommended: (id) => id === 'performance-dfg',
    };
  }

  const hasResource = !!eventLog?.resource_column;
  const hasCost = !!eventLog?.cost_column;
  const cases = eventLog?.total_cases ?? 0;

  const disabledReason = (id: string): string | null => {
    if (RESOURCE_REQUIRED.has(id) && !hasResource)
      return 'Needs a resource column — none is mapped for this log';
    if (COST_REQUIRED.has(id) && !hasCost)
      return 'Needs a cost column — none is mapped for this log';
    return null;
  };

  // Lightweight, metadata-driven recommendations. The performance map is the
  // universal starting point; surface handover analysis when resources exist,
  // clustering once there are enough cases to find structure, and Ask as the
  // low-friction entry when there's little structured metadata.
  const recommended = new Set<string>(['performance-dfg']);
  if (hasResource) recommended.add('sna');
  else recommended.add('ask');
  if (cases >= 500) recommended.add('clustering');

  const isRecommended = (id: string) => recommended.has(id) && !disabledReason(id);

  return { disabledReason, isRecommended };
}
