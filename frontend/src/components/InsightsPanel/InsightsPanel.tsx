import { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronDown,
  Lightbulb,
  TrendingDown,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';
import { mining as miningApi } from '@/api/client';
import type { Insight, InsightsResponse } from '@/types';
import { useAnalysisData } from '@/hooks/useAnalysisData';
import { useUIStore } from '@/store';

interface InsightsPanelProps {
  eventLogId: string;
}

const SHOW_INITIAL = 3;

function SeverityIcon({ severity }: { severity: Insight['severity'] }) {
  if (severity === 'critical') return <AlertCircle size={14} className="shrink-0 text-danger" />;
  if (severity === 'warning') return <AlertTriangle size={14} className="shrink-0 text-warning" />;
  return <Info size={14} className="shrink-0 text-accent" />;
}

function InsightCard({ insight }: { insight: Insight }) {
  const askAI = useUIStore((s) => s.askAI);
  return (
    <div className="group flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
      <div className="mt-0.5">
        <SeverityIcon severity={insight.severity} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-semibold leading-tight text-fg">{insight.title}</p>
          {/* One-click handoff to the Ask-AI panel with a prefilled
              explain prompt. Fades in on card hover to stay out of
              the way when the user is just scanning. */}
          <button
            type="button"
            onClick={() =>
              askAI(
                `Explain this finding in plain English and tell me how to fix it: "${insight.title}". Context: ${insight.description}`,
              )
            }
            className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-1 px-1.5 py-0.5 text-[10px] text-fg-muted opacity-0 transition-all hover:border-accent/60 hover:bg-accent/5 hover:text-accent group-hover:opacity-100 focus:opacity-100"
            title="Explain this finding with AI"
            aria-label="Explain with AI"
          >
            <Sparkles size={10} />
            Explain
          </button>
        </div>
        <p className="mt-0.5 text-[12px] text-fg-muted">{insight.description}</p>
        {insight.recommendation && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-tint px-2 py-1.5">
            <Lightbulb size={11} className="mt-0.5 shrink-0 text-fg-faint" />
            <p className="text-[11px] text-fg-secondary">{insight.recommendation}</p>
          </div>
        )}
        {insight.impact_estimate && (
          <div className="mt-1 flex items-start gap-1.5 rounded-md bg-accent/5 px-2 py-1.5">
            <TrendingDown size={11} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-[11px] font-medium text-accent">{insight.impact_estimate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InsightsPanel({ eventLogId }: InsightsPanelProps) {
  const { data, loading } = useAnalysisData<InsightsResponse>(
    eventLogId, 'insights', miningApi.getInsights,
  );
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const criticalCount = data?.insights.filter((i) => i.severity === 'critical').length ?? 0;
  const visibleInsights = data
    ? showAll
      ? data.insights
      : data.insights.slice(0, SHOW_INITIAL)
    : [];
  const hiddenCount = data ? data.insights.length - SHOW_INITIAL : 0;

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle size={13} className="text-fg-faint" />
          <span className="text-[12px] font-semibold text-fg">Process Insights</span>
          {loading && (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" />
          )}
          {!loading && data && criticalCount > 0 && (
            <span className="rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
              {criticalCount} critical
            </span>
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded p-0.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
        >
          <ChevronDown
            size={14}
            className={clsx('transition-transform', !expanded && '-rotate-90')}
          />
        </button>
      </div>

      {/* Summary line */}
      {expanded && !loading && data && (
        <p className="mt-1.5 text-[11px] text-fg-muted">{data.summary}</p>
      )}

      {/* Body */}
      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto">
          {loading ? (
            <p className="text-[11px] text-fg-faint">Analyzing your process...</p>
          ) : !data || data.insights.length === 0 ? (
            <p className="text-[11px] text-fg-muted">No issues detected.</p>
          ) : (
            <>
              <div className="divide-y divide-line">
                {visibleInsights.map((insight, i) => (
                  <InsightCard key={i} insight={insight} />
                ))}
              </div>
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-2 text-[11px] font-medium text-accent hover:text-accent/80 transition-colors"
                >
                  {showAll ? 'Show fewer' : `Show all ${data.insights.length} insights`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
