import { useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { ClusterResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { PieChart } from 'lucide-react';
import clsx from 'clsx';

interface Props { eventLogId: string; }

function fmtDuration(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

const clusterColors = [
  { border: 'border-accent/40', bg: 'bg-accent/5', badge: 'bg-accent/10 text-accent' },
  { border: 'border-accent/40', bg: 'bg-accent/5', badge: 'bg-accent/10 text-accent' },
  { border: 'border-success/40', bg: 'bg-success/5', badge: 'bg-success/10 text-success' },
  { border: 'border-warning/40', bg: 'bg-warning/5', badge: 'bg-warning/10 text-warning' },
  { border: 'border-danger/40', bg: 'bg-danger/5', badge: 'bg-danger/10 text-danger' },
];

export default function CaseClustering({ eventLogId }: Props) {
  const [nClusters, setNClusters] = useState(3);
  const [inputVal, setInputVal] = useState('3');
  const [data, setData] = useState<ClusterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    const n = parseInt(inputVal, 10);
    if (!n || n < 2 || n > 20) return;
    setNClusters(n);
    setLoading(true);
    setError(null);
    miningApi.clusterCases(eventLogId, n)
      .then(setData)
      .catch(() => setError('Failed to cluster cases'))
      .finally(() => setLoading(false));
  };

  return (
    <div className="space-y-4">
      <p className="mb-3 text-[11px] text-fg-muted">Groups similar cases by behavior. Different clusters may represent different process variants, customer segments, or issue types.</p>
      {/* Controls */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-medium text-fg-secondary">Number of clusters:</label>
        <input
          type="number"
          min={2}
          max={20}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          className="w-16 rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
        />
        <button
          onClick={run}
          disabled={loading}
          className={clsx(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            loading ? 'cursor-not-allowed opacity-50 bg-tint text-fg-muted' : 'bg-accent text-white hover:bg-accent/90',
          )}
        >
          {loading ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <PieChart size={12} />}
          Run Clustering
        </button>
      </div>

      {/* Results */}
      {loading && !data && (
        <div className="flex items-center justify-center py-12"><LoadingSpinner size="md" /></div>
      )}
      {error && <p className="py-4 text-center text-[12px] text-fg-muted">{error}</p>}
      {data && !loading && (
        <div className="space-y-3">
          <p className="text-[11px] text-fg-faint">{nClusters} clusters computed. Each cluster represents a group of cases with similar process behaviour.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.clusters.map((c) => {
              const colors = clusterColors[c.cluster_id % clusterColors.length];
              return (
                <div key={c.cluster_id} className={`rounded-lg border p-3 ${colors.border} ${colors.bg}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-fg">Cluster {c.cluster_id + 1}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors.badge}`}>
                      {c.case_count.toLocaleString()} cases
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-fg-faint">Avg duration</span>
                      <span className="tabular-nums font-medium text-fg">{fmtDuration(c.avg_duration)}</span>
                    </div>
                    {c.top_variant.length > 0 && (
                      <div>
                        <p className="mb-1 text-[10px] text-fg-faint">Top variant</p>
                        <div className="flex flex-wrap gap-0.5">
                          {c.top_variant.map((act, ai) => (
                            <span key={ai} className="text-[10px] text-fg-secondary">
                              {act}{ai < c.top_variant.length - 1 ? ' →' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <PieChart size={28} className="mb-2 text-fg-ghost" />
          <p className="text-[12px] text-fg-muted">Choose a cluster count and click Run Clustering</p>
        </div>
      )}
    </div>
  );
}
