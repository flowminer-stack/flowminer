import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FlaskConical,
  Plus,
  Minus,
  RefreshCw,
  Cpu,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import clsx from 'clsx';
import { mining } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import DESPanel from '@/components/Simulation/DESPanel';
import ModificationCard from '@/components/Simulation/ModificationCard';
import MonteCarloResults from '@/components/Simulation/MonteCarloResults';
import type {
  SimulationModification,
  SimulationResponse,
} from '@/types';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SimulationPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const addNotification = useUIStore((s) => s.addNotification);

  const { eventLog, loading: eventLogLoading } = useEventLogData(eventLogId);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Tab: 'montecarlo' | 'des'
  const kindParam = searchParams.get('kind');
  const focusActivity = searchParams.get('focus');
  const [activeTab, setActiveTab] = useState<'montecarlo' | 'des'>(
    kindParam === 'des' ? 'des' : 'montecarlo',
  );

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
        description="Model a process change and compare simulated outcomes against the original log."
        subtitle={eventLog.name}
      />

      {/* Tab switcher */}
      <div className="mt-4 flex items-center gap-1 rounded-lg border border-line bg-surface-1 p-1 self-start">
        <button
          onClick={() => setActiveTab('montecarlo')}
          className={clsx(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all',
            activeTab === 'montecarlo'
              ? 'bg-surface-2 text-fg shadow-xs'
              : 'text-fg-muted hover:text-fg',
          )}
        >
          <FlaskConical size={13} />
          Monte Carlo
        </button>
        <button
          onClick={() => setActiveTab('des')}
          className={clsx(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all',
            activeTab === 'des'
              ? 'bg-surface-2 text-fg shadow-xs'
              : 'text-fg-muted hover:text-fg',
          )}
        >
          <Cpu size={13} />
          Discrete-Event Simulation
        </button>
      </div>

      {/* ── DES tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'des' && eventLogId && (
        <div className="mt-6 flex flex-1 overflow-hidden">
          <DESPanel
            eventLogId={eventLogId}
            activities={activities}
            focusActivity={focusActivity}
          />
        </div>
      )}

      {/* ── Monte Carlo tab ──────────────────────────────────────────────── */}
      {activeTab === 'montecarlo' && (
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
                    <ModificationCard
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

            {!running && result && eventLogId && (
              <MonteCarloResults result={result} eventLogId={eventLogId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
