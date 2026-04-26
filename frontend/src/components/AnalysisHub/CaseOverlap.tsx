import { mining as miningApi } from '@/api/client';
import { useAnalysisData } from '@/hooks/useAnalysisData';
import type { CaseOverlapResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface Props { eventLogId: string; }

export default function CaseOverlap({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<CaseOverlapResponse>(
    eventLogId, 'case_overlap', miningApi.getCaseOverlap, 'Failed to load case overlap',
  );

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data || !data.overlaps || data.overlaps.length === 0) return <p className="py-10 text-center text-[12px] text-fg-muted">No overlap data available.</p>;

  // Downsample to at most 300 points for performance
  const raw = data.overlaps;
  const step = Math.max(1, Math.floor(raw.length / 300));
  const chartData = raw
    .filter((_, i) => i % step === 0)
    .map((v, i) => ({ index: i * step, overlap: v }));

  return (
    <div className="space-y-4">
      <p className="mb-3 text-[11px] text-fg-muted">Number of cases being processed simultaneously over time. Peaks indicate high workload periods.</p>
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Max Concurrent Cases', value: data.max_overlap.toLocaleString() },
          { label: 'Avg Concurrent Cases', value: data.avg_overlap.toFixed(1) },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-surface-1 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{s.label}</p>
            <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div>
        <p className="mb-2 text-[11px] text-fg-faint">Number of concurrently active cases over time (time-sorted events).</p>
        <div className="h-48 rounded-lg border border-line bg-surface-1 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="overlapGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" strokeOpacity={0.5} />
              <XAxis dataKey="index" tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} tickLine={false} axisLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-line)', borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: 'var(--color-fg-muted)' }}
                itemStyle={{ color: 'var(--color-fg)' }}
                formatter={(v: number) => [v, 'Concurrent cases']}
              />
              <Area
                type="monotone"
                dataKey="overlap"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                fill="url(#overlapGrad)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
