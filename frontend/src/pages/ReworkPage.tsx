import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Repeat, RefreshCw, IterationCw, Target } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import FilterScopeNotice from '@/components/common/FilterScopeNotice';
import HintTooltip from '@/components/common/Tooltip';
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
import { type ColumnDef } from '@tanstack/react-table';
import { useEventLogData } from '@/hooks/useProcessMining';
import { mining } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import DataTable from '@/components/common/DataTable';
import type { ReworkResponse, ActivityRework } from '@/types';
import { getCached, setCached } from '@/store/analysisCache';

function pct(v: number): string {
  return v.toFixed(1) + '%';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 shadow-xl text-[11px]">
      <p className="font-semibold text-fg mb-1">{label}</p>
      <p className="text-fg-muted">Rework Rate: <span className="text-fg-secondary">{pct(payload[0]?.value ?? 0)}</span></p>
    </div>
  );
}

function buildTableColumns(
  onTrack: (row: ActivityRework) => void,
): ColumnDef<ActivityRework, unknown>[] {
  return [
    {
      accessorKey: 'activity',
      header: 'Activity',
      cell: (info) => (
        <span className="font-medium text-fg">{info.getValue() as string}</span>
      ),
    },
    {
      accessorKey: 'total_occurrences',
      header: 'Total Occurrences',
      cell: (info) => (info.getValue() as number).toLocaleString(),
    },
    {
      accessorKey: 'cases_with_rework',
      header: 'Cases w/ Rework',
      cell: (info) => (info.getValue() as number).toLocaleString(),
    },
    {
      accessorKey: 'rework_rate',
      header: () => (
        <HintTooltip text="Percentage of cases where this activity occurs more than once">
          Rework Rate
        </HintTooltip>
      ),
      cell: (info) => {
        const v = info.getValue() as number;
        let color = 'text-fg-secondary';
        if (v >= 30) color = 'text-danger';
        else if (v >= 15) color = 'text-warning';
        return <span className={color + ' font-medium'}>{pct(v)}</span>;
      },
    },
    {
      accessorKey: 'avg_repetitions',
      header: 'Avg Repetitions',
      cell: (info) => (info.getValue() as number).toFixed(2),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <button
          onClick={() => onTrack(row.original)}
          className="btn-ghost text-[11px]"
          title="Create an Initiative to track progress reducing this rework"
        >
          <Target size={11} />
          Track
        </button>
      ),
    },
  ];
}

