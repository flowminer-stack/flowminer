import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Leaf, Zap, Droplets, DollarSign } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { analytics as analyticsApi } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';

export default function SustainabilityPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    analyticsApi
      .sustainability({ event_log_id: eventLogId })
      .then((r) => setData(r))
      .catch(() => setError('Failed to load sustainability metrics'))
      .finally(() => setLoading(false));
  }, [eventLogId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingSpinner size="lg" text="Computing emissions..." fullPage />;
  if (error) return <ErrorState message={error} onRetry={retry} />;
  if (!data || !data.totals) return <p className="py-10 text-center text-[12px] text-fg-muted">No data</p>;

  const { totals, by_activity, trend, high_impact } = data;
  const top10 = (by_activity || []).slice(0, 10);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sustainability / ESG"
        icon={Leaf}
        iconColor="text-success"
        backTo={-1}
        description="Estimated CO₂ emissions, energy consumption, and water usage derived from process activity durations. Identify high-impact activities and track trends over time."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          icon={<Leaf size={14} className="text-success" />}
          label="Total CO₂"
          value={`${totals.co2_kg.toFixed(2)} kg`}
          sub={`${totals.co2_per_case_g.toFixed(1)} g/case`}
        />
        <MetricCard
          icon={<Zap size={14} className="text-warning" />}
          label="Energy"
          value={`${totals.energy_kwh.toFixed(2)} kWh`}
        />
        <MetricCard
          icon={<Droplets size={14} className="text-accent" />}
          label="Water proxy"
          value={`${totals.water_l.toFixed(2)} L`}
        />
        <MetricCard
          icon={<DollarSign size={14} className="text-success" />}
          label="Energy cost"
          value={`$${totals.energy_cost.toFixed(2)}`}
        />
      </div>

      <div className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-fg">CO₂ by activity (top 10)</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={top10} margin={{ top: 4, right: 8, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" strokeOpacity={0.5} />
              <XAxis
                dataKey="activity"
                tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }}
                angle={-25}
                textAnchor="end"
                height={60}
              />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-line)',
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              <Bar dataKey="co2_g" fill="#10b981" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {trend && trend.length > 1 && (
        <div className="rounded-lg border border-line bg-surface-1 p-4">
          <h2 className="mb-3 text-[13px] font-semibold text-fg">CO₂ trend over time</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" strokeOpacity={0.5} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface-2)',
                    border: '1px solid var(--color-line)',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                />
                <Line type="monotone" dataKey="co2_g" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {high_impact && high_impact.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-1 p-4">
          <h2 className="mb-2 text-[13px] font-semibold text-fg">High-impact activities</h2>
          <p className="mb-3 text-[11px] text-fg-muted">
            These activities each contribute more than 10% of total emissions — primary targets for reduction.
          </p>
          <div className="space-y-1.5">
            {high_impact.map((a: any) => (
              <div key={a.activity} className="flex items-center justify-between rounded bg-tint/40 px-3 py-2">
                <span className="text-[12px] text-fg">{a.activity}</span>
                <span className="text-[11px] text-fg-muted">
                  {a.co2_g.toFixed(0)} g · {a.share_pct}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{label}</p>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{value}</p>
      {sub && <p className="text-[10px] text-fg-faint">{sub}</p>}
    </div>
  );
}
