import { useEffect, useState } from 'react';
import { ArrowRight, Clock, Percent, X, Filter, Ban, Hash } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { mining } from '@/api/client';
import type { EdgeStatsResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';

interface EdgeDetailModalProps {
  eventLogId: string;
  source: string;
  target: string;
  open: boolean;
  onClose: () => void;
  onFilterWith: () => void;
  onFilterWithout: () => void;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export default function EdgeDetailModal({
  eventLogId,
  source,
  target,
  open,
  onClose,
  onFilterWith,
  onFilterWithout,
}: EdgeDetailModalProps) {
  const [data, setData] = useState<EdgeStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !eventLogId || !source || !target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    mining
      .getEdgeStats(eventLogId, source, target)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load edge stats');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventLogId, source, target]);

  if (!open) return null;

  const chartData =
    data?.histogram.map((b) => ({
      name: formatDuration((b.bin_start + b.bin_end) / 2),
      count: b.count,
      rangeLabel: `${formatDuration(b.bin_start)} – ${formatDuration(b.bin_end)}`,
    })) ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-2xl animate-slide-up overflow-hidden rounded-2xl border border-line bg-surface-2"
        style={{ boxShadow: 'var(--shadow-xl)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-fg-faint">
              {data?.is_eventually_follows
                ? 'Eventually-follows transition'
                : 'Directly-follows transition'}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-tint px-2 py-1 text-[12px] font-semibold text-fg-secondary">
                {source}
              </span>
              <ArrowRight size={14} className="text-fg-faint" />
              <span className="rounded-md bg-tint px-2 py-1 text-[12px] font-semibold text-fg-secondary">
                {target}
              </span>
              {data?.is_eventually_follows && (
                <span
                  className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning"
                  title="Numbers are computed from cases where source eventually precedes target — no direct log transitions were found (typical of inductive / heuristic miner output)"
                >
                  eventually-follows
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">
          {loading && <LoadingSpinner text="Computing edge statistics…" />}
          {error && <ErrorState message={error} />}
          {data && !loading && !error && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard
                  icon={Hash}
                  label="Traversals"
                  value={data.frequency.toLocaleString()}
                />
                <StatCard
                  icon={Percent}
                  label="Case coverage"
                  value={`${data.coverage_pct.toFixed(1)}%`}
                  sub={`${data.case_count_with.toLocaleString()} cases`}
                />
                <StatCard
                  icon={Clock}
                  label="Avg time"
                  value={formatDuration(data.avg_duration)}
                  sub={`median ${formatDuration(data.median_duration)}`}
                />
                <StatCard
                  icon={Clock}
                  label="p95 time"
                  value={formatDuration(data.p95_duration)}
                  sub={`max ${formatDuration(data.max_duration)}`}
                />
              </div>

              {/* Histogram */}
              {chartData.length > 0 && data.frequency > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Transition time distribution
                  </p>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--chart-grid)"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="name"
                          fontSize={10}
                          tick={{ fill: 'var(--chart-tick)' }}
                          interval={Math.max(0, Math.floor(chartData.length / 6) - 1)}
                        />
                        <YAxis
                          fontSize={10}
                          tick={{ fill: 'var(--chart-tick)' }}
                          allowDecimals={false}
                        />
                        <Tooltip
                          contentStyle={{
                            borderRadius: '8px',
                            border: '1px solid var(--chart-tooltip-border)',
                            backgroundColor: 'var(--chart-tooltip-bg)',
                            color: 'var(--chart-tooltip-text)',
                            fontSize: '12px',
                          }}
                          formatter={(value: number) => [
                            `${value} cases`,
                            'Count',
                          ]}
                          labelFormatter={(_label: string, payload: any) =>
                            payload?.[0]?.payload?.rangeLabel ?? ''
                          }
                        />
                        <Bar
                          dataKey="count"
                          fill="rgb(var(--c-accent))"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {data.frequency === 0 && (
                <div className="mt-5 rounded-lg border border-line bg-surface-1 p-4 text-center">
                  <p className="text-[12px] font-semibold text-fg">
                    No traversals found for this pair
                  </p>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    The edge exists in the discovered model but the log
                    has no cases where{' '}
                    <span className="font-mono text-fg-secondary">{source}</span>{' '}
                    precedes{' '}
                    <span className="font-mono text-fg-secondary">{target}</span>.
                    This is usually a silent / routing transition emitted
                    by the inductive miner — try the heuristic or DFG
                    algorithm to see only edges that appear in the log.
                  </p>
                </div>
              )}
              {data.is_eventually_follows && data.frequency > 0 && (
                <p className="mt-4 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
                  No <span className="font-semibold">direct</span>{' '}
                  <code>
                    {source}→{target}
                  </code>{' '}
                  transitions found. Numbers above are computed from
                  cases where <code>{source}</code> eventually precedes{' '}
                  <code>{target}</code> — typical for edges that come
                  from an inductive / heuristic miner's control-flow
                  abstraction rather than the DFG.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer: filter actions */}
        {data && !loading && !error && data.frequency > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-1/50 px-5 py-3">
            <button
              onClick={() => {
                onFilterWithout();
                onClose();
              }}
              className="btn-secondary text-[12px]"
              title={`Hide cases that contain this edge (${data.case_count_without.toLocaleString()} remain)`}
            >
              <Ban size={13} />
              Filter to cases without this edge ({data.case_count_without.toLocaleString()})
            </button>
            <button
              onClick={() => {
                onFilterWith();
                onClose();
              }}
              className="btn-primary text-[12px]"
              title={`Keep only cases that contain this edge (${data.case_count_with.toLocaleString()} remain)`}
            >
              <Filter size={13} />
              Filter to cases with this edge ({data.case_count_with.toLocaleString()})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Hash;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="text-fg-faint" />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {label}
        </p>
      </div>
      <p className="mt-1 text-[16px] font-bold tabular-nums text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-fg-faint">{sub}</p>}
    </div>
  );
}
