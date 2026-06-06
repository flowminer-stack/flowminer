import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ShieldAlert,
  Clock,
  AlertTriangle,
  Activity,
  ChevronRight,
  RefreshCw,
  Brain,
} from 'lucide-react';
import clsx from 'clsx';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import ErrorState from '@/components/common/ErrorState';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import HintTooltip from '@/components/common/Tooltip';
import RiskExplanationCard from '@/components/Predictive/RiskExplanationCard';
import { predictive } from '@/api/predictive';
import type {
  CasesAtRiskResponse,
  ModelHealthResponse,
  ModelHealthEntry,
} from '@/types/predictive';
import { useEventLogData } from '@/hooks/useProcessMining';
import { formatDuration, formatRelativeTime } from '@/utils/format';

const DEFAULT_SLA_HOURS = 72;
const DEFAULT_RISK_THRESHOLD = 0.7;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function riskTone(p: number): { bar: string; text: string } {
  if (p >= 0.8) return { bar: 'bg-danger', text: 'text-danger' };
  if (p >= 0.5) return { bar: 'bg-warning', text: 'text-warning' };
  return { bar: 'bg-success', text: 'text-success' };
}

function metricLabel(kind: string, metrics: ModelHealthEntry['metrics']): string {
  // Outcome/classification models report AUC; regression (remaining-time) reports MAE.
  if (metrics.auc !== undefined) return `AUC ${metrics.auc.toFixed(3)}`;
  if (metrics.mae !== undefined) return `MAE ${formatDuration(metrics.mae)}`;
  if (metrics.accuracy !== undefined) return `Acc ${(metrics.accuracy * 100).toFixed(1)}%`;
  if (metrics.rmse !== undefined) return `RMSE ${formatDuration(metrics.rmse)}`;
  return kind.includes('time') || kind.includes('remaining') ? 'no MAE' : 'no AUC';
}

// ─── Model-health strip ──────────────────────────────────────────────────────

