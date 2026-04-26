import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { competitive } from '@/api/client';
import type { VariantEvolutionResponse } from '@/api/client';

// Minit-style variant evolution chart: bucket cases by their start
// time (day / week / month / quarter) and show the top variant mix
// shifting over time. Reveals concept drift visually.

export default function VariantEvolution({ eventLogId }: { eventLogId: string }) {
  const [granularity, setGranularity] = useState<
    'day' | 'week' | 'month' | 'quarter'
  >('month');
  const [data, setData] = useState<VariantEvolutionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    competitive
      .variantEvolution(eventLogId, granularity)
      .then(setData)
      .finally(() => setLoading(false));
  }, [eventLogId, granularity]);

  const maxTotal = Math.max(...(data?.buckets.map((b) => b.total_cases) ?? [1]), 1);
  const uniqueVariants = Array.from(
    new Set(
      data?.buckets.flatMap((b) => b.top_variants.map((v) => v.signature)) ?? [],
    ),
  ).slice(0, 8);
  // Stable colours per unique variant signature.
  const palette = [
    '#06b6d4', '#f59e0b', '#8b5cf6', '#10b981',
    '#ef4444', '#3b82f6', '#ec4899', '#84cc16',
  ];
  const colour = (sig: string) => {
    const idx = uniqueVariants.indexOf(sig);
    return palette[idx >= 0 ? idx % palette.length : 0];
  };

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-fg">
            Variant evolution over time
          </h3>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-line bg-surface-1 p-0.5 text-[10px]">
          {(['day', 'week', 'month', 'quarter'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`rounded px-2 py-1 font-medium transition-colors ${
                granularity === g ? 'bg-accent text-white' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-fg-muted">
        Stacked top-5 variants per period. Growing/shrinking bands reveal
        concept drift — worth an <em>as-is vs to-be</em> re-analysis.
      </p>
      {loading ? (
        <p className="mt-4 text-[11px] text-fg-muted">Loading…</p>
      ) : data && data.buckets.length > 0 ? (
        <div className="mt-4 overflow-auto">
          <div className="flex items-end gap-2 pb-2" style={{ minHeight: 160 }}>
            {data.buckets.map((b) => {
              const total = b.top_variants.reduce((s, v) => s + v.case_count, 0);
              const height = Math.max(8, (b.total_cases / maxTotal) * 140);
              return (
                <div
                  key={b.period}
                  className="flex min-w-[48px] flex-col items-center gap-1"
                >
                  <div
                    className="flex w-full flex-col overflow-hidden rounded-t-sm border border-line"
                    style={{ height }}
                    title={`${b.period}: ${b.total_cases} cases`}
                  >
                    {b.top_variants.map((v) => (
                      <div
                        key={v.signature}
                        style={{
                          height: `${(v.case_count / Math.max(total, 1)) * 100}%`,
                          backgroundColor: colour(v.signature),
                        }}
                        title={`${v.signature}\n${v.case_count} cases`}
                      />
                    ))}
                  </div>
                  <span className="rotate-[-30deg] origin-left text-[9px] text-fg-faint">
                    {b.period}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px]">
            {uniqueVariants.map((v) => (
              <span key={v} className="flex items-center gap-1 text-fg-muted">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ backgroundColor: colour(v) }}
                />
                {v.slice(0, 40)}
                {v.length > 40 ? '…' : ''}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-fg-muted">Not enough data.</p>
      )}
    </div>
  );
}
