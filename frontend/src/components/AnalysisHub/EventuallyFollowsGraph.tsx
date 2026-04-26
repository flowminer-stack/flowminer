import { mining as miningApi } from '@/api/client';
import type { EFGResponse } from '@/types';
import AnalysisLoading from '@/components/common/AnalysisLoading';
import ErrorState from '@/components/common/ErrorState';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

export default function EventuallyFollowsGraph({ eventLogId }: Props) {
  const { data, loading, error, retry, elapsedSec } = useAnalysisData<EFGResponse>(
    eventLogId, 'efg', miningApi.getEFG, 'Failed to load eventually-follows graph',
  );

  if (loading) return <AnalysisLoading elapsedSec={elapsedSec} label="Computing eventually-follows matrix…" />;
  if (error) return <ErrorState message={error} onRetry={retry} />;
  if (!data || data.activities.length === 0) return <p className="py-10 text-center text-[12px] text-fg-muted">No data available.</p>;

  const { activities, pairs } = data;
  const lookup = new Map<string, number>();
  let max = 0;
  for (const p of pairs) {
    lookup.set(`${p.source}||${p.target}`, p.frequency);
    if (p.frequency > max) max = p.frequency;
  }

  function cellBg(val: number): string {
    if (!val) return '';
    const t = val / max;
    const opacity = Math.round(t * 80 + 8);
    return `bg-accent/${opacity}`;
  }

  return (
    <div className="overflow-auto">
      <p className="mb-3 text-[11px] text-fg-muted">Which activities eventually follow each other (not just directly). High frequencies show strong sequential dependencies.</p>
      <div className="overflow-auto rounded-lg border border-line">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface-1">
              <th className="sticky left-0 z-10 bg-surface-1 px-3 py-2 text-left font-semibold text-fg-faint">Source ↓ / Target →</th>
              {activities.map((a) => (
                <th key={a} className="px-2 py-2 text-center font-medium text-fg-secondary whitespace-nowrap" title={a}>
                  {a.length > 10 ? a.slice(0, 10) + '…' : a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activities.map((src, ri) => (
              <tr key={src} className={ri % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                <td className="sticky left-0 z-10 border-r border-line bg-inherit px-3 py-1.5 font-medium text-fg-secondary whitespace-nowrap" title={src}>
                  {src.length > 14 ? src.slice(0, 14) + '…' : src}
                </td>
                {activities.map((tgt) => {
                  const val = lookup.get(`${src}||${tgt}`);
                  return (
                    <td key={tgt} className={`px-2 py-1.5 text-center ${val ? cellBg(val) : ''}`}>
                      {val !== undefined ? (
                        <span className="tabular-nums text-fg font-medium">{val.toLocaleString()}</span>
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
