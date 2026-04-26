import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FlaskConical,
  Plus,
  X,
  ChevronDown,
  TrendingDown,
  TrendingUp,
  Minus,
  RefreshCw,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { type ColumnDef } from '@tanstack/react-table';
import clsx from 'clsx';
import { mining } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import DataTable from '@/components/common/DataTable';
import ActivityCostTable from '@/components/Simulation/ActivityCostTable';
import type {
  SimulationModification,
  SimulationResponse,
} from '@/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ─── Modification Card ────────────────────────────────────────────────────────

type ModType = SimulationModification['type'];

const MOD_LABELS: Record<ModType, string> = {
  duration_scale: 'Scale Duration',
  remove_activity: 'Remove Activity',
  adjust_frequency: 'Adjust Frequency',
};

interface ModCardProps {
  mod: SimulationModification;
  activities: string[];
  onChange: (mod: SimulationModification) => void;
  onDelete: () => void;
}

function ModCard({ mod, activities, onChange, onDelete }: ModCardProps) {
  const [typeOpen, setTypeOpen] = useState(false);
  const [actOpen, setActOpen] = useState(false);

  const modTypes: ModType[] = ['duration_scale', 'remove_activity', 'adjust_frequency'];

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          Modification
        </span>
        <button
          onClick={onDelete}
          className="rounded p-0.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
        >
          <X size={13} />
        </button>
      </div>

      {/* Type dropdown */}
      <div className="mb-2 relative">
        <label className="mb-1 block text-[10px] font-medium text-fg-muted">Type</label>
        <button
          type="button"
          onClick={() => setTypeOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded border border-line bg-surface-1 px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:border-accent/50"
        >
          {MOD_LABELS[mod.type]}
          <ChevronDown size={11} className={clsx('shrink-0 text-fg-faint transition-transform', typeOpen && 'rotate-180')} />
        </button>
        {typeOpen && (
          <div className="absolute left-0 top-full z-50 mt-0.5 w-full animate-fade-in rounded border border-line bg-surface-2 py-0.5 shadow-xl">
            {modTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onChange({ ...mod, type: t, value: t === 'remove_activity' ? 0 : t === 'duration_scale' ? 1.0 : 100 });
                  setTypeOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center px-3 py-1.5 text-[12px] hover:bg-tint',
                  mod.type === t ? 'text-accent' : 'text-fg-secondary',
                )}
              >
                {MOD_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Activity dropdown */}
      <div className="mb-2.5 relative">
        <label className="mb-1 block text-[10px] font-medium text-fg-muted">Activity</label>
        <button
          type="button"
          onClick={() => setActOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded border border-line bg-surface-1 px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:border-accent/50"
        >
          <span className={clsx('truncate', !mod.activity && 'text-fg-faint')}>
            {mod.activity || 'Select activity…'}
          </span>
          <ChevronDown size={11} className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', actOpen && 'rotate-180')} />
        </button>
        {actOpen && (
          <div className="absolute left-0 top-full z-50 mt-0.5 max-h-44 w-full animate-fade-in overflow-y-auto rounded border border-line bg-surface-2 py-0.5 shadow-xl">
            {activities.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-fg-faint">No activities available</p>
            ) : (
              activities.map((act) => (
                <button
                  key={act}
                  type="button"
                  onClick={() => { onChange({ ...mod, activity: act }); setActOpen(false); }}
                  className={clsx(
                    'flex w-full items-center px-3 py-1.5 text-[12px] hover:bg-tint',
                    mod.activity === act ? 'text-accent' : 'text-fg-secondary',
                  )}
                >
                  <span className="truncate">{act}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Value input */}
      {mod.type !== 'remove_activity' && (
        <div>
          <label className="mb-1 block text-[10px] font-medium text-fg-muted">
            {mod.type === 'duration_scale'
              ? `Scale factor: ${mod.value.toFixed(2)}x`
              : `Frequency: ${mod.value}%`}
          </label>
          <input
            type="range"
            min={mod.type === 'duration_scale' ? 0.1 : 0}
            max={mod.type === 'duration_scale' ? 3.0 : 100}
            step={mod.type === 'duration_scale' ? 0.05 : 1}
            value={mod.value}
            onChange={(e) => onChange({ ...mod, value: parseFloat(e.target.value) })}
            className="w-full accent-accent"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-fg-faint">
            <span>{mod.type === 'duration_scale' ? '0.1x' : '0%'}</span>
            <span>{mod.type === 'duration_scale' ? '3.0x' : '100%'}</span>
          </div>
        </div>
      )}

      {mod.type === 'remove_activity' && (
        <div className="rounded-md bg-danger/10 px-2.5 py-1.5">
          <p className="text-[11px] text-danger">This activity will be removed from simulated traces.</p>
        </div>
      )}
    </div>
  );
}

// ─── Activity comparison table row type ──────────────────────────────────────

interface ActivityRow {
  name: string;
  originalFreq: number;
  simulatedFreq: number;
  originalDuration: number;
  simulatedDuration: number;
  removed: boolean;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SimulationPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);

  const { eventLog, loading: eventLogLoading } = useEventLogData(eventLogId);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const [numTraces, setNumTraces] = useState(500);
  const [modifications, setModifications] = useState<SimulationModification[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulationResponse | null>(null);

  const activities = eventLog?.activities_list ?? [];

  const addMod = useCallback(() => {
    setModifications((prev) => [
      ...prev,
      { type: 'duration_scale', activity: activities[0] ?? '', value: 1.0 },
    ]);
  }, [activities]);

  const updateMod = useCallback((idx: number, mod: SimulationModification) => {
    setModifications((prev) => prev.map((m, i) => (i === idx ? mod : m)));
  }, []);

  const deleteMod = useCallback((idx: number) => {
    setModifications((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleRun = useCallback(async () => {
    if (!eventLogId) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await mining.simulate({
        event_log_id: eventLogId,
        num_traces: numTraces,
        modifications,
      });
      setResult(res);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Simulation failed',
        message: e instanceof Error ? e.message : 'Could not run simulation',
      });
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [eventLogId, numTraces, modifications, addNotification]);

  // Build activity table rows
  const activityRows: ActivityRow[] = result
    ? (() => {
        const origMap = new Map(result.original.activities.map((a) => [a.name, a]));
        const simMap = new Map(result.simulated.activities.map((a) => [a.name, a]));
        const removed = new Set(result.improvement.activities_removed);
        const allNames = new Set([...origMap.keys(), ...simMap.keys()]);
        return [...allNames].map((name) => ({
          name,
          originalFreq: origMap.get(name)?.frequency ?? 0,
          simulatedFreq: simMap.get(name)?.frequency ?? 0,
          originalDuration: origMap.get(name)?.avg_duration ?? 0,
          simulatedDuration: simMap.get(name)?.avg_duration ?? 0,
          removed: removed.has(name),
        }));
      })()
    : [];

  const activityColumns: ColumnDef<ActivityRow, unknown>[] = [
    {
      accessorKey: 'name',
      header: 'Activity',
      cell: ({ row }) => (
        <span className={clsx('text-[12px]', row.original.removed ? 'line-through text-fg-faint' : 'text-fg-secondary')}>
          {row.original.name}
          {row.original.removed && (
            <span className="ml-1.5 rounded bg-danger/10 px-1 py-0.5 text-[9px] font-medium text-danger">
              removed
            </span>
          )}
        </span>
      ),
    },
    {
      accessorKey: 'originalFreq',
      header: 'Orig. Freq',
      cell: ({ getValue }) => (
        <span className="text-[12px] tabular-nums text-fg-secondary">{(getValue() as number).toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'simulatedFreq',
      header: 'Sim. Freq',
      cell: ({ row }) => {
        const diff = row.original.simulatedFreq - row.original.originalFreq;
        return (
          <span className={clsx('text-[12px] tabular-nums font-medium', diff < 0 ? 'text-success' : diff > 0 ? 'text-danger' : 'text-fg-secondary')}>
            {row.original.simulatedFreq.toLocaleString()}
          </span>
        );
      },
    },
    {
      id: 'freqChange',
      header: 'Change',
      cell: ({ row }) => {
        const orig = row.original.originalFreq;
        const sim = row.original.simulatedFreq;
        if (orig === 0) return <span className="text-[11px] text-fg-faint">—</span>;
        const pct = ((sim - orig) / orig) * 100;
        const improved = pct <= 0;
        return (
          <span className={clsx('text-[11px] font-semibold tabular-nums', improved ? 'text-success' : 'text-danger')}>
            {formatPct(pct)}
          </span>
        );
      },
    },
  ];

  // ── Improvement banner ───────────────────────────────────────────────────────

  const durationChange = result?.improvement.avg_duration_change_pct ?? 0;
  const isImprovement = durationChange < 0;

  if (eventLogLoading) {
    return <LoadingSpinner size="lg" text="Loading event log…" fullPage />;
  }

  if (!eventLog) {
    return (
      <div className="rounded-xl border border-dashed border-line p-12 text-center">
        <FlaskConical size={28} className="mx-auto text-fg-ghost" />
        <p className="mt-3 text-[13px] font-medium text-fg">Event log not found</p>
        <button onClick={() => navigate('/projects')} className="btn-secondary mt-4 text-[12px]">
          Back to projects
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <PageHeader
        title="What-If Simulation"
        icon={FlaskConical}
        backTo={-1}
        description="Model a process change (scale duration, remove activities, adjust frequencies) and compare simulated outcomes against the original log."
        subtitle={eventLog.name}
      />

      {/* Main content */}
      <div className="mt-6 flex flex-1 gap-4 overflow-hidden">
        {/* ── Left config panel ─────────────────────────────────────────── */}
        <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto xl:w-96">
          {/* Traces input */}
          <div className="card p-4">
            <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Number of Traces
            </label>
            <input
              type="number"
              min={1}
              max={10000}
              value={numTraces}
              onChange={(e) => setNumTraces(Math.max(1, parseInt(e.target.value) || 500))}
              className="input"
            />
            <p className="mt-1.5 text-[11px] text-fg-faint">Simulated traces to generate (1–10,000)</p>
          </div>

          {/* Modifications */}
          <div className="card p-3.5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Modifications
              </span>
              <button
                onClick={addMod}
                className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
              >
                <Plus size={11} />
                Add
              </button>
            </div>

            {modifications.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line py-6 text-center">
                <Minus size={20} className="mx-auto mb-2 text-fg-ghost" />
                <p className="text-[11px] text-fg-faint">No modifications yet.</p>
                <p className="text-[10px] text-fg-ghost">Click "Add" to get started.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {modifications.map((mod, idx) => (
                  <ModCard
                    key={idx}
                    mod={mod}
                    activities={activities}
                    onChange={(m) => updateMod(idx, m)}
                    onDelete={() => deleteMod(idx)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={running}
            className="btn-primary w-full"
          >
            {running ? (
              <span className="flex items-center justify-center gap-2">
                <RefreshCw size={13} className="animate-spin" />
                Running simulation…
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                <FlaskConical size={13} />
                Run Simulation
              </span>
            )}
          </button>
        </div>

        {/* ── Right results panel ───────────────────────────────────────── */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
          {running && (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-line bg-surface-2">
              <div className="text-center">
                <RefreshCw size={28} className="mx-auto mb-3 animate-spin text-accent" />
                <p className="text-[13px] font-medium text-fg-secondary">Running simulation…</p>
                <p className="mt-1 text-[11px] text-fg-muted">Generating {numTraces.toLocaleString()} traces</p>
              </div>
            </div>
          )}

          {!running && !result && (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line bg-surface-1">
              <div className="text-center">
                <FlaskConical size={36} className="mx-auto mb-3 text-fg-ghost" />
                <p className="text-[13px] font-medium text-fg-secondary">Configure and run simulation</p>
                <p className="mt-1 text-[11px] text-fg-muted">
                  Add modifications on the left, then click "Run Simulation"
                </p>
              </div>
            </div>
          )}

          {!running && result && (
            <>
              {/* Improvement banner */}
              <div
                className={clsx(
                  'flex items-center gap-4 rounded-xl border px-5 py-4',
                  isImprovement
                    ? 'border-success/25 bg-success/8'
                    : 'border-danger/25 bg-danger/8',
                )}
              >
                <div className={clsx('rounded-xl p-3', isImprovement ? 'bg-success/15' : 'bg-danger/15')}>
                  {isImprovement
                    ? <TrendingDown size={22} className="text-success" />
                    : <TrendingUp size={22} className="text-danger" />}
                </div>
                <div className="flex-1">
                  <p
                    className={clsx(
                      'text-[28px] font-black leading-none tabular-nums',
                      isImprovement ? 'text-success' : 'text-danger',
                    )}
                  >
                    {formatPct(durationChange)}
                  </p>
                  <p className="mt-0.5 text-[12px] font-medium text-fg-secondary">avg case duration</p>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-semibold text-fg">
                    {result.improvement.case_count_change >= 0 ? '+' : ''}
                    {result.improvement.case_count_change.toLocaleString()} cases
                  </p>
                  {result.improvement.activities_removed.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-fg-muted">
                      {result.improvement.activities_removed.length} activit
                      {result.improvement.activities_removed.length > 1 ? 'ies' : 'y'} removed
                    </p>
                  )}
                </div>
              </div>

              {/* Side-by-side stats */}
              <div className="grid grid-cols-2 gap-3">
                {/* Original */}
                <div className="card p-3.5">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Original
                  </p>
                  <div className="space-y-0.5">
                    {[
                      { label: 'Total Cases', value: result.original.total_cases.toLocaleString() },
                      { label: 'Total Events', value: result.original.total_events.toLocaleString() },
                      { label: 'Avg Duration', value: formatDuration(result.original.avg_case_duration) },
                      { label: 'Median Duration', value: formatDuration(result.original.median_case_duration) },
                      { label: 'Events / Case', value: result.original.avg_events_per_case.toFixed(1) },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center justify-between py-1">
                        <span className="text-[11px] text-fg-muted">{row.label}</span>
                        <span className="text-[11px] font-semibold tabular-nums text-fg-secondary">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Simulated */}
                <div className="card p-3.5">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                    Simulated
                  </p>
                  <div className="space-y-0.5">
                    {([
                      {
                        label: 'Total Cases',
                        orig: result.original.total_cases,
                        sim: result.simulated.total_cases,
                        fmt: (v: number) => v.toLocaleString(),
                        lowerIsBetter: false,
                      },
                      {
                        label: 'Total Events',
                        orig: result.original.total_events,
                        sim: result.simulated.total_events,
                        fmt: (v: number) => v.toLocaleString(),
                        lowerIsBetter: true,
                      },
                      {
                        label: 'Avg Duration',
                        orig: result.original.avg_case_duration,
                        sim: result.simulated.avg_case_duration,
                        fmt: formatDuration,
                        lowerIsBetter: true,
                      },
                      {
                        label: 'Median Duration',
                        orig: result.original.median_case_duration,
                        sim: result.simulated.median_case_duration,
                        fmt: formatDuration,
                        lowerIsBetter: true,
                      },
                      {
                        label: 'Events / Case',
                        orig: result.original.avg_events_per_case,
                        sim: result.simulated.avg_events_per_case,
                        fmt: (v: number) => v.toFixed(1),
                        lowerIsBetter: true,
                      },
                    ] as const).map((row) => {
                      const improved = row.lowerIsBetter ? row.sim < row.orig : row.sim > row.orig;
                      const neutral = row.sim === row.orig;
                      return (
                        <div key={row.label} className="flex items-center justify-between py-1">
                          <span className="text-[11px] text-fg-muted">{row.label}</span>
                          <span
                            className={clsx(
                              'text-[11px] font-semibold tabular-nums',
                              neutral ? 'text-fg-secondary' : improved ? 'text-success' : 'text-danger',
                            )}
                          >
                            {row.fmt(row.sim)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Comparison stats bar chart (inline bar) */}
              <div className="card p-3.5">
                <p className="mb-3 text-[12px] font-semibold text-fg">Metric Comparison</p>
                <div className="space-y-2.5">
                  {[
                    {
                      label: 'Avg Duration',
                      orig: result.original.avg_case_duration,
                      sim: result.simulated.avg_case_duration,
                      fmt: formatDuration,
                      lowerIsBetter: true,
                    },
                    {
                      label: 'Median Duration',
                      orig: result.original.median_case_duration,
                      sim: result.simulated.median_case_duration,
                      fmt: formatDuration,
                      lowerIsBetter: true,
                    },
                    {
                      label: 'Events / Case',
                      orig: result.original.avg_events_per_case,
                      sim: result.simulated.avg_events_per_case,
                      fmt: (v: number) => v.toFixed(1),
                      lowerIsBetter: true,
                    },
                  ].map((row) => {
                    const max = Math.max(row.orig, row.sim) || 1;
                    const origPct = (row.orig / max) * 100;
                    const simPct = (row.sim / max) * 100;
                    const improved = row.lowerIsBetter ? row.sim < row.orig : row.sim > row.orig;
                    return (
                      <div key={row.label}>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[11px] text-fg-muted">{row.label}</span>
                          <div className="flex items-center gap-3 text-[11px]">
                            <span className="text-fg-faint">{row.fmt(row.orig)}</span>
                            <span className={clsx('font-semibold', improved ? 'text-success' : 'text-danger')}>
                              {row.fmt(row.sim)}
                            </span>
                          </div>
                        </div>
                        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className="h-full rounded-l-full bg-fg-faint/30 transition-all"
                            style={{ width: `${origPct}%` }}
                          />
                        </div>
                        <div className="mt-0.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className={clsx(
                              'h-full rounded-l-full transition-all',
                              improved ? 'bg-success/50' : 'bg-danger/50',
                            )}
                            style={{ width: `${simPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Activity comparison table */}
              {activityRows.length > 0 && (
                <div className="card overflow-hidden">
                  <div className="border-b border-line px-4 py-2.5">
                    <h3 className="text-[12px] font-semibold text-fg">Activity Breakdown</h3>
                  </div>
                  <DataTable
                    data={activityRows}
                    columns={activityColumns}
                    searchable
                    searchPlaceholder="Search activities…"
                    paginated
                    pageSize={10}
                    emptyMessage="No activity data"
                  />
                </div>
              )}

              {/* IBM Process Mining-style editable cost table. Lets
                  users price every activity by hourly rate and
                  automation %, projecting total savings live. */}
              {eventLogId && <ActivityCostTable eventLogId={eventLogId} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
