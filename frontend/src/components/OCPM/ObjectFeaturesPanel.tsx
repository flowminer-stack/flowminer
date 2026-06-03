import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ocel } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';
import type { OCELFeaturesResponse } from '@/types';

// ─── OCEL-Native: Object Features ────────────────────────────────────────────

function cleanColumnName(name: string): string {
  return name
    .replace(/^@@/, '')
    .replace(/^ocel[_:]?/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || name;
}

// Identify the most useful feature columns to show prominently
const KEY_FEATURE_PATTERNS = [
  'lifecycle_length', 'lifecycle_duration', 'degree_centrality',
  'unique_activities', 'start_timestamp', 'end_timestamp',
  'num_', 'count', 'duration', 'wip',
];

export default function ObjectFeaturesPanel({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [selectedType, setSelectedType] = useState(objectTypes[0] ?? '');
  const featureKey = `ocel_features:${selectedType}`;
  const cached = getCached<OCELFeaturesResponse>(ocelId, featureKey);
  const [data, setData] = useState<OCELFeaturesResponse | null>(cached);
  const [loading, setLoading] = useState(!cached && !!selectedType);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedType) return;
    const key = `ocel_features:${selectedType}`;
    const existing = getCached<OCELFeaturesResponse>(ocelId, key);
    if (existing) { setData(existing); setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);
    setData(null);
    ocel.getOCELFeatures(ocelId, selectedType)
      .then((d) => { setCached(ocelId, key, d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId, selectedType]);

  const handleDownload = () => {
    if (!data) return;
    const header = data.columns.join(',');
    const csvRows = data.rows.map((row) =>
      data.columns.map((c) => {
        const v = row[c];
        const s = v === null || v === undefined ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    );
    const blob = new Blob([header + '\n' + csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `features_${selectedType}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-fg-muted shrink-0">Object type:</label>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          className="rounded-md border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg-secondary focus:outline-none focus:border-accent/50"
        >
          {objectTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {data && data.rows.length > 0 && (
          <button onClick={handleDownload} className="btn-ghost ml-auto text-[11px]">
            <Download size={12} />
            Download CSV
          </button>
        )}
      </div>

      {loading && <div className="flex justify-center py-6"><LoadingSpinner size="sm" text="Extracting features…" /></div>}
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {data && (
        <>
          <div className="flex gap-3 text-[11px]">
            <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
              <p className="text-[18px] font-bold tabular-nums text-fg">{data.total_objects.toLocaleString()}</p>
              <p className="text-[9px] uppercase tracking-wider text-fg-faint mt-0.5">objects</p>
            </div>
            <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
              <p className="text-[18px] font-bold tabular-nums text-fg">{data.columns.length}</p>
              <p className="text-[9px] uppercase tracking-wider text-fg-faint mt-0.5">features</p>
            </div>
          </div>

          {data.columns.length > 0 && data.rows.length > 0 ? (
            <>
              {/* Key features summary — show averages of numeric columns */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.columns
                  .filter((col) => {
                    // Only show numeric columns with interesting names
                    const lower = col.toLowerCase();
                    return KEY_FEATURE_PATTERNS.some((p) => lower.includes(p)) ||
                      (data.rows[0]?.[col] !== null && typeof data.rows[0]?.[col] === 'number');
                  })
                  .slice(0, 9)
                  .map((col) => {
                    const vals = data.rows.map((r) => r[col]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
                    const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                    const min = vals.length > 0 ? Math.min(...vals) : null;
                    const max = vals.length > 0 ? Math.max(...vals) : null;
                    const fmt = (v: number | null) => {
                      if (v === null) return '—';
                      if (Math.abs(v) > 86400) return `${(v / 86400).toFixed(1)}d`;
                      if (Math.abs(v) > 3600) return `${(v / 3600).toFixed(1)}h`;
                      if (Math.abs(v) > 60) return `${(v / 60).toFixed(1)}m`;
                      if (Number.isInteger(v)) return v.toLocaleString();
                      return v.toFixed(2);
                    };
                    return (
                      <div key={col} className="rounded-md border border-line bg-surface-1 px-3 py-2">
                        <p className="text-[10px] text-fg-muted truncate" title={col}>{cleanColumnName(col)}</p>
                        <p className="text-[16px] font-bold tabular-nums text-fg mt-0.5">{fmt(avg)}</p>
                        {min !== null && max !== null && (
                          <p className="text-[9px] text-fg-faint mt-0.5">min {fmt(min)} &middot; max {fmt(max)}</p>
                        )}
                      </div>
                    );
                  })}
              </div>

              {/* All features list */}
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium text-fg-secondary hover:text-fg select-none">
                  All {data.columns.length} features — preview table
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr>
                        {data.columns.map((col) => (
                          <th key={col} className="border-b border-line pb-1.5 px-2 text-left text-[10px] font-semibold tracking-wider text-fg-faint whitespace-nowrap">
                            {cleanColumnName(col)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.slice(0, 10).map((row, i) => (
                        <tr key={i} className="hover:bg-tint/50 transition-colors">
                          {data.columns.map((col) => {
                            const v = row[col];
                            const display = v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v).slice(0, 40);
                            return (
                              <td key={col} className="border-b border-line/40 py-1.5 px-2 tabular-nums text-fg-secondary whitespace-nowrap">{display}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="text-[12px] text-fg-muted py-2 text-center">No feature data available for this type.</p>
          )}
        </>
      )}
    </div>
  );
}
