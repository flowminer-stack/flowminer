import { useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
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
import { formatDuration } from '@/utils/format';
import type { OPeraPerformanceResponse } from '@/types';

// ─── OPerA Performance Panel ──────────────────────────────────────────────────

// Friendly metadata for the four OPerA timing metrics. Each metric is a column
// in the table and gets its own colour for the bar chart.
const OPERA_METRICS = [
  { key: 'flow_time', label: 'Flow', color: '#06b6d4', help: 'Total time from first to last object-token arrival at the activity' },
  { key: 'synchronization_time', label: 'Sync', color: '#8b5cf6', help: 'Time the activity waits for the last required object to become available' },
  { key: 'pooling_time', label: 'Pooling', color: '#f59e0b', help: 'Time pooling objects of a single type before the activity fires' },
  { key: 'lagging_time', label: 'Lagging', color: '#ef4444', help: 'Time an object waits because objects of other types lag behind' },
] as const;

export default function OPeraPerformancePanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<OPeraPerformanceResponse>(ocelId, 'opera_performance');
  const [data, setData] = useState<OPeraPerformanceResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OPeraPerformanceResponse>(ocelId, 'opera_performance');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    setUnavailable(null);
    ocel.getOPeraPerformance(ocelId)
      .then((d) => { setCached(ocelId, 'opera_performance', d); setData(d); })
      .catch((e) => {
        const status = e?.response?.status;
        const detail = e?.response?.data?.detail;
        // 501 = optional `ocpa` package not installed. Surface as an
        // informative empty state, not an error toast.
        if (status === 501) {
          setUnavailable(detail ?? 'OPerA metrics require the optional ocpa package.');
        } else {
          setError(detail ?? e.message ?? 'Request failed');
        }
      })
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Computing OPerA performance…" /></div>;

  if (unavailable) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
        <div className="rounded-lg bg-tint p-2.5 text-fg-muted">
          <PackageOpen size={22} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-fg">OPerA metrics unavailable</p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">{unavailable}</p>
        </div>
        <code className="rounded bg-tint px-2.5 py-1 text-[11px] text-fg-secondary">pip install ocpa</code>
      </div>
    );
  }

  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  const hasMetrics = data.activities.some((a) =>
    OPERA_METRICS.some(({ key }) => a[key] !== null && a[key] !== undefined),
  );

  if (data.activities.length === 0 || !hasMetrics) {
    return (
      <p className="py-6 text-center text-[12px] text-fg-muted">
        {data.note ?? 'No per-activity OPerA timing diagnostics were produced for this OCEL.'}
      </p>
    );
  }

  // Chart data: top activities by flow time (the headline metric).
  const chartData = [...data.activities]
    .sort((a, b) => (b.flow_time ?? 0) - (a.flow_time ?? 0))
    .slice(0, 12)
    .map((a) => ({
      activity: a.activity.length > 18 ? `${a.activity.slice(0, 17)}…` : a.activity,
      fullActivity: a.activity,
      flow_time: a.flow_time ?? 0,
      synchronization_time: a.synchronization_time ?? 0,
      pooling_time: a.pooling_time ?? 0,
      lagging_time: a.lagging_time ?? 0,
    }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-fg-muted">
        OPerA decomposes each activity&rsquo;s time into <b>flow</b>, <b>synchronization</b>, <b>pooling</b>,
        and <b>lagging</b> time — the object-centric analogue of the waiting/service split in a flat log.
      </p>

      <div>
        <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Timing by Activity (top {chartData.length} by flow time)</p>
        <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 34)}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 2, right: 12, bottom: 2, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatDuration(v)} />
            <YAxis type="category" dataKey="activity" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={110} />
            <Tooltip
              contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
              formatter={(v: number, name: string) => [formatDuration(v), name]}
              labelFormatter={(_l, payload) => payload?.[0]?.payload?.fullActivity ?? ''}
            />
            {OPERA_METRICS.map((m) => (
              <Bar key={m.key} dataKey={m.key} name={m.label} stackId="opera" fill={m.color} radius={[0, 0, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-3">
          {OPERA_METRICS.map((m) => (
            <div key={m.key} className="flex items-center gap-1.5" title={m.help}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="text-[10px] text-fg-muted">{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="border-b border-line pb-2 pr-4 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
                Activity
              </th>
              {OPERA_METRICS.map((m) => (
                <th
                  key={m.key}
                  className="border-b border-line pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
                  style={{ color: m.color }}
                  title={m.help}
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.activities.map((row) => (
              <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
                <td className="border-b border-line/40 py-1.5 pr-4 font-medium text-fg-secondary whitespace-nowrap">{row.activity}</td>
                {OPERA_METRICS.map((m) => {
                  const v = row[m.key];
                  return (
                    <td key={m.key} className="border-b border-line/40 py-1.5 px-2 text-right tabular-nums text-fg">
                      {v == null
                        ? <span className="text-[10px] text-fg-ghost">—</span>
                        : formatDuration(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.note && <p className="text-[10px] text-fg-faint">{data.note}</p>}
    </div>
  );
}
