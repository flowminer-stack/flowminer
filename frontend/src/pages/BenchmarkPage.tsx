import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BarChart3, Boxes, ChevronRight, Loader2 } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  analytics as analyticsApi,
  eventLogs as eventLogsApi,
  ocel as ocelApi,
} from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore } from '@/store';

type FlattenKey = string; // `${ocelId}:${objectType}`

export default function BenchmarkPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const addNotification = useUIStore((s) => s.addNotification);

  const [logs, setLogs] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ocelId:objectType -> flattened event_log_id (lazy cache)
  const [flattenCache, setFlattenCache] = useState<Record<FlattenKey, string>>({});
  // ocelId:objectType currently being flattened
  const [flattening, setFlattening] = useState<Set<FlattenKey>>(new Set());
  // Human label per flattened event_log_id (for the table + chart)
  const [flattenLabels, setFlattenLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!projectId) return;
    eventLogsApi
      .list(projectId)
      .then((r) => {
        setLogs(r);
        const benchmarkable = r.filter((l: any) => l.case_id_column);
        setSelected(benchmarkable.slice(0, Math.min(4, benchmarkable.length)).map((l: any) => l.id));
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  const runBenchmark = async () => {
    if (selected.length === 0) {
      setResult(null);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const r = await analyticsApi.benchmark(selected);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load benchmark data');
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    runBenchmark();
  }, [JSON.stringify(selected)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy flatten: pick an OCEL object type, create/reuse a hidden flat log,
  // toggle its event_log_id in `selected`.
  const toggleOcelSlice = async (ocelLog: any, objectType: string) => {
    const key: FlattenKey = `${ocelLog.id}:${objectType}`;
    const cached = flattenCache[key];

    if (cached) {
      setSelected((s) => (s.includes(cached) ? s.filter((x) => x !== cached) : [...s, cached]));
      return;
    }

    setFlattening((f) => new Set(f).add(key));
    try {
      const r = await ocelApi.flatten(ocelLog.id, objectType);
      setFlattenCache((c) => ({ ...c, [key]: r.event_log_id }));
      setFlattenLabels((m) => ({
        ...m,
        [r.event_log_id]: `${ocelLog.name} — ${objectType}`,
      }));
      setSelected((s) => (s.includes(r.event_log_id) ? s : [...s, r.event_log_id]));
    } catch (e: any) {
      // Flatten is per-chip, non-fatal: surface as a toast, don't kill the page.
      addNotification({
        type: 'error',
        title: `Flattening "${objectType}" failed`,
        message: e?.response?.data?.detail || e?.message || `Could not flatten ${ocelLog.name}`,
      });
    } finally {
      setFlattening((f) => {
        const next = new Set(f);
        next.delete(key);
        return next;
      });
    }
  };

  const { standardLogs, ocelLogs } = useMemo(() => {
    const standard = logs.filter((l) => l.case_id_column);
    const ocel = logs.filter((l) => !l.case_id_column && Array.isArray(l.object_types) && l.object_types.length > 0);
    return { standardLogs: standard, ocelLogs: ocel };
  }, [logs]);

  if (loading) return <LoadingSpinner size="lg" text="Loading..." fullPage />;
  if (error) return <ErrorState message={error} onRetry={runBenchmark} />;

  const chartData = (result?.processes || [])
    .filter((p: any) => p.kpis)
    .map((p: any) => {
      const name = flattenLabels[p.event_log_id] || p.name || '?';
      return {
        name: name.length > 24 ? name.slice(0, 24) + '…' : name,
        cases: p.kpis.cases,
        avg_dur_hours: +(p.kpis.avg_case_duration_sec / 3600).toFixed(2),
        variants: p.kpis.variants,
        top_variant_share: Math.round(p.kpis.top_variant_share * 100),
      };
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cross-Process Benchmark"
        icon={BarChart3}
        description="Compare KPIs across event logs (federated: no raw data shared). OCEL logs expose each object type as a selectable flattened view."
        backTo={-1}
      />

      <div className="rounded-lg border border-line bg-surface-1 p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-fg">Select processes</h2>

        {/* Standard logs */}
        {standardLogs.length > 0 && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {standardLogs.map((l) => {
              const isSel = selected.includes(l.id);
              return (
                <button
                  key={l.id}
                  onClick={() =>
                    setSelected((s) => (isSel ? s.filter((x) => x !== l.id) : [...s, l.id]))
                  }
                  className={`rounded border px-3 py-2 text-left text-[13px] transition-colors ${
                    isSel
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line text-fg-muted hover:bg-tint/40'
                  }`}
                >
                  {l.name}
                </button>
              );
            })}
          </div>
        )}

        {/* OCEL logs — expandable into object-type slices */}
        {ocelLogs.length > 0 && (
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-muted">
              <Boxes size={13} className="text-accent" />
              OCEL logs — pick an object type to use as the case
            </div>
            {ocelLogs.map((l) => (
              <div
                key={l.id}
                className="rounded border border-line bg-surface-2 p-3"
              >
                <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
                  <span className="truncate">{l.name}</span>
                  <span className="badge badge-accent">OCEL</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {l.object_types.map((ot: string) => {
                    const key: FlattenKey = `${l.id}:${ot}`;
                    const cached = flattenCache[key];
                    const isSel = !!cached && selected.includes(cached);
                    const busy = flattening.has(key);
                    return (
                      <button
                        key={ot}
                        disabled={busy}
                        onClick={() => toggleOcelSlice(l, ot)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                          isSel
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-line bg-surface-1 text-fg-muted hover:bg-tint/40'
                        } ${busy ? 'cursor-wait opacity-70' : ''}`}
                        title={
                          cached
                            ? isSel
                              ? 'Click to remove from benchmark'
                              : 'Click to add to benchmark'
                            : 'Flatten on first use'
                        }
                      >
                        {busy ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <ChevronRight size={11} />
                        )}
                        {ot}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {standardLogs.length === 0 && ocelLogs.length === 0 && (
          <p className="text-[12px] text-fg-muted">No event logs in this project yet.</p>
        )}
      </div>

      {running && <LoadingSpinner size="md" text="Computing benchmark..." />}

      {result && (
        <>
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Avg case duration by process (hours)</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }}
                    angle={-25}
                    textAnchor="end"
                    height={50}
                  />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--color-fg-faint)' }} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-line)',
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                  />
                  <Bar dataKey="avg_dur_hours" fill="#06b6d4" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface-1">
            <table className="w-full text-[12px]">
              <thead className="bg-tint/40 text-fg-faint">
                <tr>
                  <th className="px-3 py-2 text-left">Process</th>
                  <th className="px-3 py-2 text-right">Cases</th>
                  <th className="px-3 py-2 text-right">Variants</th>
                  <th className="px-3 py-2 text-right">Avg duration (h)</th>
                  <th className="px-3 py-2 text-right">Top variant share</th>
                  <th className="px-3 py-2 text-right">Duration percentile</th>
                </tr>
              </thead>
              <tbody>
                {(result.processes || [])
                  .filter((p: any) => p.kpis)
                  .map((p: any) => (
                    <tr key={p.event_log_id} className="border-t border-line text-fg">
                      <td className="px-3 py-2 text-fg-secondary">
                        {flattenLabels[p.event_log_id] || p.name}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.kpis.cases}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.kpis.variants}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(p.kpis.avg_case_duration_sec / 3600).toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Math.round(p.kpis.top_variant_share * 100)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Math.round((p.kpis.duration_percentile || 0) * 100)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
