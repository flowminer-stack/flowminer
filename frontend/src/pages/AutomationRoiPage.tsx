import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Sparkles, Coins, Bot } from 'lucide-react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import { competitive } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import type { AutomationCandidate } from '@/types';
import { formatDuration, formatNumber } from '@/utils/format';

/* ── Automation ROI Bubble Chart ──────────────────────────────────────────
 *
 * Each activity is a bubble: X = avg handling time, Y = how often it runs,
 * bubble area = annual money recoverable by automating it, colour = ROI tier.
 * The backend returns the raw time totals; the two assumption sliders
 * (loaded hourly cost, automatable fraction) recompute the dollar figures
 * CLIENT-SIDE so the picture re-prices instantly without re-hitting the API.
 *
 * The point of the view: put a credible dollar number on screen in seconds —
 * "automating these 4 steps recovers $612k/yr" — and let a prospect drag the
 * assumptions to their own reality. It monetises the existing
 * /automation-candidates endpoint, which today only renders as a table.
 */

const CURRENCY = '$';

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${CURRENCY}${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${CURRENCY}${(n / 1_000).toFixed(0)}k`;
  return `${CURRENCY}${Math.round(n)}`;
}

// ROI tiers by share of the total recoverable pool — drives bubble colour.
const TIERS = [
  { key: 'prime', label: 'Prime target', color: '#e11d48' }, // rose
  { key: 'strong', label: 'Strong', color: '#f59e0b' }, // amber
  { key: 'moderate', label: 'Moderate', color: '#06b6d4' }, // cyan
  { key: 'low', label: 'Low', color: '#64748b' }, // slate
] as const;

interface BubbleDatum {
  activity: string;
  x: number; // avg duration seconds
  y: number; // frequency
  z: number; // $ recoverable (re-priced client-side)
  hours: number;
  tierIdx: number;
}

export default function AutomationRoiPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  const [candidates, setCandidates] = useState<AutomationCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Assumption sliders — applied client-side, no refetch.
  const [hourlyCost, setHourlyCost] = useState(50);
  const [automationRate, setAutomationRate] = useState(0.7);

  useEffect(() => {
    if (!eventLogId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Fetch once with neutral assumptions; we re-price locally from
    // total_time_seconds, which doesn't depend on the slider values.
    competitive
      .automationCandidates(eventLogId, 1, 1)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail ?? e?.message ?? 'Failed to load automation candidates');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  const { bubbles, totalRecoverable, totalHours } = useMemo(() => {
    if (!candidates || candidates.length === 0) {
      return { bubbles: [] as BubbleDatum[], totalRecoverable: 0, totalHours: 0 };
    }
    // Re-price every candidate from raw time totals + current assumptions.
    const priced = candidates.map((c) => {
      const hours = (c.total_time_seconds / 3600) * automationRate;
      return { c, hours, cost: hours * hourlyCost };
    });
    const totalRecoverable = priced.reduce((s, p) => s + p.cost, 0);
    const totalHours = priced.reduce((s, p) => s + p.hours, 0);
    const maxCost = Math.max(...priced.map((p) => p.cost), 1);

    const bubbles: BubbleDatum[] = priced.map((p) => {
      const share = p.cost / maxCost;
      const tierIdx = share > 0.66 ? 0 : share > 0.33 ? 1 : share > 0.12 ? 2 : 3;
      return {
        activity: p.c.activity,
        x: Math.max(p.c.avg_duration_seconds, 1),
        y: p.c.frequency,
        z: Math.round(p.cost),
        hours: p.hours,
        tierIdx,
      };
    });
    return { bubbles, totalRecoverable, totalHours };
  }, [candidates, hourlyCost, automationRate]);

  const ranked = useMemo(
    () => [...bubbles].sort((a, b) => b.z - a.z),
    [bubbles],
  );

  if (loading) {
    return <LoadingSpinner size="lg" text="Scoring automation candidates…" fullPage />;
  }
  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  return (
    <div>
      <PageHeader
        title="Automation ROI"
        icon={Bot}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="Where automation pays off. Each bubble is an activity — bigger and redder means more money recoverable by automating it. Drag the assumptions to your own numbers."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      {bubbles.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No automation candidates"
          description="This log has no activities with measurable handling time to automate."
        />
      ) : (
        <>
          {/* Headline + assumption sliders */}
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="card relative overflow-hidden p-5 lg:col-span-1">
              <div className="flex items-center gap-2 text-fg-muted">
                <Coins size={15} className="text-success" />
                <span className="text-[11px] font-semibold uppercase tracking-wider">Recoverable / year</span>
              </div>
              <p className="mt-2 text-4xl font-bold tabular-nums text-fg">{money(totalRecoverable)}</p>
              <p className="mt-1 text-[12px] text-fg-muted">
                ≈ {formatNumber(Math.round(totalHours))} hours of manual work across {bubbles.length} activities
              </p>
              <Sparkles size={64} className="pointer-events-none absolute -bottom-3 -right-3 text-success/10" />
            </div>

            <div className="card p-5 lg:col-span-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Your assumptions</p>
              <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <label className="block">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-fg-muted">Loaded hourly cost</span>
                    <span className="font-semibold tabular-nums text-fg">{CURRENCY}{hourlyCost}/h</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={250}
                    step={5}
                    value={hourlyCost}
                    onChange={(e) => setHourlyCost(Number(e.target.value))}
                    className="mt-2 w-full accent-accent"
                  />
                </label>
                <label className="block">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-fg-muted">Automatable fraction</span>
                    <span className="font-semibold tabular-nums text-fg">{Math.round(automationRate * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={Math.round(automationRate * 100)}
                    onChange={(e) => setAutomationRate(Number(e.target.value) / 100)}
                    className="mt-2 w-full accent-accent"
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                {TIERS.map((t) => (
                  <div key={t.key} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                    {t.label}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bubble chart + ranked list */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="card p-4 lg:col-span-2">
              <div className="h-[460px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 16, right: 24, bottom: 36, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line) / 0.5)" />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="Avg handling time"
                      scale="log"
                      domain={['auto', 'auto']}
                      tickFormatter={(v) => formatDuration(v)}
                      tick={{ fontSize: 10, fill: 'rgb(var(--c-fgm))' }}
                      stroke="rgb(var(--c-line))"
                    >
                    </XAxis>
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="Frequency"
                      tickFormatter={(v) => formatNumber(v)}
                      tick={{ fontSize: 10, fill: 'rgb(var(--c-fgm))' }}
                      stroke="rgb(var(--c-line))"
                    />
                    <ZAxis type="number" dataKey="z" range={[80, 2600]} name="Recoverable" />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as BubbleDatum;
                        return (
                          <div className="rounded-md border border-line bg-surface-0 px-3 py-2 text-[11px] shadow-lg">
                            <div className="font-semibold text-fg">{d.activity}</div>
                            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fg-muted">
                              <span>Recoverable</span>
                              <span className="tabular-nums text-success">{money(d.z)}/yr</span>
                              <span>Hours saved</span>
                              <span className="tabular-nums text-fg-secondary">{formatNumber(Math.round(d.hours))}</span>
                              <span>Avg time</span>
                              <span className="tabular-nums text-fg-secondary">{formatDuration(d.x)}</span>
                              <span>Runs</span>
                              <span className="tabular-nums text-fg-secondary">{formatNumber(d.y)}</span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Scatter data={bubbles} fillOpacity={0.72}>
                      {bubbles.map((b, i) => (
                        <Cell key={i} fill={TIERS[b.tierIdx].color} stroke={TIERS[b.tierIdx].color} />
                      ))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 pl-2 text-center text-[10px] text-fg-faint">
                X: average handling time (log scale) · Y: how often the activity runs · bubble size: $ recoverable
              </p>
            </div>

            {/* Ranked target list */}
            <div className="card p-4 lg:col-span-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">Top targets</p>
              <div className="mt-3 space-y-2">
                {ranked.slice(0, 8).map((b, i) => (
                  <div key={b.activity} className="flex items-center gap-3">
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: TIERS[b.tierIdx].color }}
                    >
                      {i + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-fg">{b.activity}</p>
                      <p className="text-[10px] text-fg-muted">
                        {formatNumber(b.y)} runs · {formatDuration(b.x)} each
                      </p>
                    </div>
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums text-success">
                      {money(b.z)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
