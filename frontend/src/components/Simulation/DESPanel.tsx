import { useState, useCallback, useEffect, useRef } from 'react';
import {
  X,
  TrendingDown,
  TrendingUp,
  RefreshCw,
  Cpu,
  Users,
  Zap,
  Plus,
} from 'lucide-react';
import clsx from 'clsx';
import { mining } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { formatDuration } from '@/utils/format';
import { formatPct } from './format';
import type {
  DESParameters,
  DESScenario,
  DESSimulationResult,
} from '@/types';

// ─── DES Panel ───────────────────────────────────────────────────────────────

interface DESPanelProps {
  eventLogId: string;
  activities: string[];
  focusActivity?: string | null;
}

export default function DESPanel({ eventLogId, activities, focusActivity }: DESPanelProps) {
  const addNotification = useUIStore((s) => s.addNotification);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const [params, setParams] = useState<DESParameters | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);

  // Scenario state
  const [arrivalMult, setArrivalMult] = useState(1.0);
  const [durOverrides, setDurOverrides] = useState<Record<string, number>>({});
  const [automations, setAutomations] = useState<Record<string, boolean>>({});
  const [poolOverrides, setPoolOverrides] = useState<Record<string, number>>({});
  const [newResources, setNewResources] = useState<Array<{ name: string; capacity: number }>>([]);

  const [runs, setRuns] = useState(5);
  const [maxCases, setMaxCases] = useState(500);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DESSimulationResult | null>(null);

  // Pre-fill automation toggle if navigated from BottlenecksPage
  useEffect(() => {
    if (focusActivity) {
      setAutomations((prev) => ({ ...prev, [focusActivity]: true }));
    }
  }, [focusActivity]);

  useEffect(() => {
    let cancelled = false;
    setParamsLoading(true);
    mining.getDESParams(eventLogId)
      .then((p) => {
        if (!cancelled) {
          setParams(p);
          // Init pool overrides from mined params
          const pools: Record<string, number> = {};
          for (const [name, info] of Object.entries(p.resource_pools)) {
            pools[name] = info.capacity;
          }
          setPoolOverrides(pools);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          addNotification({
            type: 'error',
            title: 'Failed to load DES parameters',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      })
      .finally(() => { if (!cancelled) setParamsLoading(false); });
    return () => { cancelled = true; };
  }, [eventLogId, addNotification]);

  const handleRun = useCallback(async () => {
    if (!params) return;
    setRunning(true);
    setResult(null);
    const scenario: DESScenario = {
      arrival_rate_multiplier: arrivalMult,
      activity_duration_overrides: durOverrides,
      activity_automation: automations,
      resource_pool_overrides: poolOverrides,
      new_resources: newResources,
    };
    try {
      const r = await mining.runDESSimulation(eventLogId, scenario, runs, maxCases);
      if (mountedRef.current) setResult(r);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'DES simulation failed',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [params, arrivalMult, durOverrides, automations, poolOverrides, newResources, runs, maxCases, eventLogId, addNotification]);

  if (paramsLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner size="lg" text="Mining simulation parameters…" />
      </div>
    );
  }

  const actList = params ? Object.keys(params.activity_durations) : activities;
  const poolNames = params ? Object.keys(params.resource_pools) : [];

  const casesPerDay = params
    ? (86400 / Math.max(params.arrival_distribution.mean_inter_arrival_s, 1)).toFixed(1)
    : '—';

  return (
    <div className="flex flex-1 gap-4 overflow-hidden">
      {/* ── Config panel ─────────────────────────────────────────────────── */}
      <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto xl:w-96">

        {/* Arrival rate */}
        <div className="card p-4">
          <label className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Arrival Rate
          </label>
          <p className="mb-2 text-[11px] text-fg-muted">
            Observed: <span className="font-semibold text-fg-secondary">{casesPerDay} cases/day</span>
          </p>
          <label className="mb-1 block text-[10px] font-medium text-fg-muted">
            Multiplier: {arrivalMult.toFixed(2)}x
          </label>
          <input
            type="range" min={0.1} max={5.0} step={0.05}
            value={arrivalMult}
            onChange={(e) => setArrivalMult(parseFloat(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-fg-faint">
            <span>0.1x</span><span>5x</span>
          </div>
        </div>

        {/* Activity duration overrides */}
        {actList.length > 0 && (
          <div className="card p-4">
            <label className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Activity Duration Overrides
            </label>
            <div className="space-y-3 max-h-56 overflow-y-auto">
              {actList.map((act) => {
                const info = params?.activity_durations[act];
                const mult = durOverrides[act] ?? 1.0;
                const isAuto = automations[act] ?? false;
                return (
                  <div key={act} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-[11px] text-fg-secondary" title={act}>
                        {act}
                      </span>
                      <label className="flex items-center gap-1 text-[10px] text-fg-muted cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={isAuto}
                          onChange={(e) =>
                            setAutomations((prev) => ({ ...prev, [act]: e.target.checked }))
                          }
                          className="accent-accent"
                        />
                        <Zap size={10} className="text-accent" />
                        Auto
                      </label>
                    </div>
                    {!isAuto && (
                      <>
                        {info && (
                          <p className="text-[9px] text-fg-faint">
                            mean {formatDuration(info.mean)} · std {formatDuration(info.std)}
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <input
                            type="range" min={0.1} max={3.0} step={0.05}
                            value={mult}
                            onChange={(e) =>
                              setDurOverrides((prev) => ({ ...prev, [act]: parseFloat(e.target.value) }))
                            }
                            className="flex-1 accent-accent"
                          />
                          <span className="w-10 text-right text-[10px] tabular-nums text-fg-secondary">
                            {mult.toFixed(2)}x
                          </span>
                        </div>
                      </>
                    )}
                    {isAuto && (
                      <p className="text-[10px] text-success">Duration set to 0 (automated)</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Resource pools */}
        {poolNames.length > 0 && (
          <div className="card p-4">
            <label className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Resource Pools
            </label>
            <div className="space-y-2.5 max-h-48 overflow-y-auto">
              {poolNames.map((name) => {
                const info = params!.resource_pools[name];
                const cap = poolOverrides[name] ?? info.capacity;
                return (
                  <div key={name} className="flex items-center gap-2">
                    <Users size={12} className="shrink-0 text-fg-faint" />
                    <span className="flex-1 truncate text-[11px] text-fg-secondary" title={name}>
                      {name}
                    </span>
                    <input
                      type="number" min={1} max={100}
                      value={cap}
                      onChange={(e) =>
                        setPoolOverrides((prev) => ({
                          ...prev,
                          [name]: Math.max(1, parseInt(e.target.value) || 1),
                        }))
                      }
                      className="w-14 rounded border border-line bg-surface-1 px-1.5 py-0.5 text-right text-[11px] tabular-nums text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>
                );
              })}
            </div>

            {/* Add resource */}
            <button
              className="mt-3 flex items-center gap-1 text-[11px] text-accent hover:underline"
              onClick={() =>
                setNewResources((prev) => [...prev, { name: `Resource ${prev.length + 1}`, capacity: 1 }])
              }
            >
              <Plus size={11} /> Add resource
            </button>
            {newResources.map((nr, idx) => (
              <div key={idx} className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={nr.name}
                  onChange={(e) =>
                    setNewResources((prev) => prev.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))
                  }
                  className="flex-1 rounded border border-line bg-surface-1 px-2 py-0.5 text-[11px] text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="Resource name"
                />
                <input
                  type="number" min={1} max={100}
                  value={nr.capacity}
                  onChange={(e) =>
                    setNewResources((prev) =>
                      prev.map((r, i) => i === idx ? { ...r, capacity: Math.max(1, parseInt(e.target.value) || 1) } : r)
                    )
                  }
                  className="w-14 rounded border border-line bg-surface-1 px-1.5 py-0.5 text-right text-[11px] tabular-nums text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={() => setNewResources((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-fg-faint hover:text-danger"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Sim settings */}
        <div className="card p-4">
          <label className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Simulation Settings
          </label>
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium text-fg-muted">
                Replications: {runs}
              </label>
              <input type="range" min={1} max={20} step={1} value={runs}
                onChange={(e) => setRuns(parseInt(e.target.value))}
                className="w-full accent-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-fg-muted">
                Max cases per run: {maxCases.toLocaleString()}
              </label>
              <input type="range" min={50} max={5000} step={50} value={maxCases}
                onChange={(e) => setMaxCases(parseInt(e.target.value))}
                className="w-full accent-accent"
              />
            </div>
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={running || !params}
          className="btn-primary w-full"
        >
          {running ? (
            <span className="flex items-center justify-center gap-2">
              <RefreshCw size={13} className="animate-spin" />
              Running DES…
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Cpu size={13} />
              Run DES Simulation
            </span>
          )}
        </button>
      </div>

      {/* ── Results panel ───────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {running && (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-line bg-surface-2">
            <div className="text-center">
              <RefreshCw size={28} className="mx-auto mb-3 animate-spin text-accent" />
              <p className="text-[13px] font-medium text-fg-secondary">Running DES…</p>
              <p className="mt-1 text-[11px] text-fg-muted">{runs} replications × {maxCases.toLocaleString()} cases</p>
            </div>
          </div>
        )}

        {!running && !result && (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line bg-surface-1">
            <div className="text-center">
              <Cpu size={36} className="mx-auto mb-3 text-fg-ghost" />
              <p className="text-[13px] font-medium text-fg-secondary">Configure scenario and run</p>
              <p className="mt-1 text-[11px] text-fg-muted">
                Set arrival rate, activity overrides, and resource capacities, then click "Run DES Simulation"
              </p>
            </div>
          </div>
        )}

        {!running && result && (
          <>
            {/* Delta banner */}
            {(() => {
              const durDelta = result.delta['avg_case_duration_pct'] ?? 0;
              const isImproved = durDelta < 0;
              return (
                <div
                  className={clsx(
                    'flex items-center gap-4 rounded-xl border px-5 py-4',
                    isImproved ? 'border-success/25 bg-success/8' : 'border-danger/25 bg-danger/8',
                  )}
                >
                  <div className={clsx('rounded-xl p-3', isImproved ? 'bg-success/15' : 'bg-danger/15')}>
                    {isImproved
                      ? <TrendingDown size={22} className="text-success" />
                      : <TrendingUp size={22} className="text-danger" />}
                  </div>
                  <div className="flex-1">
                    <p className={clsx('text-[28px] font-black leading-none tabular-nums', isImproved ? 'text-success' : 'text-danger')}>
                      {formatPct(durDelta)}
                    </p>
                    <p className="mt-0.5 text-[12px] font-medium text-fg-secondary">avg case duration vs baseline</p>
                  </div>
                  <div className="text-right text-[12px]">
                    <p className="font-semibold text-fg">
                      {result.summary.throughput_cases_per_day.toFixed(1)} cases/day
                    </p>
                    <p className="text-fg-muted">{result.runs} replications</p>
                  </div>
                </div>
              );
            })()}

            {/* Scenario vs Baseline cards */}
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  { label: 'Baseline', data: result.baseline },
                  { label: 'Scenario', data: result.summary },
                ] as const
              ).map(({ label, data }) => (
                <div key={label} className="card p-3.5">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">{label}</p>
                  <div className="space-y-0.5">
                    {[
                      { label: 'Avg duration', value: formatDuration(data.avg_case_duration_s) },
                      { label: 'P50', value: formatDuration(data.p50) },
                      { label: 'P90', value: formatDuration(data.p90) },
                      { label: 'P95', value: formatDuration(data.p95) },
                      { label: 'Throughput', value: `${data.throughput_cases_per_day.toFixed(1)}/day` },
                      { label: 'Max concurrent', value: data.max_concurrent_cases.toString() },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center justify-between py-1">
                        <span className="text-[11px] text-fg-muted">{row.label}</span>
                        <span className="text-[11px] font-semibold tabular-nums text-fg-secondary">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Metric deltas */}
            <div className="card p-3.5">
              <p className="mb-3 text-[12px] font-semibold text-fg">Scenario vs Baseline Delta</p>
              <div className="space-y-2">
                {[
                  { key: 'avg_case_duration_pct', label: 'Avg Duration', lowerBetter: true },
                  { key: 'p50_pct', label: 'P50 Duration', lowerBetter: true },
                  { key: 'p90_pct', label: 'P90 Duration', lowerBetter: true },
                  { key: 'throughput_pct', label: 'Throughput', lowerBetter: false },
                ].map(({ key, label, lowerBetter }) => {
                  const val = result.delta[key] ?? 0;
                  const improved = lowerBetter ? val < 0 : val > 0;
                  return (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-[11px] text-fg-muted">{label}</span>
                      <span className={clsx('text-[12px] font-bold tabular-nums', improved ? 'text-success' : val === 0 ? 'text-fg-secondary' : 'text-danger')}>
                        {formatPct(val)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Resource utilization bars */}
            {Object.keys(result.summary.resource_utilization).length > 0 && (
              <div className="card p-3.5">
                <p className="mb-3 text-[12px] font-semibold text-fg">Resource Utilization</p>
                <div className="space-y-2.5">
                  {Object.entries(result.summary.resource_utilization).map(([res, util]) => {
                    const baseUtil = result.baseline.resource_utilization[res] ?? util;
                    const pct = Math.round(util * 100);
                    const basePct = Math.round(baseUtil * 100);
                    const isHigh = util > 0.85;
                    return (
                      <div key={res}>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="truncate text-[11px] text-fg-muted" title={res}>{res}</span>
                          <span className={clsx('text-[11px] font-semibold tabular-nums', isHigh ? 'text-danger' : 'text-success')}>
                            {pct}%
                            {basePct !== pct && (
                              <span className="ml-1 text-[9px] text-fg-faint">(was {basePct}%)</span>
                            )}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className={clsx('h-full rounded-full transition-all', isHigh ? 'bg-danger/70' : 'bg-success/60')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
