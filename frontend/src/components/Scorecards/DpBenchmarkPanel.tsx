/**
 * DpBenchmarkPanel
 *
 * Differential-privacy cross-team benchmark. Lets the user pick ≥1 event
 * logs and an epsilon budget, calls POST /scorecards/dp-benchmark, and
 * renders the noised per-log stats (avg case duration, case count) plus the
 * noise scale that was applied. No raw case data ever leaves a log — every
 * value carries calibrated Laplace noise.
 *
 * Self-contained: takes only `projectId`; it lists the project's event logs
 * itself so it can be dropped onto the benchmark page.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, ShieldCheck, Info } from 'lucide-react';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import { eventLogs as eventLogsApi } from '@/api/eventLogs';
import { dpBenchmark } from '@/api/scorecards';
import type { EventLog } from '@/types';
import type { DpBenchmarkResult } from '@/types/scorecards';
import { formatDuration } from '@/utils/format';

interface Props {
  projectId: string;
}

// Epsilon presets: lower = more privacy / more noise.
const EPSILON_PRESETS: { value: number; label: string }[] = [
  { value: 0.5, label: '0.5 · high privacy' },
  { value: 1.0, label: '1.0 · balanced' },
  { value: 2.0, label: '2.0 · low privacy' },
];

function errMessage(e: unknown): string {
  const ax = e as { response?: { data?: { detail?: string } }; message?: string };
  return ax?.response?.data?.detail || ax?.message || 'Benchmark failed.';
}

export default function DpBenchmarkPanel({ projectId }: Props) {
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [epsilon, setEpsilon] = useState<number>(1.0);

  const [result, setResult] = useState<DpBenchmarkResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Only standard logs (with a case id) can be benchmarked.
  const benchmarkable = useMemo(
    () => logs.filter((l) => l.case_id_column),
    [logs],
  );

  useEffect(() => {
    if (!projectId) return;
    setLoadingLogs(true);
    setLogsError(null);
    eventLogsApi
      .list(projectId)
      .then((r) => {
        setLogs(r);
        const usable = r.filter((l) => l.case_id_column);
        setSelected(usable.slice(0, Math.min(4, usable.length)).map((l) => l.id));
      })
      .catch((e) => setLogsError(errMessage(e)))
      .finally(() => setLoadingLogs(false));
  }, [projectId]);

  const nameFor = (id: string) =>
    logs.find((l) => l.id === id)?.name || id.slice(0, 8);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const run = async () => {
    if (selected.length === 0) return;
    setRunning(true);
    setRunError(null);
    try {
      const r = await dpBenchmark({ event_log_ids: selected, epsilon });
      setResult(r);
    } catch (e) {
      setRunError(errMessage(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  if (loadingLogs) {
    return <LoadingSpinner size="md" text="Loading event logs…" />;
  }

  if (logsError) {
    return <ErrorState message={logsError} />;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <ShieldCheck size={17} />
        </div>
        <div>
          <h2 className="text-[14px] font-semibold text-fg">
            Differential-Privacy Benchmark
          </h2>
          <p className="text-[11px] text-fg-muted">
            Compare case duration and volume across logs with calibrated
            Laplace noise. No raw case data leaves any log.
          </p>
        </div>
      </div>

      {benchmarkable.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No benchmarkable logs"
          description="This project has no event logs with a mapped case id. Map a case id column to include a log in the benchmark."
          compact
        />
      ) : (
        <>
          {/* Log selector */}
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <h3 className="mb-3 text-[12px] font-semibold text-fg">
              Select logs ({selected.length} selected)
            </h3>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {benchmarkable.map((l) => {
                const isSel = selected.includes(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => toggle(l.id)}
                    className={`truncate rounded border px-3 py-2 text-left text-[13px] transition-colors ${
                      isSel
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-line text-fg-muted hover:bg-tint/40'
                    }`}
                    title={l.name}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Epsilon + run */}
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-line bg-surface-1 p-4">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-fg-faint">
                Privacy budget (epsilon)
              </span>
              <select
                value={epsilon}
                onChange={(e) => setEpsilon(Number(e.target.value))}
                className="select text-[12px]"
              >
                {EPSILON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={run}
              disabled={running || selected.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {running ? 'Running…' : 'Run benchmark'}
            </button>
          </div>

          {runError && <ErrorState message={runError} onRetry={run} compact />}

          {running && (
            <LoadingSpinner size="md" text="Applying differential privacy…" />
          )}

          {/* Results */}
          {result && !running && (
            <div className="space-y-3">
              {result.results.length === 0 ? (
                <EmptyState
                  title="No results returned"
                  description="None of the selected logs could be benchmarked (inaccessible or empty)."
                  compact
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-[12px]">
                    <thead className="bg-tint/40 text-fg-faint">
                      <tr>
                        <th className="px-3 py-2 text-left">Log</th>
                        <th className="px-3 py-2 text-right">
                          Avg duration (noised)
                        </th>
                        <th className="px-3 py-2 text-right">Cases (noised)</th>
                        <th className="px-3 py-2 text-right">Noise (duration)</th>
                        <th className="px-3 py-2 text-right">Noise (count)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.results.map((r) => (
                        <tr
                          key={r.event_log_id}
                          className="border-t border-line text-fg"
                        >
                          <td className="px-3 py-2 text-fg-secondary">
                            {nameFor(r.event_log_id)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatDuration(r.dp_avg_case_duration_seconds)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.dp_case_count.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-fg-faint">
                            ±{r.noise_scale_mean.toLocaleString()}s
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-fg-faint">
                            ±{r.noise_scale_count.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-start gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-2 text-[11px] text-fg-muted">
                <Info size={13} className="mt-0.5 shrink-0 text-fg-faint" />
                <span>
                  Epsilon {result.epsilon} · {result.count} log
                  {result.count === 1 ? '' : 's'}. {result.note}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
