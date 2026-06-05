import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, HeartPulse, Clock, ShieldCheck, Repeat, Gauge, TrendingUp } from 'lucide-react';
import {
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import { mining } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import type { ConformanceResponse, ReworkResponse, ProcessStatistics } from '@/types';
import { formatDuration, formatNumber } from '@/utils/format';

/* ── Process Health Score Ring + KPI Command Bar ──────────────────────────
 *
 * One number a CEO grasps in three seconds. A composite 0-100 health score
 * (weighted conformance + SLA + flow consistency + rework) rendered as a
 * multi-ring radial gauge, above a command bar of KPI tiles that go amber/
 * red when a dimension slips. Every input is an existing endpoint; the score
 * is a pure frontend roll-up with graceful degradation — a dimension whose
 * endpoint fails is dropped and its weight redistributed.
 */

type Band = 'good' | 'warn' | 'bad';
function band(score0to100: number): Band {
  return score0to100 >= 80 ? 'good' : score0to100 >= 60 ? 'warn' : 'bad';
}
const BAND_COLOR: Record<Band, string> = {
  good: '#10b981', // emerald
  warn: '#f59e0b', // amber
  bad: '#f43f5e', // rose
};
const BAND_LABEL: Record<Band, string> = { good: 'Healthy', warn: 'Needs attention', bad: 'At risk' };

interface Dimension {
  key: string;
  label: string;
  weight: number;
  value: number | null; // 0..1, higher = healthier; null = unavailable
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return null;
  const w = 84;
  const h = 24;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Tile {
  label: string;
  value: string;
  icon: typeof Activity;
  band?: Band;
  spark?: number[];
}

export default function ProcessHealthPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  const [conf, setConf] = useState<ConformanceResponse | null>(null);
  const [rework, setRework] = useState<ReworkResponse | null>(null);
  const [stats, setStats] = useState<ProcessStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventLogId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.allSettled([
      mining.getConformance(eventLogId),
      mining.getRework(eventLogId),
      mining.getStatistics(eventLogId),
    ]).then((results) => {
      if (cancelled) return;
      const [c, r, s] = results;
      if (c.status === 'fulfilled') setConf(c.value);
      if (r.status === 'fulfilled') setRework(r.value);
      if (s.status === 'fulfilled') setStats(s.value);
      // Only a hard error if EVERYTHING failed.
      if (results.every((x) => x.status === 'rejected')) {
        setError('Could not load any health signals for this log.');
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  const dimensions = useMemo<Dimension[]>(() => {
    const flowConsistency =
      stats && stats.avg_case_duration > 0
        ? Math.max(0, Math.min(1, stats.median_case_duration / stats.avg_case_duration))
        : null;
    return [
      { key: 'conformance', label: 'Conformance', weight: 0.3, value: conf ? clamp01(conf.fitness) : null },
      { key: 'sla', label: 'SLA adherence', weight: 0.3, value: stats?.sla_compliance != null ? clamp01(stats.sla_compliance) : null },
      { key: 'flow', label: 'Flow consistency', weight: 0.2, value: flowConsistency },
      { key: 'rework', label: 'Rework-free', weight: 0.2, value: rework ? clamp01(1 - rework.overall_rework_rate) : null },
    ];
  }, [conf, rework, stats]);

  const score = useMemo(() => {
    const avail = dimensions.filter((d) => d.value != null);
    if (avail.length === 0) return null;
    const wsum = avail.reduce((s, d) => s + d.weight, 0);
    const val = avail.reduce((s, d) => s + d.weight * (d.value as number), 0) / wsum;
    return Math.round(val * 100);
  }, [dimensions]);

  const tiles = useMemo<Tile[]>(() => {
    const throughput = (stats?.cases_over_time ?? []).map((p) => p.count);
    const t: Tile[] = [];
    if (stats) {
      t.push({ label: 'Cases', value: formatNumber(stats.total_cases), icon: Activity });
      t.push({ label: 'Avg cycle time', value: formatDuration(stats.avg_case_duration), icon: Clock });
      t.push({ label: 'Throughput', value: `${formatNumber(throughput.at(-1) ?? 0)}/period`, icon: TrendingUp, spark: throughput });
    }
    if (conf) {
      const pct = Math.round(conf.fitness * 100);
      t.push({ label: 'Conformance', value: `${pct}%`, icon: ShieldCheck, band: band(pct) });
    }
    if (stats?.sla_compliance != null) {
      const pct = Math.round(stats.sla_compliance * 100);
      t.push({ label: 'SLA', value: `${pct}%`, icon: Gauge, band: band(pct) });
    }
    if (rework) {
      const pct = Math.round(rework.overall_rework_rate * 100);
      t.push({ label: 'Rework', value: `${pct}%`, icon: Repeat, band: band(100 - pct) });
    }
    return t;
  }, [stats, conf, rework]);

  if (loading) {
    return <LoadingSpinner size="lg" text="Computing process health…" fullPage />;
  }
  if (error || score == null) {
    return <ErrorState message={error ?? 'No health signals available.'} onRetry={() => window.location.reload()} />;
  }

  const b = band(score);
  const ringData = dimensions
    .filter((d) => d.value != null)
    .map((d) => ({
      name: d.label,
      value: Math.round((d.value as number) * 100),
      fill: BAND_COLOR[band((d.value as number) * 100)],
    }));

  return (
    <div>
      <PageHeader
        title="Process Health"
        icon={HeartPulse}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="A single composite score for how well this process is running right now — conformance, SLA, flow consistency, and rework rolled into one number, with the dimensions broken out."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      {/* KPI command bar */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.label} className="card p-3">
            <div className="flex items-center gap-1.5 text-fg-muted">
              <tile.icon size={13} className={tile.band ? bandText(tile.band) : 'text-accent'} />
              <span className="text-[10px] font-semibold uppercase tracking-wider">{tile.label}</span>
            </div>
            <div className="mt-1.5 flex items-end justify-between gap-1">
              <span className={`text-xl font-bold tabular-nums ${tile.band ? bandText(tile.band) : 'text-fg'}`}>
                {tile.value}
              </span>
              {tile.spark && <Sparkline points={tile.spark} color="rgb(var(--c-accent))" />}
            </div>
          </div>
        ))}
      </div>

      {/* Health ring + dimension breakdown */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card relative flex flex-col items-center justify-center p-6 lg:col-span-1">
          <div className="relative h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                innerRadius="42%"
                outerRadius="100%"
                data={ringData}
                startAngle={90}
                endAngle={-270}
                barSize={12}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar background dataKey="value" cornerRadius={6} angleAxisId={0} />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-5xl font-bold tabular-nums" style={{ color: BAND_COLOR[b] }}>
                {score}
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">/ 100</span>
              <span className="mt-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: BAND_COLOR[b], backgroundColor: BAND_COLOR[b] + '1a' }}>
                {BAND_LABEL[b]}
              </span>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-fg-faint">Composite process health score</p>
        </div>

        <div className="card p-5 lg:col-span-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Dimension breakdown</p>
          <div className="mt-4 space-y-4">
            {dimensions.map((d) => {
              const pct = d.value == null ? null : Math.round(d.value * 100);
              const db = pct == null ? null : band(pct);
              return (
                <div key={d.key}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-medium text-fg">{d.label}</span>
                    {pct == null ? (
                      <span className="text-fg-faint">unavailable</span>
                    ) : (
                      <span className="font-semibold tabular-nums" style={{ color: BAND_COLOR[db as Band] }}>{pct}%</span>
                    )}
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-tint">
                    {pct != null && (
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: BAND_COLOR[db as Band] }}
                      />
                    )}
                  </div>
                  <p className="mt-1 text-[10px] text-fg-faint">weight {Math.round(d.weight * 100)}%</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function bandText(b: Band): string {
  return b === 'good' ? 'text-success' : b === 'warn' ? 'text-warning' : 'text-danger';
}
