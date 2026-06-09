import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, BarChart3, ArrowRight, Search, X, Activity, Target, ChevronDown, ChevronUp, FlaskConical, ShieldAlert, Gauge } from 'lucide-react';
import type { DBSMScore } from '@/types';
import ExplainButton from '@/components/AI/ExplainButton';
import HintTooltip from '@/components/common/Tooltip';
import clsx from 'clsx';
import ExportButtons from '@/components/common/ExportButtons';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import RelatedAnalyses from '@/components/common/RelatedAnalyses';
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
import { useMiningStore } from '@/store';
import { useEventLogData, useQueueAnalysis } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import { WhatIfSlider, AutomationCandidates } from '@/components/Bottlenecks/WhatIfAndAutomation';
import CaseGantt from '@/components/CaseExplorer/CaseGantt';
import { formatDuration } from '@/utils/format';

const severityColors = {
  low: { bg: 'bg-tint', text: 'text-fg-secondary', badge: 'badge-slate', bar: '#94a3b8' },
  medium: { bg: 'bg-warning/10', text: 'text-warning', badge: 'badge-amber', bar: '#f59e0b' },
  high: { bg: 'bg-danger/10', text: 'text-danger', badge: 'badge-rose', bar: '#f43f5e' },
  critical: { bg: 'bg-danger/10', text: 'text-danger', badge: 'badge-rose', bar: '#e11d48' },
};