export default function ReworkPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();
  const { eventLog } = useEventLogData(eventLogId);

  const trackAsInitiative = useCallback(
    (row: ActivityRework) => {
      if (!eventLog?.project_id) return;
      navigate(`/initiatives/${eventLog.project_id}`, {
        state: {
          prefill: {
            name: `Reduce rework on "${row.activity}"`,
            description: `Activity "${row.activity}" is reworked in ${row.cases_with_rework.toLocaleString()} cases (${row.rework_rate.toFixed(1)}% rate).`,
            metric: 'rework_rate',
            unit: '%',
            baseline_value: row.rework_rate,
            target_value: Math.max(0, row.rework_rate / 2),
            event_log_id: eventLogId,
          },
        },
      });
    },
    [eventLog?.project_id, eventLogId, navigate],
  );

  const tableColumns = useMemo(() => buildTableColumns(trackAsInitiative), [trackAsInitiative]);

  const cached = eventLogId ? getCached<ReworkResponse>(eventLogId, 'rework') : null;
  const [data, setData] = useState<ReworkResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!eventLogId) return;
    if (retryCount === 0) {
      const existing = getCached<ReworkResponse>(eventLogId, 'rework');
      if (existing) { setData(existing); setLoading(false); return; }
    }
    setLoading(true);
    setError(null);
    mining
      .getRework(eventLogId)
      .then((d) => { setCached(eventLogId, 'rework', d); setData(d); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load rework data'))
      .finally(() => setLoading(false));
  }, [eventLogId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const chartData = useMemo(() => {
    if (!data) return [];
    return [...data.activities]
      .sort((a, b) => b.rework_rate - a.rework_rate)
      .slice(0, 15)
      .map((act) => ({
        name: act.activity.length > 20 ? act.activity.slice(0, 20) + '…' : act.activity,
        fullName: act.activity,
        rework_rate: act.rework_rate,
      }));
  }, [data]);

  const tableData = useMemo(() => {
    if (!data) return [];
    return [...data.activities].sort((a, b) => b.rework_rate - a.rework_rate);
  }, [data]);

  if (loading) {
    return <LoadingSpinner size="lg" text="Analyzing rework patterns..." fullPage />;
  }

  return (
    <div>
      <PageHeader
        title="Rework Analysis"
        icon={Repeat}
        backTo={-1}
        description="Activities repeated within the same case. Rework often indicates errors, rejections, or quality issues."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      <FilterScopeNotice eventLogId={eventLogId} />

      {error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : data ? (
        <>
          {/* Stat cards */}
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-danger/10 p-2">
                  <RefreshCw size={18} className="text-danger" />
                </div>
                <div>
                  <p className="text-xl font-bold tabular-nums text-fg">
                    {pct(data.overall_rework_rate)}
                  </p>
                  <p className="text-[12px] text-fg-muted">Overall Rework Rate</p>
                </div>
              </div>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-warning/10 p-2">
                  <Repeat size={18} className="text-warning" />
                </div>
                <div>
                  <p className="text-xl font-bold tabular-nums text-fg">
                    {data.cases_with_rework.toLocaleString()}
                    <span className="ml-1 text-[13px] font-normal text-fg-muted">
                      / {data.total_cases.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-[12px] text-fg-muted">Cases with Rework</p>
                </div>
              </div>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-accent/10 p-2">
                  <IterationCw size={18} className="text-accent" />
                </div>
                <div>
                  <p className="text-xl font-bold tabular-nums text-fg">
                    {data.self_loops.length}
                  </p>
                  <p className="text-[12px] text-fg-muted">Self-Loops Detected</p>
                </div>
              </div>
            </div>
          </div>

          {/* Bar chart */}
          {chartData.length > 0 && (
            <div className="card mt-6 p-5">
              <h2 className="text-[14px] font-semibold text-fg">Activities by Rework Rate</h2>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      type="number"
                      tickFormatter={(v) => pct(v)}
                      fontSize={11}
                      tick={{ fill: 'var(--chart-tick)' }}
                      domain={[0, 1]}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={140}
                      fontSize={11}
                      tick={{ fill: 'var(--chart-tick)' }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="rework_rate" radius={[0, 4, 4, 0]}>
                      {chartData.map((entry, i) => {
                        const v = entry.rework_rate;
                        const color =
                          v >= 0.3 ? '#f43f5e' : v >= 0.15 ? '#f59e0b' : '#6ea8d8';
                        return <Cell key={i} fill={color} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Activity rework table */}
          <div className="mt-6">
            <h2 className="mb-4 text-[14px] font-semibold text-fg">Activity Rework Details</h2>
            <DataTable
              data={tableData}
              columns={tableColumns}
              searchable
              searchPlaceholder="Search activities..."
              paginated
              pageSize={10}
            />
          </div>

          {/* Self-loops section */}
          {data.self_loops.length > 0 && (
            <div className="mt-8">
              <h2 className="text-[14px] font-semibold text-fg mb-4">
                <HintTooltip text="An activity immediately followed by the same activity — may indicate retries or corrections">
                  Self-Loops
                </HintTooltip>
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.self_loops
                  .sort((a, b) => b.count - a.count)
                  .map((sl) => (
                    <div
                      key={sl.activity}
                      className="flex items-center justify-between rounded-lg border border-line bg-surface-1 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <IterationCw size={14} className="shrink-0 text-accent" />
                        <span className="truncate text-[12px] text-fg-secondary">{sl.activity}</span>
                      </div>
                      <span className="ml-3 shrink-0 rounded-full bg-tint px-2 py-0.5 text-[11px] font-semibold text-fg">
                        {sl.count.toLocaleString()}×
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
