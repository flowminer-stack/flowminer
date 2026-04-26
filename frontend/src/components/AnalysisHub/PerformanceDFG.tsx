import { mining as miningApi } from '@/api/client';
import type { PerformanceDFGResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

function fmtDuration(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function heatColor(val: number, min: number, max: number): string {
  if (max === min) return 'bg-accent/10 text-accent';
  const t = (val - min) / (max - min);
  if (t < 0.33) return 'bg-success/10 text-success';
  if (t < 0.66) return 'bg-warning/10 text-warning';
  return 'bg-danger/12 text-danger';
}

export default function PerformanceDFG({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<PerformanceDFGResponse>(
    eventLogId, 'performance_dfg', miningApi.getPerformanceDFG, 'Failed to load performance DFG',
  );

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data || data.activities.length === 0) return <p className="py-10 text-center text-[12px] text-fg-muted">No performance data available.</p>;

  const { activities, edges } = data;
  const lookup = new Map<string, number>();
  let min = Infinity, max = -Infinity;
  for (const e of edges) {
    lookup.set(`${e.source}||${e.target}`, e.avg_duration);
    if (e.avg_duration < min) min = e.avg_duration;
    if (e.avg_duration > max) max = e.avg_duration;
  }

  return (
    <div className="overflow-auto">
      <p className="mb-3 text-[11px] text-fg-muted">Average transition time between activity pairs. Darker/red cells indicate slower transitions that may need optimization.</p>
      <div className="overflow-auto rounded-lg border border-line">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface-1">
              <th className="sticky left-0 z-10 bg-surface-1 px-3 py-2 text-left font-semibold text-fg-faint">Source ↓ / Target →</th>
              {activities.map((a) => (
                <th key={a} className="px-2 py-2 text-center font-medium text-fg-secondary whitespace-nowrap max-w-[80px] truncate" title={a}>
                  {a.length > 10 ? a.slice(0, 10) + '…' : a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activities.map((src, ri) => (
              <tr key={src} className={ri % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                <td className="sticky left-0 z-10 border-r border-line bg-inherit px-3 py-1.5 font-medium text-fg-secondary whitespace-nowrap max-w-[120px] truncate" title={src}>
                  {src.length > 14 ? src.slice(0, 14) + '…' : src}
                </td>
                {activities.map((tgt) => {
                  const val = lookup.get(`${src}||${tgt}`);
                  return (
                    <td key={tgt} className="px-2 py-1.5 text-center">
                      {val !== undefined ? (
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${heatColor(val, min, max)}`}>
                          {fmtDuration(val)}
                        </span>
                      ) : (
                        <span className="text-fg-ghost">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
