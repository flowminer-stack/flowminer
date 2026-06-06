import { useEffect, useMemo, useState } from 'react';
import { eventLogs as eventLogsApi } from '@/api/client';
import { checkTimedDeclare } from '@/api/timedDeclare';
import type { EventLog } from '@/types';
import type {
  BoundUnit,
  TimedConstraint,
  TimedConstraintResult,
  TimedConstraintType,
  TimedDeclareResponse,
} from '@/types/compliance';
import { getCached, setCached } from '@/store/analysisCache';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';

interface Props { eventLogId: string; }

// Local row model — `bound_value` is a string while editing so the input can
// be cleared without snapping to 0; it is coerced to a number on submit.
interface ConstraintRow {
  id: string;
  type: TimedConstraintType;
  activity_a: string;
  activity_b: string;
  bound_value: string;
  bound_unit: BoundUnit;
  business_days: boolean;
}

const CONSTRAINT_META: Record<TimedConstraintType, { label: string; binary: boolean; hint: string }> = {
  response: { label: 'Response', binary: true, hint: 'After A, B must follow within the SLA window.' },
  precedence: { label: 'Precedence', binary: true, hint: 'B may only occur if A preceded it within the SLA window.' },
  existence: { label: 'Existence', binary: false, hint: 'A must occur within the SLA window of the case start.' },
  absence: { label: 'Absence', binary: false, hint: 'A must NOT occur within the SLA window of the case start.' },
};

const UNITS: BoundUnit[] = ['minutes', 'hours', 'days'];

let rowSeq = 0;
function newRow(activities: string[]): ConstraintRow {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    type: 'response',
    activity_a: activities[0] ?? '',
    activity_b: activities[1] ?? activities[0] ?? '',
    bound_value: '24',
    bound_unit: 'hours',
    business_days: false,
  };
}

function rateColor(rate: number): string {
  if (rate >= 0.25) return 'bg-danger';
  if (rate >= 0.05) return 'bg-warning';
  return 'bg-success';
}

function rateTextColor(rate: number): string {
  if (rate >= 0.25) return 'text-danger';
  if (rate >= 0.05) return 'text-warning';
  return 'text-success';
}

function fmtNum(n: number | null): string {
  if (n == null) return '—';
  return Number.isInteger(n) ? n.toString() : n.toFixed(1);
}

function resultTitle(r: TimedConstraintResult): string {
  if (r.label) return r.label;
  const meta = CONSTRAINT_META[r.type as TimedConstraintType];
  const typeLabel = meta?.label ?? r.type;
  const window = `${fmtNum(r.bound_value)} ${r.bound_unit}${r.business_days ? ' (business days)' : ''}`;
  if (meta?.binary && r.activity_b) {
    return `${typeLabel}: ${r.activity_a} → ${r.activity_b} within ${window}`;
  }
  return `${typeLabel}: ${r.activity_a} within ${window}`;
}

