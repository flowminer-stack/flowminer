import { useCallback, useState } from 'react';
import { RefreshCw, PackageOpen } from 'lucide-react';
import { ocel } from '@/api/client';
import type { StateAwareResponse } from '@/types';

// ─── State-Aware OCPM Panel ───────────────────────────────────────────────────

export default function StateAwarePanel({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [stateColumn, setStateColumn] = useState('');
  const [objectType, setObjectType] = useState('');
  const [data, setData] = useState<StateAwareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const run = useCallback(() => {
    const col = stateColumn.trim();
    if (!col) return;
    setLoading(true);
    setError(null);
    setUnavailable(null);
    setData(null);
    ocel.getStateAware(ocelId, col, objectType || undefined)
      .then((d) => setData(d))
      .catch((e) => {
        const status = e?.response?.status;
        const detail = e?.response?.data?.detail;
        if (status === 501) {
          setUnavailable(detail ?? 'State-aware OCPM is not available in this environment.');
        } else {
          setError(detail ?? e.message ?? 'Request failed');
        }
      })
      .finally(() => setLoading(false));
  }, [ocelId, stateColumn, objectType]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-fg-muted">
        State-Aware OCPM (Kretzschmann, Berti &amp; van der Aalst, EDOC 2025) materializes every change of an
        object attribute into a synthetic transition event and annotates existing events with the current
        object state — unlocking lifecycle analysis on standard OCEL 2.0 logs.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface-1 p-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">State attribute column</label>
          <input
            type="text"
            value={stateColumn}
            onChange={(e) => setStateColumn(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="e.g. status"
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-secondary focus:border-accent/50 focus:outline-none"
            style={{ minWidth: 180 }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Object type (optional)</label>
          <select
            value={objectType}
            onChange={(e) => setObjectType(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-secondary focus:border-accent/50 focus:outline-none"
            style={{ minWidth: 160 }}
          >
            <option value="">All object types</option>
            {objectTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <button
          onClick={run}
          disabled={loading || !stateColumn.trim()}
          className="btn-primary text-[12px]"
        >
          {loading ? <><RefreshCw size={13} className="animate-spin" /> Enriching…</> : 'Enrich with state transitions'}
        </button>
      </div>

      {unavailable && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
          <div className="rounded-lg bg-tint p-2.5 text-fg-muted">
            <PackageOpen size={22} />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-fg">State-aware enrichment unavailable</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">{unavailable}</p>
          </div>
        </div>
      )}
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {data && (
        <div className="flex flex-col gap-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'New events', value: data.new_events_count.toLocaleString() },
              { label: 'Annotated', value: data.annotated_events.toLocaleString() },
              { label: 'Transitions', value: data.state_transitions.length.toLocaleString() },
              { label: 'Stateful types', value: Object.keys(data.distinct_states).length.toLocaleString() },
            ].map((card) => (
              <div key={card.label} className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">{card.value}</p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">{card.label}</p>
              </div>
            ))}
          </div>

          {data.note && <p className="text-[10px] text-fg-faint">{data.note}</p>}

          {/* Distinct states per object type */}
          {Object.keys(data.distinct_states).length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Distinct States by Object Type</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(data.distinct_states).map(([type, states]) => (
                  <div key={type} className="rounded-md border border-line bg-surface-1 px-3 py-2">
                    <p className="text-[11px] font-semibold text-accent truncate" title={type}>{type}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {states.map((s) => (
                        <span key={s} className="rounded bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted truncate max-w-[140px]" title={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* State transition sample */}
          {data.state_transitions.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold text-fg-secondary">
                State Transitions {data.state_transitions.length > 50 && <span className="text-fg-faint">(first 50 of {data.state_transitions.length.toLocaleString()})</span>}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr>
                      {['Object', 'Type', 'From', 'To', 'Activity', 'Timestamp'].map((h) => (
                        <th key={h} className="border-b border-line pb-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.state_transitions.slice(0, 50).map((t, i) => (
                      <tr key={i} className="hover:bg-tint/50 transition-colors">
                        <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-secondary truncate max-w-[120px]" title={t.oid}>{t.oid}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.object_type}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.from_state ?? <span className="text-fg-ghost">—</span>}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 font-medium text-fg whitespace-nowrap">{t.to_state}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.activity}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted whitespace-nowrap">{t.timestamp.slice(0, 19).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
