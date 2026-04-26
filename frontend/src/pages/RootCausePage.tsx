import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Search, TrendingUp, TrendingDown } from 'lucide-react';
import HintTooltip from '@/components/common/Tooltip';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import clsx from 'clsx';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { useMiningStore } from '@/store';
import { useEventLogData } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export default function RootCausePage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const { rootCause, rootCauseLoading, error, fetchRootCause } = useMiningStore();

  useEffect(() => {
    if (eventLogId) {
      fetchRootCause(eventLogId);
    }
  }, [eventLogId, fetchRootCause]);

  if (rootCauseLoading) {
    return (
      <LoadingSpinner
        size="lg"
        text="Analyzing root causes..."
        fullPage
      />
    );
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => eventLogId && fetchRootCause(eventLogId)}
      />
    );
  }

  const correlationData = (rootCause?.correlations ?? []).map((c) => ({
    attribute: c.attribute,
    correlation: c.correlation_value,
    pValue: c.p_value,
    significant: c.p_value < 0.05,
  }));

  return (
    <div>
      <PageHeader
        title="Root Cause Analysis"
        icon={Search}
        backTo={-1}
        description="Attributes that correlate with longer or shorter case durations. Significant correlations suggest factors affecting performance."
        subtitle={`${eventLog?.name ?? 'Event Log'} — identifying factors affecting process performance`}
      />

      {rootCause && (
        <>
          {/* Correlation chart */}
          {correlationData.length > 0 && (
            <div className="card mt-6 p-5">
              <h2 className="text-[14px] font-semibold text-fg">
                Attribute Correlations with Duration
              </h2>
              <p className="mt-1 text-[11px] text-fg-faint">
                Positive values indicate longer durations; negative values
                indicate shorter durations
              </p>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={correlationData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                    <XAxis
                      dataKey="attribute"
                      fontSize={12}
                      tick={{ fill: 'var(--chart-tick)' }}
                    />
                    <YAxis
                      fontSize={12}
                      tick={{ fill: 'var(--chart-tick)' }}
                      domain={[-1, 1]}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: '8px',
                        border: '1px solid var(--chart-tooltip-border)',
                        fontSize: '12px',
                        backgroundColor: 'var(--chart-tooltip-bg)',
                        color: 'var(--chart-tooltip-text)',
                      }}
                      formatter={(value: number, name: string) => [
                        value.toFixed(3),
                        name === 'correlation' ? 'Correlation' : name,
                      ]}
                    />
                    <ReferenceLine y={0} stroke="#3f3f46" />
                    <Bar dataKey="correlation" radius={[4, 4, 0, 0]}>
                      {correlationData.map((entry, index) => (
                        <Cell
                          key={index}
                          fill={
                            entry.correlation > 0
                              ? entry.significant
                                ? 'rgb(var(--c-danger))'
                                : 'rgba(var(--c-danger) / 0.35)'
                              : entry.significant
                                ? 'rgb(var(--c-success))'
                                : 'rgba(var(--c-success) / 0.35)'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Root cause factors */}
          <div className="mt-6">
            <h2 className="text-[14px] font-semibold text-fg">
              Contributing Factors
            </h2>
            <div className="mt-4 space-y-3">
              {rootCause.factors.map((factor, index) => {
                const impactPercentage =
                  factor.avg_duration_normal > 0
                    ? ((factor.avg_duration_affected -
                        factor.avg_duration_normal) /
                        factor.avg_duration_normal) *
                      100
                    : 0;
                const isNegative = impactPercentage < 0;

                return (
                  <div key={index} className="card p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-[13px] font-semibold text-fg">
                            {factor.attribute}
                          </h3>
                          <span className="badge badge-indigo">
                            {factor.value}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] text-fg-muted">
                          {factor.impact}
                        </p>

                        <div className="mt-3 flex items-center gap-6 text-[12px]">
                          <div>
                            <span className="text-fg-muted">
                              Affected Duration:{' '}
                            </span>
                            <span className="font-medium text-fg">
                              {formatDuration(factor.avg_duration_affected)}
                            </span>
                          </div>
                          <div>
                            <span className="text-fg-muted">
                              Normal Duration:{' '}
                            </span>
                            <span className="font-medium text-fg">
                              {formatDuration(factor.avg_duration_normal)}
                            </span>
                          </div>
                          <div>
                            <span className="text-fg-muted">Cases: </span>
                            <span className="font-medium text-fg">
                              {factor.case_count.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div
                        className={clsx(
                          'flex items-center gap-1 rounded-lg px-3 py-2',
                          isNegative
                            ? 'bg-success/10 text-success'
                            : 'bg-danger/10 text-danger',
                        )}
                      >
                        {isNegative ? (
                          <TrendingDown size={16} />
                        ) : (
                          <TrendingUp size={16} />
                        )}
                        <span className="text-[12px] font-semibold">
                          {isNegative ? '' : '+'}
                          {impactPercentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>

                    {/* Duration comparison bar */}
                    <div className="mt-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="flex items-center justify-between text-[11px] text-fg-muted">
                            <span>Affected</span>
                            <span>
                              {formatDuration(factor.avg_duration_affected)}
                            </span>
                          </div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-tint">
                            <div
                              className={clsx(
                                'h-full rounded-full',
                                isNegative ? 'bg-success' : 'bg-danger',
                              )}
                              style={{
                                width: `${Math.min(
                                  (factor.avg_duration_affected /
                                    Math.max(
                                      factor.avg_duration_affected,
                                      factor.avg_duration_normal,
                                    )) *
                                    100,
                                  100,
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between text-[11px] text-fg-muted">
                            <span>Normal</span>
                            <span>
                              {formatDuration(factor.avg_duration_normal)}
                            </span>
                          </div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-tint">
                            <div
                              className="h-full rounded-full bg-accent"
                              style={{
                                width: `${Math.min(
                                  (factor.avg_duration_normal /
                                    Math.max(
                                      factor.avg_duration_affected,
                                      factor.avg_duration_normal,
                                    )) *
                                    100,
                                  100,
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {rootCause.factors.length === 0 && (
                <EmptyState
                  icon={Search}
                  title="No significant factors detected"
                  description="The model found no attributes with statistically significant correlation to case duration. Try enriching your event log with more resource or attribute columns."
                />
              )}
            </div>
          </div>

          {/* Correlations table */}
          {rootCause.correlations.length > 0 && (
            <div className="mt-8">
              <h2 className="text-[14px] font-semibold text-fg">
                Statistical Correlations
              </h2>
              <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-3">
                      <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                        Attribute
                      </th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                        <HintTooltip text="How strongly this attribute relates to case duration. +1 = increases duration, -1 = decreases it">
                          Correlation
                        </HintTooltip>
                      </th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                        <HintTooltip text="Statistical significance. Below 0.05 = statistically significant">
                          p-value
                        </HintTooltip>
                      </th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                        Significance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rootCause.correlations.map((corr, index) => (
                      <tr
                        key={index}
                        className="border-b border-line/40 last:border-0"
                      >
                        <td className="px-4 py-3 text-[12px] font-medium text-fg-secondary">
                          {corr.attribute}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={clsx(
                              'font-mono text-[12px] font-medium',
                              corr.correlation_value > 0
                                ? 'text-danger'
                                : 'text-success',
                            )}
                          >
                            {corr.correlation_value > 0 ? '+' : ''}
                            {corr.correlation_value.toFixed(4)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-fg-muted">
                          {corr.p_value.toExponential(2)}
                        </td>
                        <td className="px-4 py-3">
                          {corr.p_value < 0.001 ? (
                            <span className="badge badge-emerald">
                              Highly significant
                            </span>
                          ) : corr.p_value < 0.05 ? (
                            <span className="badge badge-amber">
                              Significant
                            </span>
                          ) : (
                            <span className="badge badge-slate">
                              Not significant
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!rootCause && !rootCauseLoading && (
        <EmptyState
          className="mt-16"
          icon={Search}
          title="No analysis available"
          description="Root cause analysis requires case attributes in your event log."
          action={
            <button
              onClick={() => eventLogId && fetchRootCause(eventLogId)}
              className="btn-secondary text-[12px]"
            >
              Retry analysis
            </button>
          }
        />
      )}
    </div>
  );
}