export default function ComplianceDashboard({ eventLogId }: Props) {
  const cachedLog = getCached<EventLog>(eventLogId, 'eventLog');
  const [eventLog, setEventLog] = useState<EventLog | null>(cachedLog);
  const [loadingLog, setLoadingLog] = useState(!cachedLog);

  const activities = useMemo(() => eventLog?.activities_list ?? [], [eventLog]);

  const [rows, setRows] = useState<ConstraintRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TimedDeclareResponse | null>(null);

  // Load the event log (for the activity dropdowns) following the same
  // cache-first pattern as FourEyes.
  useEffect(() => {
    const existing = getCached<EventLog>(eventLogId, 'eventLog');
    if (existing) {
      setEventLog(existing);
      setLoadingLog(false);
      return;
    }
    setLoadingLog(true);
    eventLogsApi.get(eventLogId)
      .then((el) => {
        setCached(eventLogId, 'eventLog', el);
        setEventLog(el);
      })
      .catch(() => {})
      .finally(() => setLoadingLog(false));
  }, [eventLogId]);

  // Seed one starter row once activities are available.
  useEffect(() => {
    if (!loadingLog && activities.length > 0) {
      setRows((prev) => (prev.length === 0 ? [newRow(activities)] : prev));
    }
  }, [loadingLog, activities]);

  const updateRow = (id: string, patch: Partial<ConstraintRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, newRow(activities)]);
  const removeRow = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));

  const buildConstraints = (): TimedConstraint[] =>
    rows
      .filter((r) => r.activity_a)
      .map((r) => {
        const binary = CONSTRAINT_META[r.type].binary;
        const value = Number(r.bound_value);
        return {
          type: r.type,
          activity_a: r.activity_a,
          activity_b: binary ? (r.activity_b || null) : null,
          bound_value: Number.isFinite(value) && value > 0 ? value : 1,
          bound_unit: r.bound_unit,
          business_days: r.business_days,
        } satisfies TimedConstraint;
      });

  // A row is valid when A is set, the bound is positive, and binary
  // templates have a distinct B.
  const validRowCount = rows.filter((r) => {
    if (!r.activity_a) return false;
    const value = Number(r.bound_value);
    if (!Number.isFinite(value) || value <= 0) return false;
    if (CONSTRAINT_META[r.type].binary && !r.activity_b) return false;
    return true;
  }).length;

  const check = () => {
    const constraints = buildConstraints();
    if (constraints.length === 0) return;
    setChecking(true);
    setError(null);
    setResult(null);
    checkTimedDeclare(eventLogId, constraints)
      .then(setResult)
      .catch(() => setError('Failed to run compliance check.'))
      .finally(() => setChecking(false));
  };

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-fg-muted">
        Define time-bounded SLAs in plain terms — no code. Each constraint pairs a DECLARE-style
        relation with a deadline (the SLA window). FlowMiner measures how often the deadline is
        breached across your cases, how long breaches take, and which cases failed.
      </p>

      {/* Constraint editor */}
      <div className="space-y-2 rounded-lg border border-line bg-surface-1 p-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">SLA Constraints</p>
          <button
            onClick={addRow}
            disabled={loadingLog || activities.length === 0}
            className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] font-medium text-fg-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={12} /> Add constraint
          </button>
        </div>

        {loadingLog ? (
          <div className="h-9 w-full animate-pulse rounded border border-line bg-surface-0" />
        ) : activities.length === 0 ? (
          <p className="py-2 text-[11px] text-fg-muted">No activities available for this log.</p>
        ) : rows.length === 0 ? (
          <p className="py-2 text-[11px] text-fg-muted">No constraints yet. Add one to get started.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => {
              const binary = CONSTRAINT_META[row.type].binary;
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-0 p-2"
                >
                  {/* Constraint type */}
                  <div className="space-y-1">
                    <label className="block text-[9px] font-medium uppercase tracking-wider text-fg-faint">Type</label>
                    <select
                      value={row.type}
                      onChange={(e) => updateRow(row.id, { type: e.target.value as TimedConstraintType })}
                      title={CONSTRAINT_META[row.type].hint}
                      className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
                    >
                      {(Object.keys(CONSTRAINT_META) as TimedConstraintType[]).map((t) => (
                        <option key={t} value={t}>{CONSTRAINT_META[t].label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Activity A */}
                  <div className="space-y-1">
                    <label className="block text-[9px] font-medium uppercase tracking-wider text-fg-faint">
                      {binary ? 'Activity A' : 'Activity'}
                    </label>
                    <select
                      value={row.activity_a}
                      onChange={(e) => updateRow(row.id, { activity_a: e.target.value })}
                      className="max-w-[180px] rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
                    >
                      {activities.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>

                  {/* Activity B (binary only) */}
                  {binary && (
                    <div className="space-y-1">
                      <label className="block text-[9px] font-medium uppercase tracking-wider text-fg-faint">Activity B</label>
                      <select
                        value={row.activity_b}
                        onChange={(e) => updateRow(row.id, { activity_b: e.target.value })}
                        className="max-w-[180px] rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
                      >
                        {activities.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Bound value */}
                  <div className="space-y-1">
                    <label className="block text-[9px] font-medium uppercase tracking-wider text-fg-faint">Within</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={row.bound_value}
                      onChange={(e) => updateRow(row.id, { bound_value: e.target.value })}
                      className="w-20 rounded border border-line bg-surface-1 px-2 py-1 text-[11px] tabular-nums text-fg outline-none focus:border-accent"
                    />
                  </div>

                  {/* Bound unit */}
                  <div className="space-y-1">
                    <label className="block text-[9px] font-medium uppercase tracking-wider text-fg-faint">Unit</label>
                    <select
                      value={row.bound_unit}
                      onChange={(e) => updateRow(row.id, { bound_unit: e.target.value as BoundUnit })}
                      className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
                    >
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>

                  {/* Business days */}
                  <label className="flex cursor-pointer items-center gap-1.5 py-1.5 text-[11px] text-fg-secondary" title="Measure the SLA window in Mon–Fri working time.">
                    <input
                      type="checkbox"
                      checked={row.business_days}
                      onChange={(e) => updateRow(row.id, { business_days: e.target.checked })}
                      className="accent-accent"
                    />
                    Business days only
                  </label>

                  {/* Remove */}
                  <button
                    onClick={() => removeRow(row.id)}
                    title="Remove constraint"
                    className="ml-auto rounded p-1.5 text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={check}
            disabled={checking || loadingLog || validRowCount === 0}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
              checking || loadingLog || validRowCount === 0
                ? 'cursor-not-allowed bg-tint text-fg-muted opacity-50'
                : 'bg-accent text-white hover:bg-accent/90',
            )}
          >
            {checking
              ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              : <Gauge size={12} />}
            Check compliance
          </button>
          {validRowCount > 0 && !checking && (
            <span className="text-[10px] text-fg-faint">
              {validRowCount} constraint{validRowCount !== 1 ? 's' : ''} ready
            </span>
          )}
        </div>
      </div>

      {error && <p className="text-[11px] text-danger">{error}</p>}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <p className="text-[11px] text-fg-faint">
            Evaluated across {result.total_cases.toLocaleString()} case{result.total_cases !== 1 ? 's' : ''}.
          </p>

          {result.results.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-fg-muted">No results returned.</p>
          ) : (
            result.results.map((r, i) => {
              const ttv = r.time_to_violation;
              return (
                <div key={i} className="space-y-2 rounded-lg border border-line bg-surface-1 p-3">
                  {/* Header + rate */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-semibold text-fg">{resultTitle(r)}</p>
                      {r.narrative && <p className="mt-0.5 text-[10px] text-fg-faint">{r.narrative}</p>}
                    </div>
                    <span className={clsx('shrink-0 text-[16px] font-bold tabular-nums', rateTextColor(r.violation_rate))}>
                      {(r.violation_rate * 100).toFixed(1)}%
                    </span>
                  </div>

                  {/* Violation-rate bar */}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-tint">
                    <div
                      className={clsx('h-full rounded-full transition-all', rateColor(r.violation_rate))}
                      style={{ width: `${Math.min(100, Math.max(0, r.violation_rate * 100))}%` }}
                    />
                  </div>

                  {/* Counts */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-secondary">
                    <span><span className="font-semibold text-danger tabular-nums">{r.violating_cases.toLocaleString()}</span> violating</span>
                    <span><span className="font-semibold text-success tabular-nums">{r.satisfied_cases.toLocaleString()}</span> satisfied</span>
                    <span className="text-fg-faint">of {r.evaluated_cases.toLocaleString()} activating case{r.evaluated_cases !== 1 ? 's' : ''}</span>
                  </div>

                  {/* Time-to-violation stats */}
                  {ttv.count > 0 && (
                    <div className="rounded-md border border-line bg-surface-0 p-2">
                      <p className="mb-1 text-[9px] font-medium uppercase tracking-wider text-fg-faint">
                        Time to violation ({ttv.unit})
                      </p>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        {[
                          { label: 'Mean', value: fmtNum(ttv.mean) },
                          { label: 'Median', value: fmtNum(ttv.median) },
                          { label: 'P95', value: fmtNum(ttv.p95) },
                          { label: 'Max', value: fmtNum(ttv.max) },
                        ].map((s) => (
                          <div key={s.label}>
                            <p className="text-[13px] font-semibold tabular-nums text-fg">{s.value}</p>
                            <p className="text-[9px] uppercase tracking-wider text-fg-faint">{s.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Sample violating case ids */}
                  {r.violating_case_ids.length > 0 && (
                    <div>
                      <p className="mb-1 text-[10px] text-fg-faint">
                        Sample violating case{r.violating_case_ids.length !== 1 ? 's' : ''}:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {r.violating_case_ids.map((id) => (
                          <span
                            key={id}
                            className="rounded border border-line bg-surface-0 px-1.5 py-0.5 font-mono text-[10px] text-fg-secondary"
                          >
                            {id}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.violating_cases === 0 && (
                    <div className="flex items-center gap-1.5 rounded-md border border-success/20 bg-success/5 px-2 py-1.5">
                      <span className="text-success">✓</span>
                      <p className="text-[11px] text-success">SLA met for every activating case.</p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
