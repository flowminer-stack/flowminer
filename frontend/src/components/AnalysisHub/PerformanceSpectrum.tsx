import { mining as miningApi } from '@/api/client';
import type { PerformanceSpectrumResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

// Consistent activity colors
const PALETTE = [
  '#4f63b2', '#7c3aed', '#0891b2', '#059669', '#d97706',
  '#dc2626', '#db2777', '#4338ca', '#0d9488', '#65a30d',
];

export default function PerformanceSpectrum({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<PerformanceSpectrumResponse>(
    eventLogId, 'performance_spectrum', miningApi.getPerformanceSpectrum, 'Failed to load performance spectrum',
  );

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data || data.cases.length === 0) return <p className="py-10 text-center text-[12px] text-fg-muted">No spectrum data available.</p>;

  const displayCases = data.cases.slice(0, 50);

  // Build activity color map from all events
  const allActivities: string[] = [];
  for (const c of displayCases) {
    for (const e of c.events) {
      if (!allActivities.includes(e.activity)) allActivities.push(e.activity);
    }
  }
  const actColor = new Map(allActivities.map((a, i) => [a, PALETTE[i % PALETTE.length]]));

  // Compute global time range
  let globalMin = Infinity, globalMax = -Infinity;
  for (const c of displayCases) {
    for (const e of c.events) {
      const t = new Date(e.timestamp).getTime();
      if (t < globalMin) globalMin = t;
      if (t > globalMax) globalMax = t;
    }
  }
  const span = globalMax - globalMin || 1;

  return (
    <div className="space-y-3">
      <p className="mb-3 text-[11px] text-fg-muted">Timeline view of individual cases showing when each activity occurs. Helps identify delays and parallel execution.</p>
      <div className="flex items-start justify-between">
        <p className="text-[11px] text-fg-faint">
          Gantt-style view of up to 50 cases. Each block is an activity event, positioned by timestamp.
          {data.cases.length > 50 && ` (Showing 50 of ${data.cases.length})`}
        </p>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {allActivities.slice(0, 10).map((a) => (
          <div key={a} className="flex items-center gap-1">
            <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: actColor.get(a) }} />
            <span className="text-[10px] text-fg-faint">{a.length > 12 ? a.slice(0, 12) + '…' : a}</span>
          </div>
        ))}
        {allActivities.length > 10 && <span className="text-[10px] text-fg-faint">+{allActivities.length - 10} more</span>}
      </div>

      {/* Cases */}
      <div className="overflow-y-auto rounded-lg border border-line" style={{ maxHeight: 480 }}>
        {displayCases.map((c) => (
          <div key={c.case_id} className="group flex items-center border-b border-line last:border-b-0">
            {/* Case ID label */}
            <div className="w-24 shrink-0 px-2 py-1.5 text-[10px] text-fg-faint group-hover:text-fg-secondary transition-colors truncate" title={c.case_id}>
              {c.case_id}
            </div>
            {/* Bar area */}
            <div className="relative flex-1 h-6 bg-surface-0 group-hover:bg-tint transition-colors">
              {c.events.map((e, ei) => {
                const t = new Date(e.timestamp).getTime();
                const left = ((t - globalMin) / span) * 100;
                const color = actColor.get(e.activity) ?? '#888';
                return (
                  <div
                    key={ei}
                    title={`${e.activity}\n${new Date(e.timestamp).toLocaleString()}`}
                    className="absolute top-1 h-4 w-1.5 rounded-sm opacity-80 hover:opacity-100 hover:scale-110 transition-transform cursor-default"
                    style={{ left: `${left}%`, backgroundColor: color }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
