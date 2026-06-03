import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
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
import type { OCELTemporalResponse } from '@/types';
import { CHART_COLORS } from './shared';

// ─── OCEL-Native: Temporal Summary ───────────────────────────────────────────

export default function TemporalSummaryPanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<OCELTemporalResponse>(ocelId, 'ocel_temporal');
  const [data, setData] = useState<OCELTemporalResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OCELTemporalResponse>(ocelId, 'ocel_temporal');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    ocel.getTemporalSummary(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_temporal', d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Computing temporal summary…" /></div>;
  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  const hasHourData = data.events_by_hour.some((h) => h.count > 0);
  const hasDayData = data.events_by_day.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {hasHourData && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Events by Hour of Day</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data.events_by_hour} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="hour" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}h`} />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                labelFormatter={(v) => `Hour ${v}:00`}
                formatter={(v: number) => [v.toLocaleString(), 'Events']}
              />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {hasDayData && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Events by Day</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data.events_by_day} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false}
                tickFormatter={(v: string) => v.slice(5)} /* MM-DD */
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                formatter={(v: number) => [v.toLocaleString(), 'Events']}
              />
              <Line type="monotone" dataKey="count" stroke={CHART_COLORS.secondary} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.activity_timeline.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Activity Timeline</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  {['Activity', 'Events', 'First Seen', 'Last Seen'].map((h) => (
                    <th key={h} className="border-b border-line pb-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activity_timeline.map((row) => (
                  <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
                    <td className="border-b border-line/40 py-1.5 px-3 font-medium text-fg-secondary">{row.activity}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 tabular-nums text-fg">{row.event_count.toLocaleString()}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted">{row.first_seen.slice(0, 10)}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted">{row.last_seen.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!hasHourData && !hasDayData && data.activity_timeline.length === 0 && (
        <p className="text-[12px] text-fg-muted py-4 text-center">No temporal data available.</p>
      )}
    </div>
  );
}
