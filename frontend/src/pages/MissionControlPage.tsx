import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Target,
  AlertCircle,
  TrendingDown,
  Sparkles,
  Clock,
  Gauge,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  mining as miningApi,
  competitive,
  ai as aiApi,
} from '@/api/client';
import type { InsightsResponse, CaseListResponse } from '@/types';

// Appian Process HQ-style "mission control" — a top-level command
// view that ranks the open process problems by severity and puts the
// user one click away from acting on them. No new backend: it composes
// existing insights + automation-candidates into a single priority feed.

function fmtMoney(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

interface PriorityItem {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  impact: string | null;
  category: string;
}

interface SlaSummary {
  slaSeconds: number;
  withinSla: number;
  breached: number;
  total: number;
  slowestCases: Array<{ id: string; durationHours: number }>;
}

export default function MissionControlPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const [items, setItems] = useState<PriorityItem[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [topCost, setTopCost] = useState<number>(0);
  const [sla, setSla] = useState<SlaSummary | null>(null);
  const [slaDays, setSlaDays] = useState(7);

  useEffect(() => {
    if (!eventLogId) return;
    setLoading(true);
    Promise.all([
      miningApi.getInsights(eventLogId).catch(() => null),
      competitive.automationCandidates(eventLogId).catch(() => null),
      aiApi.narrate(eventLogId).catch(() => null),
      miningApi.getCases(eventLogId).catch(() => null),
    ])
      .then(([ins, autoc, narr, cases]) => {
        const combined: PriorityItem[] = [];
        if (ins) {
          for (const i of (ins as InsightsResponse).insights) {
            combined.push({
              severity: i.severity as PriorityItem['severity'],
              title: i.title,
              description: i.description,
              impact: i.impact_estimate ?? null,
              category: i.category,
            });
          }
        }
        if (autoc && autoc.candidates.length > 0) {
          const top = autoc.candidates[0];
          setTopCost(top.estimated_cost_saved);
          combined.push({
            severity: top.estimated_hours_saved > 40 ? 'critical' : 'warning',
            title: `Automation opportunity: ${top.activity}`,
            description: `${top.frequency.toLocaleString()} occurrences · ${top.estimated_hours_saved.toFixed(1)} hours/period could be saved by automating this activity.`,
            impact: `Est. ${fmtMoney(top.estimated_cost_saved)} saved`,
            category: 'automation',
          });
        }
        const order = { critical: 0, warning: 1, info: 2 } as const;
        combined.sort((a, b) => order[a.severity] - order[b.severity]);
        setItems(combined);
        if (narr && 'markdown' in narr) setSummary((narr as any).markdown);

        // SLA burn-down: use the current slaDays threshold to split
        // cases into within/breached buckets from the list endpoint
        // (which returns duration per case).
        if (cases) {
          const list = (cases as CaseListResponse).cases ?? [];
          const threshold = slaDays * 86400;
          const withinSla = list.filter(
            (c) => (c.duration_seconds ?? 0) <= threshold,
          ).length;
          const breached = list.length - withinSla;
          const slowest = [...list]
            .sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0))
            .slice(0, 5)
            .map((c) => ({
              id: c.case_id,
              durationHours: (c.duration_seconds ?? 0) / 3600,
            }));
          setSla({
            slaSeconds: threshold,
            withinSla,
            breached,
            total: list.length,
            slowestCases: slowest,
          });
        }
      })
      .finally(() => setLoading(false));
  }, [eventLogId, slaDays]);

  if (loading) return <LoadingSpinner fullPage text="Assembling mission control…" />;

  const critical = items.filter((i) => i.severity === 'critical').length;
  const warnings = items.filter((i) => i.severity === 'warning').length;

  return (
    <div>
      <PageHeader
        title="Mission Control"
        icon={Target}
        description="Priority feed of the biggest process problems you can act on right now"
        backTo={-1}
      />

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <KPI label="Critical" value={critical.toString()} tone="danger" />
        <KPI label="Warnings" value={warnings.toString()} tone="warning" />
        <KPI label="Total items" value={items.length.toString()} />
        {topCost > 0 && (
          <KPI label="Top automation ROI" value={fmtMoney(topCost)} tone="accent" />
        )}
      </div>

      {summary && (
        <div className="mt-6 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles size={14} className="text-accent" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
              Executive briefing
            </span>
          </div>
          <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-secondary">
            {summary}
          </div>
        </div>
      )}

      {/* SLA burn-down (ABBYY Timeline parity) */}
      {sla && (
        <div className="mt-6 rounded-lg border border-line bg-surface-1 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gauge size={14} className="text-accent" />
              <h3 className="text-[14px] font-semibold text-fg">SLA burn-down</h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-fg-muted">Threshold</span>
              <div className="segment-group">
                {[7, 14, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => setSlaDays(d)}
                    className={`segment-btn ${slaDays === d ? 'segment-btn-active' : ''}`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex h-3 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="bg-success"
                  style={{ width: `${(sla.withinSla / Math.max(sla.total, 1)) * 100}%` }}
                  title={`${sla.withinSla} within SLA`}
                />
                <div
                  className="bg-danger"
                  style={{ width: `${(sla.breached / Math.max(sla.total, 1)) * 100}%` }}
                  title={`${sla.breached} breached`}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-fg-faint">
                <span className="text-success">{sla.withinSla} within SLA</span>
                <span className="text-danger">{sla.breached} breached</span>
              </div>
            </div>
          </div>
          {sla.slowestCases.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
                <Clock size={11} className="text-warning" />
                Top 5 slowest cases (at-risk)
              </div>
              <div className="space-y-1">
                {sla.slowestCases.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded border border-line bg-surface-0 px-3 py-1.5 text-[11px]"
                  >
                    <span className="truncate font-mono text-fg-secondary">{c.id}</span>
                    <span className="tabular-nums text-danger">
                      {c.durationHours.toFixed(1)}h
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 space-y-2">
        {items.map((it, i) => (
          <div
            key={i}
            className={`flex items-start gap-3 rounded-lg border p-3 ${
              it.severity === 'critical'
                ? 'border-danger/30 bg-danger/5'
                : it.severity === 'warning'
                  ? 'border-warning/30 bg-warning/5'
                  : 'border-line bg-surface-1'
            }`}
          >
            <AlertCircle
              size={14}
              className={
                it.severity === 'critical'
                  ? 'text-danger'
                  : it.severity === 'warning'
                    ? 'text-warning'
                    : 'text-accent'
              }
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-fg">{it.title}</p>
              <p className="mt-0.5 text-[11px] text-fg-muted">{it.description}</p>
              {it.impact && (
                <div className="mt-1 inline-flex items-center gap-1 rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                  <TrendingDown size={9} /> {it.impact}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function KPI({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'danger' | 'warning' | 'accent' }) {
  const cls =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'accent'
          ? 'text-accent'
          : 'text-fg';
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`text-[22px] font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
