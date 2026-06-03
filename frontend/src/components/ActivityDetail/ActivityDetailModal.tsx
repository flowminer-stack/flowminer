import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import {
  Activity,
  Clock,
  ArrowLeft,
  ArrowRight,
  Hash,
  Users,
  Play,
  Flag,
} from 'lucide-react';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { mining } from '@/api/client';
import { formatDuration } from '@/utils/format';
import type { ActivityDetailResponse } from '@/types';

interface ActivityDetailModalProps {
  eventLogId: string;
  activityName: string;
  isOpen: boolean;
  onClose: () => void;
}

function StatPill({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface-1 px-4 py-3 text-center">
      <Icon size={14} className="text-fg-faint" />
      <span className="text-[15px] font-bold tabular-nums text-fg">{value}</span>
      <span className="text-[10px] text-fg-faint uppercase tracking-wide">{label}</span>
    </div>
  );
}

function FreqBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-28 shrink-0 truncate text-fg-secondary" title={label}>{label}</span>
      <div className="flex-1 rounded-full bg-surface-1 overflow-hidden" style={{ height: 6 }}>
        <div
          className="h-full rounded-full bg-accent/60 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-fg-muted">{value.toLocaleString()}</span>
    </div>
  );
}

export default function ActivityDetailModal({
  eventLogId,
  activityName,
  isOpen,
  onClose,
}: ActivityDetailModalProps) {
  const [data, setData] = useState<ActivityDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !activityName || !eventLogId) return;
    setLoading(true);
    setError(null);
    setData(null);
    mining
      .getActivityDetail(eventLogId, activityName)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load activity details'))
      .finally(() => setLoading(false));
  }, [isOpen, eventLogId, activityName]);

  const histogramData =
    data?.duration_histogram.map((bin, i) => ({
      name: `${i + 1}`,
      count: bin.count,
      label: `${formatDuration(bin.bin_start)} – ${formatDuration(bin.bin_end)}`,
    })) ?? [];

  const maxResourceCount = data
    ? Math.max(...data.resources.map((r) => r.count), 1)
    : 1;
  const maxPredFreq = data
    ? Math.max(...data.predecessors.map((p) => p.frequency), 1)
    : 1;
  const maxSuccFreq = data
    ? Math.max(...data.successors.map((s) => s.frequency), 1)
    : 1;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      {/* Custom header (not using Modal's title prop so we can add badges) */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-2 min-w-0">
          <Activity size={18} className="shrink-0 text-accent" />
          <h2 className="text-[15px] font-bold text-fg truncate">{activityName}</h2>
          {data && (
            <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
              {data.frequency.toLocaleString()} events
            </span>
          )}
        </div>
        <div className="ml-3 flex shrink-0 gap-1">
          {data?.is_start && (
            <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
              <Play size={10} />
              Start
            </span>
          )}
          {data?.is_end && (
            <span className="flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
              <Flag size={10} />
              End
            </span>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="md" text="Loading activity details..." />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-line bg-surface-1 p-8 text-center">
          <p className="text-[13px] text-fg-muted">{error}</p>
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* Duration stats */}
          <div>
            <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
              <Clock size={13} />
              Duration
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatPill label="Avg" value={data.avg_duration == null ? '—' : formatDuration(data.avg_duration)} icon={Clock} />
              <StatPill label="Median" value={data.median_duration == null ? '—' : formatDuration(data.median_duration)} icon={Clock} />
              <StatPill label="Min" value={data.min_duration == null ? '—' : formatDuration(data.min_duration)} icon={Clock} />
              <StatPill label="Max" value={data.max_duration == null ? '—' : formatDuration(data.max_duration)} icon={Clock} />
            </div>
          </div>

          {/* Duration histogram */}
          {histogramData.length > 0 && (
            <div>
              <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                Duration Distribution
              </h3>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={histogramData} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="name"
                      fontSize={10}
                      tick={{ fill: 'var(--chart-tick)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      fontSize={10}
                      tick={{ fill: 'var(--chart-tick)' }}
                      axisLine={false}
                      tickLine={false}
                      width={32}
                    />
                    <Tooltip
                      formatter={(v: number) => [v.toLocaleString(), 'Cases']}
                      labelFormatter={(_: string, payload) =>
                        payload?.[0]?.payload?.label ?? ''
                      }
                      contentStyle={{
                        borderRadius: '8px',
                        border: '1px solid var(--chart-tooltip-border)',
                        fontSize: '11px',
                        backgroundColor: 'var(--chart-tooltip-bg)',
                        color: 'var(--chart-tooltip-text)',
                      }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {histogramData.map((_, i) => (
                        <Cell key={i} fill="#6ea8d8" fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Two-column: Resources + Flow Context */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {/* Resources */}
            {data.resources.length > 0 && (
              <div>
                <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                  <Users size={13} />
                  Resources
                </h3>
                <div className="space-y-2">
                  {data.resources.slice(0, 8).map((r) => (
                    <FreqBar
                      key={r.name}
                      label={r.name}
                      value={r.count}
                      max={maxResourceCount}
                    />
                  ))}
                  {data.resources.length > 8 && (
                    <p className="text-[11px] text-fg-faint">
                      +{data.resources.length - 8} more
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Cases */}
            <div>
              <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                <Hash size={13} />
                Cases
              </h3>
              <div className="rounded-lg border border-line bg-surface-1 p-3 text-center">
                <p className="text-2xl font-bold tabular-nums text-fg">
                  {data.case_count.toLocaleString()}
                </p>
                <p className="text-[11px] text-fg-muted mt-0.5">cases involve this activity</p>
              </div>
            </div>
          </div>

          {/* Flow context */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {/* Predecessors */}
            <div>
              <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                <ArrowLeft size={13} />
                Predecessors
              </h3>
              {data.predecessors.length > 0 ? (
                <div className="space-y-2">
                  {data.predecessors.slice(0, 6).map((p) => (
                    <FreqBar
                      key={p.activity}
                      label={p.activity}
                      value={p.frequency}
                      max={maxPredFreq}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-fg-faint">No predecessors (start activity)</p>
              )}
            </div>

            {/* Successors */}
            <div>
              <h3 className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-muted">
                <ArrowRight size={13} />
                Successors
              </h3>
              {data.successors.length > 0 ? (
                <div className="space-y-2">
                  {data.successors.slice(0, 6).map((s) => (
                    <FreqBar
                      key={s.activity}
                      label={s.activity}
                      value={s.frequency}
                      max={maxSuccFreq}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-fg-faint">No successors (end activity)</p>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
