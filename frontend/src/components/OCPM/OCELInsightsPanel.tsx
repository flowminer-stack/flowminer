import { useEffect, useState } from 'react';
import { ocel } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';

// ─── OCEL-Native: Insights ────────────────────────────────────────────────────

type OCELInsightsData = { insights: Array<{ severity: string; title: string; description: string; recommendation: string | null }>; summary: string };

export default function OCELInsightsPanel({ ocelId }: { ocelId: string }) {
  const cached = getCached<OCELInsightsData>(ocelId, 'ocel_insights');
  const [data, setData] = useState<OCELInsightsData | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const existing = getCached<OCELInsightsData>(ocelId, 'ocel_insights');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    ocel.getInsights(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_insights', d); setData(d); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex items-center gap-2 text-[11px] text-fg-muted py-2"><LoadingSpinner size="sm" /> Generating insights...</div>;
  if (!data || data.insights.length === 0) return null;

  const sevIcon = (s: string) => s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵';
  const shown = expanded ? data.insights : data.insights.slice(0, 3);

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-fg-muted">{data.summary}</p>
        {data.insights.length > 3 && (
          <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-accent hover:underline shrink-0 ml-2">
            {expanded ? 'Show less' : `Show all ${data.insights.length}`}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {shown.map((insight, i) => (
          <div key={i} className="flex gap-2.5">
            <span className="shrink-0 text-[12px] mt-0.5">{sevIcon(insight.severity)}</span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-fg">{insight.title}</p>
              <p className="text-[11px] text-fg-muted mt-0.5">{insight.description}</p>
              {insight.recommendation && (
                <p className="mt-1 rounded bg-tint/60 px-2 py-1 text-[10px] text-fg-secondary">
                  💡 {insight.recommendation}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