export default function BottlenecksPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();

  const { eventLog } = useEventLogData(eventLogId);

  const trackBottleneckAsInitiative = (activity: string, avgDuration: number, medianDuration: number) => {
    if (!eventLog?.project_id) return;
    navigate(`/initiatives/${eventLog.project_id}`, {
      state: {
        prefill: {
          name: `Reduce time at "${activity}"`,
          description: `Activity "${activity}" currently averages ${formatDuration(avgDuration)} (median ${formatDuration(medianDuration)}).`,
          metric: 'avg_case_duration',
          unit: 'seconds',
          baseline_value: avgDuration,
          target_value: medianDuration,
          event_log_id: eventLogId,
        },
      },
    });
  };
  const { bottlenecks, bottlenecksLoading, error, fetchBottlenecks } = useMiningStore();
  const { data: queueData, loading: queueLoading } = useQueueAnalysis(eventLogId);
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [dbsmSort, setDbsmSort] = useState<'desc' | 'asc' | null>(null);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (eventLogId) {
      fetchBottlenecks(eventLogId);
    }
  }, [eventLogId, fetchBottlenecks]);

  // Deep-link focus: ?activity=<name> (e.g. from a process-map node's "Explain"
  // chip) pre-filters the list to that activity.
  useEffect(() => {
    const activity = searchParams.get('activity');
    if (activity) setSearch(activity);
  }, [searchParams]);

  const bottleneckItems = bottlenecks?.bottlenecks ?? [];
  const waitingTimes = bottlenecks?.waiting_times ?? [];
  const criticalBottlenecks = bottleneckItems.filter((b) => b.is_bottleneck);

  const dbsmByActivity = useMemo<Map<string, DBSMScore>>(() => {
    const map = new Map<string, DBSMScore>();
    (bottlenecks?.dbsm_scores ?? []).forEach((s) => map.set(s.activity, s));
    return map;
  }, [bottlenecks?.dbsm_scores]);

  // Top-10 activities by avg duration — only these get the Explain button.
  const top10Activities = useMemo(
    () =>
      new Set(
        [...bottleneckItems]
          .sort((a, b) => b.avg_duration - a.avg_duration)
          .slice(0, 10)
          .map((b) => b.activity),
      ),
    [bottleneckItems],
  );

  const filteredItems = useMemo(() => {
    const filtered = bottleneckItems.filter((b) => {
      const matchesSearch = !search || b.activity.toLowerCase().includes(search.toLowerCase());
      const matchesSeverity = severityFilter === 'all' || b.severity === severityFilter;
      return matchesSearch && matchesSeverity;
    });
    if (dbsmSort !== null) {
      filtered.sort((a, b) => {
        const scoreA = dbsmByActivity.get(a.activity)?.dbsm_score ?? -1;
        const scoreB = dbsmByActivity.get(b.activity)?.dbsm_score ?? -1;
        return dbsmSort === 'desc' ? scoreB - scoreA : scoreA - scoreB;
      });
    }
    return filtered;
  }, [bottleneckItems, search, severityFilter, dbsmSort, dbsmByActivity]);

  if (bottlenecksLoading) {
    return (
      <LoadingSpinner size="lg" text="Analyzing bottlenecks..." fullPage />
    );
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => eventLogId && fetchBottlenecks(eventLogId)}
      />
    );
  }

  const chartData = bottleneckItems
    .sort((a, b) => b.avg_duration - a.avg_duration)
    .slice(0, 10)
    .map((b) => ({
      name: b.activity.length > 15 ? b.activity.slice(0, 15) + '...' : b.activity,
      fullName: b.activity,
      duration: b.avg_duration,
      severity: b.severity,
    }));

  return (
    <div>
      <PageHeader
        title="Bottleneck Analysis"
        icon={Activity}
        backTo={-1}
        description="Activities that take the longest and slow down your process. Focus on critical-severity items for the biggest impact."
        subtitle={
          <>
            {eventLog?.name ?? 'Event Log'} &mdash; {criticalBottlenecks.length}{' '}
            bottleneck{criticalBottlenecks.length !== 1 ? 's' : ''} detected
          </>
        }
        actions={eventLogId && <ExportButtons eventLogId={eventLogId} analysis="bottlenecks" />}
      />

      {/* Summary cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-danger/10 p-2">
              <AlertTriangle size={18} className="text-danger" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {criticalBottlenecks.length}
              </p>
              <p className="text-[12px] text-fg-muted">Bottlenecks</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-accent/10 p-2">
              <BarChart3 size={18} className="text-accent" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {bottleneckItems.length}
              </p>
              <p className="text-[12px] text-fg-muted">Activities Analyzed</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-warning/10 p-2">
              <Clock size={18} className="text-warning" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {waitingTimes.length}
              </p>
              <p className="text-[12px] text-fg-muted">Waiting Transitions</p>
            </div>
          </div>
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="card mt-6 p-5">
          <h2 className="text-[14px] font-semibold text-fg">
            Activity Duration (Top 10)
          </h2>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis
                  type="number"
                  tickFormatter={(v) => formatDuration(v)}
                  fontSize={12}
                  tick={{ fill: 'var(--chart-tick)' }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  fontSize={12}
                  tick={{ fill: 'var(--chart-tick)' }}
                />
                <Tooltip
                  formatter={(value: number) => [
                    formatDuration(value),
                    'Avg Duration',
                  ]}
                  labelFormatter={(label: string) => {
                    const item = chartData.find((d) => d.name === label);
                    return item?.fullName ?? label;
                  }}
                  contentStyle={{
                    borderRadius: '8px',
                    border: '1px solid var(--chart-tooltip-border)',
                    fontSize: '12px',
                    backgroundColor: 'var(--chart-tooltip-bg)',
                    color: 'var(--chart-tooltip-text)',
                  }}
                />
                <Bar dataKey="duration" radius={[0, 4, 4, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={index}
                      fill={severityColors[entry.severity]?.bar ?? '#94a3b8'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Queue Analysis (M/M/c) */}
      <div className="mt-8">
        <h2 className="text-[14px] font-semibold text-fg">
          <HintTooltip text="Queue mining fits an M/M/c queueing model per activity to estimate waiting-time components. (Senderovich et al., 2015)">
            Queue Analysis
          </HintTooltip>
        </h2>

        {queueLoading && (
          <div className="mt-4 flex items-center gap-2 text-[12px] text-fg-muted">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            Running M/M/c queue model…
          </div>
        )}

        {!queueLoading && queueData && queueData.per_activity.length > 0 && (
          <div className="mt-4 space-y-3">
            {queueData.per_activity.slice(0, 8).map((qa) => {
              const pct = Math.round(qa.utilization * 100);
              const healthColor =
                qa.queue_health === 'saturated'
                  ? 'bg-danger'
                  : qa.queue_health === 'strained'
                  ? 'bg-warning'
                  : 'bg-success';
              const healthText =
                qa.queue_health === 'saturated'
                  ? 'text-danger'
                  : qa.queue_health === 'strained'
                  ? 'text-warning'
                  : 'text-success';

              const decomp = qa.wait_decomposition;
              const totalDecomp =
                decomp.resource_contention_s +
                decomp.inter_batch_wait_s +
                decomp.external_dependency_s +
                decomp.processing_s;

              const pContention = totalDecomp > 0 ? (decomp.resource_contention_s / totalDecomp) * 100 : 0;
              const pBatch = totalDecomp > 0 ? (decomp.inter_batch_wait_s / totalDecomp) * 100 : 0;
              const pExternal = totalDecomp > 0 ? (decomp.external_dependency_s / totalDecomp) * 100 : 0;
              const pProcessing = totalDecomp > 0 ? (decomp.processing_s / totalDecomp) * 100 : 0;

              const waitDelta =
                qa.expected_wait_time_s !== null
                  ? qa.actual_avg_wait_time_s - qa.expected_wait_time_s
                  : null;

              return (
                <div key={qa.activity} className="card p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-fg">
                          {qa.activity}
                        </span>
                        <span
                          className={clsx(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                            qa.queue_health === 'saturated' && 'bg-danger/10 text-danger',
                            qa.queue_health === 'strained' && 'bg-warning/10 text-warning',
                            qa.queue_health === 'healthy' && 'bg-success/10 text-success',
                          )}
                        >
                          {qa.queue_health}
                        </span>
                        {!qa.stability && (
                          <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                            unstable
                          </span>
                        )}
                      </div>

                      {/* Utilization bar */}
                      <div className="mt-2 flex items-center gap-2">
                        <div className="flex-1 overflow-hidden rounded-full bg-tint" style={{ height: 6 }}>
                          <div
                            className={clsx('h-full rounded-full transition-all', healthColor)}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        <span className={clsx('shrink-0 text-[11px] font-medium tabular-nums', healthText)}>
                          {pct}%
                        </span>
                        <span className="shrink-0 text-[10px] text-fg-faint">
                          utilization ({qa.estimated_servers}c)
                        </span>
                      </div>

                      {/* Wait decomposition stacked bar */}
                      {totalDecomp > 0 && (
                        <div className="mt-2">
                          <div className="flex overflow-hidden rounded-sm" style={{ height: 8 }}>
                            <HintTooltip text={`Resource contention: ${formatDuration(decomp.resource_contention_s)}`}>
                              <div
                                className="bg-danger/70 transition-all"
                                style={{ width: `${pContention}%`, height: '100%' }}
                              />
                            </HintTooltip>
                            <HintTooltip text={`Inter-batch wait: ${formatDuration(decomp.inter_batch_wait_s)}`}>
                              <div
                                className="bg-warning/70 transition-all"
                                style={{ width: `${pBatch}%`, height: '100%' }}
                              />
                            </HintTooltip>
                            <HintTooltip text={`External dependency: ${formatDuration(decomp.external_dependency_s)}`}>
                              <div
                                className="bg-accent/70 transition-all"
                                style={{ width: `${pExternal}%`, height: '100%' }}
                              />
                            </HintTooltip>
                            <HintTooltip text={`Processing: ${formatDuration(decomp.processing_s)}`}>
                              <div
                                className="bg-tint-strong transition-all"
                                style={{ width: `${pProcessing}%`, height: '100%' }}
                              />
                            </HintTooltip>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-fg-faint">
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-danger/70" />
                              Contention {formatDuration(decomp.resource_contention_s)}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-warning/70" />
                              Batch {formatDuration(decomp.inter_batch_wait_s)}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-accent/70" />
                              External {formatDuration(decomp.external_dependency_s)}
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-sm bg-tint-strong" />
                              Processing {formatDuration(decomp.processing_s)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Right column: metrics */}
                    <div className="shrink-0 space-y-1 text-right text-[11px]">
                      <div className="text-fg-muted">
                        Actual wait:{' '}
                        <span className="font-medium text-fg-secondary">
                          {formatDuration(qa.actual_avg_wait_time_s)}
                        </span>
                      </div>
                      {qa.expected_wait_time_s !== null && (
                        <div className="text-fg-muted">
                          Expected:{' '}
                          <span className="font-medium text-fg-secondary">
                            {formatDuration(qa.expected_wait_time_s)}
                          </span>
                        </div>
                      )}
                      {waitDelta !== null && (
                        <div
                          className={clsx(
                            'text-[10px]',
                            waitDelta > 0 ? 'text-danger' : 'text-success',
                          )}
                        >
                          {waitDelta > 0 ? '+' : ''}
                          {formatDuration(waitDelta)} vs model
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Legend note */}
            <p className="text-[11px] text-fg-faint">
              M/M/c Erlang-C model per activity. Utilization = lambda / (c * mu). (Senderovich et al., 2015)
            </p>
          </div>
        )}

        {!queueLoading && (!queueData || queueData.per_activity.length === 0) && (
          <p className="mt-4 text-[12px] text-fg-muted">No queue analysis data available.</p>
        )}
      </div>

      {/* Bottleneck details */}
      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[14px] font-semibold text-fg">Activity Details</h2>
          <span className="text-[11px] text-fg-faint">
            {filteredItems.length} of {bottleneckItems.length}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* DBSM sort toggle */}
            {dbsmByActivity.size > 0 && (
              <button
                onClick={() =>
                  setDbsmSort((prev) =>
                    prev === null ? 'desc' : prev === 'desc' ? 'asc' : null,
                  )
                }
                className={clsx(
                  'flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] transition-all',
                  dbsmSort !== null
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-line bg-surface-1 text-fg-muted hover:text-fg',
                )}
              >
                DBSM
                {dbsmSort === 'desc' ? (
                  <ChevronDown size={10} />
                ) : dbsmSort === 'asc' ? (
                  <ChevronUp size={10} />
                ) : (
                  <ChevronDown size={10} className="opacity-40" />
                )}
              </button>
            )}
            {/* Severity filter */}
            <div className="flex rounded-lg border border-line bg-surface-1 p-0.5 gap-0.5">
              {(['all', 'critical', 'high', 'medium', 'low'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverityFilter(s)}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-[11px] capitalize transition-all',
                    severityFilter === s
                      ? 'bg-surface-2 text-fg shadow-xs'
                      : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            {/* Search */}
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search activities…"
                className="input pl-7 pr-7 py-1.5 text-[12px] w-48"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {filteredItems.length === 0 && (
            <EmptyState
              icon={Search}
              title="No activities match your filter"
              description="Try a different search term or clear the severity filter."
              action={
                <button
                  onClick={() => { setSearch(''); setSeverityFilter('all'); }}
                  className="btn-secondary text-[12px]"
                >
                  Clear filters
                </button>
              }
              compact
            />
          )}
          {filteredItems.map((bottleneck) => {
            const colors = severityColors[bottleneck.severity];
            const dbsm = dbsmByActivity.get(bottleneck.activity);
            const dbsmBarColor =
              dbsm === undefined
                ? ''
                : dbsm.dbsm_score >= 70
                  ? 'bg-danger'
                  : dbsm.dbsm_score >= 30
                    ? 'bg-warning'
                    : 'bg-success';
            return (
              <div
                key={bottleneck.activity}
                className={clsx(
                  'card p-5 transition-all',
                  bottleneck.is_bottleneck && 'border-line-strong',
                )}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-semibold text-fg">
                        {bottleneck.activity}
                      </h3>
                      {bottleneck.is_bottleneck && (
                        <AlertTriangle size={14} className="text-danger" />
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-[12px] text-fg-muted">
                      <span>
                        <HintTooltip text="Average time spent at this activity across all cases">Avg</HintTooltip>:{' '}
                        <span className="font-medium text-fg-secondary">{formatDuration(bottleneck.avg_duration)}</span>
                      </span>
                      <span>
                        <HintTooltip text="Middle value of all durations — less affected by outliers than the average">Median</HintTooltip>:{' '}
                        <span className="font-medium text-fg-secondary">{formatDuration(bottleneck.median_duration)}</span>
                      </span>
                      <span>
                        Frequency: <span className="font-medium text-fg-secondary">{bottleneck.frequency.toLocaleString()}</span>
                      </span>
                    </div>
                    {/* DBSM score bar */}
                    <div className="mt-3 flex items-center gap-2">
                      <HintTooltip text="DBSM Score (0-100): blends delay (40%), resource pressure (30%), and cycle-time impact (30%) into a single bottleneck severity. Source: Dynamic Bottleneck Scoring Method (2024).">
                        <span className="text-[11px] text-fg-muted">DBSM</span>
                      </HintTooltip>
                      {dbsm !== undefined ? (
                        <>
                          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-tint">
                            <div
                              className={clsx('h-full rounded-full transition-all', dbsmBarColor)}
                              style={{ width: `${dbsm.dbsm_score}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-medium tabular-nums text-fg-secondary">
                            {dbsm.dbsm_score}
                          </span>
                          <span className="text-[10px] text-fg-faint">#{dbsm.rank}</span>
                        </>
                      ) : (
                        <span className="text-[11px] text-fg-faint">&mdash;</span>
                      )}
                    </div>
                    {top10Activities.has(bottleneck.activity) && (
                      <ExplainButton
                        kind="bottleneck"
                        context={{
                          activity: bottleneck.activity,
                          avg_duration_s: bottleneck.avg_duration,
                          median_duration_s: bottleneck.median_duration,
                          severity: bottleneck.severity,
                        }}
                        size="xs"
                        className="mt-2"
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <HintTooltip text="Critical = duration in the top 5% of all activities">
                      <span className={clsx('badge', colors.badge)}>
                        {bottleneck.severity}
                      </span>
                    </HintTooltip>
                    {eventLogId && (
                      <button
                        onClick={() =>
                          navigate(
                            `/simulate/${eventLogId}?focus=${encodeURIComponent(bottleneck.activity)}&kind=des`,
                          )
                        }
                        className="btn-secondary text-[11px]"
                        title="Open DES simulator with automation pre-filled for this activity"
                      >
                        <FlaskConical size={11} />
                        Simulate fix
                      </button>
                    )}
                    {bottleneck.is_bottleneck && (
                      <button
                        onClick={() =>
                          trackBottleneckAsInitiative(
                            bottleneck.activity,
                            bottleneck.avg_duration,
                            bottleneck.median_duration,
                          )
                        }
                        className="btn-secondary text-[11px]"
                        title="Create an Initiative to track progress reducing this bottleneck"
                      >
                        <Target size={11} />
                        Track as Initiative
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* What-if slider + automation candidates — competitive parity */}
      {eventLogId && bottleneckItems.length > 0 && (
        <WhatIfSlider
          eventLogId={eventLogId}
          activity={(criticalBottlenecks[0] ?? bottleneckItems[0]).activity}
          activities={bottleneckItems.map((b) => b.activity)}
        />
      )}
      {eventLogId && <AutomationCandidates eventLogId={eventLogId} />}

      {/* Disco-style case Gantt */}
      {eventLogId && (
        <div className="mt-8">
          <CaseGantt eventLogId={eventLogId} />
        </div>
      )}

      {/* Waiting times */}
      {waitingTimes.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[14px] font-semibold text-fg">
            <HintTooltip text="Time a case spends waiting between two activities — not actively being processed">
              Waiting Times Between Activities
            </HintTooltip>
          </h2>
          <div className="mt-4 space-y-2">
            {waitingTimes
              .sort((a, b) => b.avg_waiting - a.avg_waiting)
              .map((wt, index) => (
                <div key={index} className="card flex items-center gap-4 p-4">
                  <span className="rounded-md bg-tint px-2 py-1 text-[12px] font-medium text-fg-secondary">
                    {wt.source}
                  </span>
                  <ArrowRight size={16} className="text-fg-faint" />
                  <span className="rounded-md bg-tint px-2 py-1 text-[12px] font-medium text-fg-secondary">
                    {wt.target}
                  </span>
                  <div className="ml-auto flex items-center gap-4 text-[12px] text-fg-muted">
                    <span>
                      Avg: <span className="font-medium text-fg-secondary">{formatDuration(wt.avg_waiting)}</span>
                    </span>
                    <span>
                      Max: <span className="font-medium text-fg-secondary">{formatDuration(wt.max_waiting)}</span>
                    </span>
                    <span className="text-[11px] text-fg-faint">
                      {wt.frequency}x
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Cross-links: from "where it's slow" to "why" and "what to do". */}
      {eventLogId && (
        <RelatedAnalyses
          items={[
            {
              label: 'Root Cause',
              hint: 'Find the case attributes that predict slow cases',
              icon: Search,
              to: `/root-cause/${eventLogId}`,
            },
            {
              label: 'Cases at Risk',
              hint: 'See which in-flight cases are about to breach SLA',
              icon: ShieldAlert,
              to: `/cases-at-risk/${eventLogId}`,
            },
            {
              label: 'Mission Control',
              hint: 'Drill into priorities, the at-risk feed and ROI',
              icon: Gauge,
              to: `/mission-control/${eventLogId}`,
            },
          ]}
        />
      )}
    </div>
  );
}