function ModelHealthStrip({ health }: { health: ModelHealthResponse | null }) {
  if (!health || health.models.length === 0) return null;
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {health.models.map((m) => (
        <div
          key={m.kind}
          className={clsx(
            'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[11px]',
            m.trained
              ? 'border-line bg-surface-2'
              : 'border-dashed border-line bg-tint',
          )}
        >
          <Brain
            size={14}
            className={m.trained ? 'text-accent' : 'text-fg-faint'}
          />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium capitalize text-fg-secondary">
                {m.kind.replace(/_/g, ' ')}
              </span>
              <span
                className={clsx(
                  'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                  m.trained
                    ? 'bg-success/10 text-success'
                    : 'bg-warning/10 text-warning',
                )}
              >
                {m.trained ? 'trained' : 'not trained'}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-fg-faint">
              {m.trained && <span className="tabular-nums">{metricLabel(m.kind, m.metrics)}</span>}
              {m.n_cases != null && (
                <span className="tabular-nums">{m.n_cases.toLocaleString()} cases</span>
              )}
              {m.trained_at && (
                <span>{formatRelativeTime(m.trained_at)}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CasesAtRiskPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  // Controls (committed values drive the query; inputs are debounced via form).
  const [slaHours, setSlaHours] = useState<number>(DEFAULT_SLA_HOURS);
  const [riskThreshold, setRiskThreshold] = useState<number>(DEFAULT_RISK_THRESHOLD);
  const [slaInput, setSlaInput] = useState<string>(String(DEFAULT_SLA_HOURS));

  const [data, setData] = useState<CasesAtRiskResponse | null>(null);
  const [health, setHealth] = useState<ModelHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!eventLogId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await predictive.getCasesAtRisk(eventLogId, {
        slaHours,
        riskThreshold,
      });
      setData(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load cases at risk',
      );
    } finally {
      setLoading(false);
    }
  }, [eventLogId, slaHours, riskThreshold]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Model health is independent of the SLA controls — fetch once per log.
  useEffect(() => {
    if (!eventLogId) return;
    let cancelled = false;
    predictive
      .getModelHealth(eventLogId)
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  const applySla = () => {
    const parsed = parseFloat(slaInput);
    if (!Number.isNaN(parsed) && parsed > 0) setSlaHours(parsed);
    else setSlaInput(String(slaHours));
  };

  // Server sorts by breach_probability desc; re-sort defensively.
  const cases = [...(data?.cases_at_risk ?? [])].sort(
    (a, b) => b.breach_probability - a.breach_probability,
  );
  const overSlaCount = cases.filter((c) => c.predicted_finish_over_sla).length;
  const slaSeconds = data?.sla_seconds;

  return (
    <div>
      <PageHeader
        title="Cases at Risk"
        icon={ShieldAlert}
        backTo={-1}
        description="Open cases predicted to breach their SLA, ranked by breach probability. Click a row to see why the model flagged it, and what is likely to happen next."
        subtitle={`${eventLog?.name ?? 'Event Log'} — live SLA-breach prediction`}
        actions={
          <button
            onClick={fetchData}
            className="btn-secondary text-[12px]"
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
            Refresh
          </button>
        }
      />

      {/* Controls */}
      <div className="card mt-6 flex flex-wrap items-end gap-5 p-4">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-fg-muted">
            <HintTooltip text="Cases whose elapsed (and predicted remaining) time exceeds this many hours are considered at risk of an SLA breach.">
              SLA target (hours)
            </HintTooltip>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              value={slaInput}
              onChange={(e) => setSlaInput(e.target.value)}
              onBlur={applySla}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySla();
              }}
              className="input w-28 py-1.5 text-[12px]"
            />
            <button onClick={applySla} className="btn-secondary text-[12px]">
              Apply
            </button>
          </div>
        </div>

        <div className="min-w-[220px]">
          <label className="mb-1 block text-[11px] font-medium text-fg-muted">
            <HintTooltip text="Only cases whose predicted breach probability is at or above this threshold are listed.">
              Risk threshold
            </HintTooltip>
            <span className="ml-2 font-mono tabular-nums text-fg-secondary">
              {(riskThreshold * 100).toFixed(0)}%
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.05}
            value={riskThreshold}
            onChange={(e) => setRiskThreshold(parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
        </div>
      </div>

      {/* Model health */}
      <ModelHealthStrip health={health} />

      {/* Summary cards */}
      {!loading && !error && data && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-danger/10 p-2">
                <ShieldAlert size={18} className="text-danger" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">{data.count}</p>
                <p className="text-[12px] text-fg-muted">Cases at risk</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-warning/10 p-2">
                <AlertTriangle size={18} className="text-warning" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">{overSlaCount}</p>
                <p className="text-[12px] text-fg-muted">Predicted over SLA</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-accent/10 p-2">
                <Clock size={18} className="text-accent" />
              </div>
              <div>
                <p className="text-xl font-bold tabular-nums text-fg">
                  {slaSeconds !== undefined ? formatDuration(slaSeconds) : '—'}
                </p>
                <p className="text-[12px] text-fg-muted">SLA target</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* States */}
      {loading && (
        <div className="mt-10">
          <LoadingSpinner size="lg" text="Scoring open cases…" fullPage />
        </div>
      )}

      {!loading && error && (
        <div className="mt-6">
          <ErrorState message={error} onRetry={fetchData} />
        </div>
      )}

      {!loading && !error && data && cases.length === 0 && (
        <EmptyState
          className="mt-10"
          icon={ShieldAlert}
          title="No cases at risk"
          description="No open case currently exceeds the risk threshold for this SLA target. Lower the threshold or shorten the SLA to widen the net."
        />
      )}

      {/* Table */}
      {!loading && !error && cases.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-surface-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-3">
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  Case
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  Last activity
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  <HintTooltip text="Wall-clock time elapsed since the case started.">
                    Elapsed
                  </HintTooltip>
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  <HintTooltip text="Model-estimated probability that this case breaches the SLA.">
                    P(breach)
                  </HintTooltip>
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  <HintTooltip text="Predicted time remaining until the case completes.">
                    Predicted remaining
                  </HintTooltip>
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                  Likely next
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const tone = riskTone(c.breach_probability);
                const isOpen = selectedCase === c.case_id;
                return (
                  <Fragment key={c.case_id}>
                    <tr
                      onClick={() =>
                        setSelectedCase(isOpen ? null : c.case_id)
                      }
                      className={clsx(
                        'cursor-pointer border-b border-line/40 transition-colors last:border-0 hover:bg-surface-3',
                        isOpen && 'bg-surface-3',
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] font-medium text-fg-secondary">
                            {c.case_id}
                          </span>
                          {c.predicted_finish_over_sla && (
                            <HintTooltip text="Predicted to finish after the SLA target.">
                              <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[9px] font-medium text-danger">
                                over SLA
                              </span>
                            </HintTooltip>
                          )}
                        </div>
                        <span className="text-[10px] text-fg-faint">
                          prefix {c.prefix_length}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-fg-secondary">
                        <span className="flex items-center gap-1.5">
                          <Activity size={11} className="text-fg-faint" />
                          {c.last_activity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-fg-secondary tabular-nums">
                        {formatDuration(c.elapsed_seconds)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-tint">
                            <div
                              className={clsx('h-full rounded-full', tone.bar)}
                              style={{
                                width: `${Math.min(c.breach_probability * 100, 100)}%`,
                              }}
                            />
                          </div>
                          <span
                            className={clsx(
                              'text-[12px] font-semibold tabular-nums',
                              tone.text,
                            )}
                          >
                            {(c.breach_probability * 100).toFixed(0)}%
                          </span>
                        </div>
                        <span className="text-[10px] capitalize text-fg-faint">
                          {c.risk_label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-fg-secondary tabular-nums">
                        {c.predicted_remaining_seconds != null
                          ? formatDuration(c.predicted_remaining_seconds)
                          : '—'}
                        {c.predicted_total_seconds != null && (
                          <span className="block text-[10px] text-fg-faint">
                            total {formatDuration(c.predicted_total_seconds)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {c.top_next_activities.slice(0, 3).map((n, i) => (
                            <HintTooltip
                              key={`${n.activity}-${i}`}
                              text={`${(n.probability * 100).toFixed(0)}% likely next`}
                            >
                              <span className="rounded-md bg-tint px-1.5 py-0.5 text-[10px] text-fg-muted">
                                {n.activity}
                                <span className="ml-1 tabular-nums text-fg-faint">
                                  {(n.probability * 100).toFixed(0)}%
                                </span>
                              </span>
                            </HintTooltip>
                          ))}
                          {c.top_next_activities.length === 0 && (
                            <span className="text-[11px] text-fg-faint">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight
                          size={14}
                          className={clsx(
                            'text-fg-faint transition-transform',
                            isOpen && 'rotate-90',
                          )}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface-3">
                        <td colSpan={7} className="px-4 py-3">
                          <RiskExplanationCard
                            eventLogId={eventLogId!}
                            caseId={c.case_id}
                            slaThreshold={slaSeconds}
                            onClose={() => setSelectedCase(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
