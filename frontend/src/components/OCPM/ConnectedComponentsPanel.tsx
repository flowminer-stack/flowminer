import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ocel } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';
import type { ConnectedComponentsResponse } from '@/types';
import { CHART_COLORS } from './shared';

// ─── OCEL-Native: Connected Components ───────────────────────────────────────

export default function ConnectedComponentsPanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<ConnectedComponentsResponse>(ocelId, 'ocel_components');
  const [data, setData] = useState<ConnectedComponentsResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<ConnectedComponentsResponse>(ocelId, 'ocel_components');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    ocel.getConnectedComponents(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_components', d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Analyzing graph components…" /></div>;
  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Components', value: data.total_components.toLocaleString() },
          { label: 'Largest', value: data.largest_component_size.toLocaleString() },
          { label: 'Avg Size', value: data.avg_component_size.toFixed(1) },
          { label: 'Size Buckets', value: data.size_distribution.length },
        ].map((card) => (
          <div key={card.label} className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
            <p className="text-[18px] font-bold tabular-nums text-fg leading-none">{card.value}</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">{card.label}</p>
          </div>
        ))}
      </div>

      {data.size_distribution.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Component Size Distribution</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={data.size_distribution.slice(0, 40)}
              margin={{ top: 2, right: 8, bottom: 2, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="size" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} label={{ value: 'Component size (nodes)', position: 'insideBottom', offset: -2, fontSize: 9, fill: tickColor }} />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={36} label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 6, fontSize: 9, fill: tickColor }} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                labelFormatter={(v) => `Size ${v}`}
                formatter={(v: number) => [v.toLocaleString(), 'Components']}
              />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {data.size_distribution.length > 40 && (
            <p className="mt-1 text-[10px] text-fg-faint">Showing first 40 of {data.size_distribution.length} size buckets.</p>
          )}
        </div>
      )}
    </div>
  );
}
