import { useEffect, useState, useRef } from 'react';
import { Gauge, Zap, TrendingDown, Target, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { competitive } from '@/api/client';
import type {
  AutomationCandidatesResponse,
  WhatIfBottleneckResponse,
} from '@/api/client';

function fmtDur(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** More precise formatter — shows hours+minutes for sub-day values
 *  so small changes don't get rounded away to the same string. */
function fmtDurPrecise(s: number | null | undefined): string {
  if (s == null || isNaN(s)) return '—';
  if (s < 1) return '< 1s';
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function fmtMoney(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

// ─── What-if bottleneck slider ───────────────────────────────────────

export function WhatIfSlider({
  eventLogId,
  activity: initialActivity,
  activities = [],
}: {
  eventLogId: string;
  activity: string;
  activities?: string[];
}) {
  const [selected, setSelected] = useState(initialActivity);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [speedup, setSpeedup] = useState(20);
  const [data, setData] = useState<WhatIfBottleneckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(initialActivity);
  }, [initialActivity]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    competitive
      .whatIfBottleneck(eventLogId, selected, speedup)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [eventLogId, selected, speedup]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node))
        setDropdownOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  if (!selected) return null;

  return (
    <div className="card mt-8 p-5">
      <div className="mb-2 flex items-center gap-2">
        <Gauge size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          What-if: speed up activity
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Pick an activity and drag the slider to estimate cycle-time savings
        if it ran faster by the given percentage.
      </p>

      {/* Activity selector */}
      <div className="relative mt-3" ref={dropRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-lg border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-fg hover:border-accent/50 transition-colors"
        >
          <span className="truncate font-medium">{selected}</span>
          <ChevronDown
            size={13}
            className={clsx('shrink-0 text-fg-faint transition-transform', dropdownOpen && 'rotate-180')}
          />
        </button>
        {dropdownOpen && activities.length > 0 && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-line bg-surface-2 py-1 shadow-xl animate-fade-in">
            {activities.map((act) => (
              <button
                key={act}
                type="button"
                onClick={() => { setSelected(act); setDropdownOpen(false); }}
                className={clsx(
                  'flex w-full items-center px-3 py-1.5 text-[12px] transition-colors hover:bg-tint',
                  act === selected ? 'text-accent font-medium' : 'text-fg-secondary',
                )}
              >
                <span className="truncate">{act}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <span className="shrink-0 text-[10px] text-fg-faint w-6">0%</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={speedup}
          onChange={(e) => setSpeedup(Number(e.target.value))}
          className="flex-1"
        />
        <span className="shrink-0 w-14 text-right text-[13px] font-bold tabular-nums text-accent">
          {speedup}%
        </span>
        {loading && (
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />
        )}
      </div>

      {/* Results — always rendered once data exists, dimmed while loading */}
      {data && (() => {
        const hasDwell = typeof data.activity_avg_dwell_seconds === 'number' && data.activity_avg_dwell_seconds > 0;
        const saving = data.saving_per_case_seconds ?? 0;
        const totalSaving = data.total_saving_seconds ?? 0;
        const pct = data.pct_improvement ?? 0;
        const casesAffected = data.cases_affected ?? 0;
        const casesTotal = data.cases_total ?? 0;
        const occurrences = data.activity_occurrences ?? 0;
        const dwellCurrent = data.activity_avg_dwell_seconds ?? 0;
        const dwellAfter = data.activity_new_dwell_seconds ?? 0;

        return (
          <div className={clsx('mt-4 space-y-3 transition-opacity', loading && 'opacity-40')}>
            {/* Activity dwell — the part that visibly changes */}
            {hasDwell && (
              <div className="rounded-lg border border-line bg-surface-1 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint mb-3">
                  Activity dwell time
                </p>
                <div className="space-y-2">
                  <DurationBar label="Current" seconds={dwellCurrent} max={dwellCurrent} color="bg-fg-faint/30" />
                  <DurationBar label={`After −${speedup}%`} seconds={dwellAfter} max={dwellCurrent} color="bg-success/50" />
                </div>
                {occurrences > 0 && (
                  <p className="mt-2.5 text-[11px] text-fg-muted">
                    {occurrences.toLocaleString()} occurrences · {casesAffected.toLocaleString()} of {casesTotal.toLocaleString()} cases
                  </p>
                )}
              </div>
            )}

            {/* Process impact — always shown */}
            <div className="rounded-lg border border-line bg-surface-1 p-4">
              <div className="flex items-baseline gap-3 mb-3">
                <span className={clsx(
                  'text-[28px] font-black tabular-nums leading-none',
                  pct >= 0.05 ? 'text-success' : 'text-fg-faint',
                )}>
                  {pct >= 0.1 ? `−${pct.toFixed(1)}%` : pct >= 0.001 ? `−${pct.toFixed(2)}%` : '~0%'}
                </span>
                <span className="text-[11px] text-fg-muted">avg case duration</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Saved / case" value={fmtDurPrecise(saving)} tone={saving > 0 ? 'accent' : 'neutral'} />
                <Stat label="Total saved" value={fmtDurPrecise(totalSaving)} tone={totalSaving > 0 ? 'accent' : 'neutral'} />
                <Stat label="New avg case" value={fmtDur(data.new_case_avg_seconds)} tone={pct >= 0.05 ? 'success' : 'neutral'} />
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'accent' | 'success';
}) {
  const cls =
    tone === 'success'
      ? 'text-success'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-fg';
  return (
    <div className="rounded-md border border-line bg-surface-1 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`text-[14px] font-bold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function DurationBar({
  label,
  seconds,
  max,
  color,
}: {
  label: string;
  seconds: number;
  max: number;
  color: string;
}) {
  const s = seconds || 0;
  const m = max || 1;
  const pct = m > 0 ? Math.max(1, (s / m) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-right text-[11px] text-fg-muted">{label}</span>
      <div className="flex-1 h-5 rounded bg-surface-2 overflow-hidden">
        <div
          className={clsx('h-full rounded transition-all duration-300', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-[11px] font-semibold tabular-nums text-fg-secondary">
        {fmtDur(seconds)}
      </span>
    </div>
  );
}

// ─── Automation candidates panel ─────────────────────────────────────

export function AutomationCandidates({ eventLogId }: { eventLogId: string }) {
  const [hourlyCost, setHourlyCost] = useState(50);
  const [automationRate, setAutomationRate] = useState(0.7);
  const [data, setData] = useState<AutomationCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    competitive
      .automationCandidates(eventLogId, hourlyCost, automationRate)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [eventLogId, hourlyCost, automationRate]);

  return (
    <div className="card mt-8 p-5">
      <div className="mb-2 flex items-center gap-2">
        <Zap size={14} className="text-warning" />
        <h3 className="text-[13px] font-semibold text-fg">
          Automation candidates (ranked by ROI)
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Activities scored by frequency × dwell time × automation rate. Edit
        the assumptions below to re-score — the ROI updates live.
      </p>
      <div className="mt-3 flex items-center gap-4">
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          Hourly cost
          <input
            type="number"
            min={0}
            step={5}
            value={hourlyCost}
            onChange={(e) => setHourlyCost(Number(e.target.value))}
            className="input w-20 py-1 text-[11px]"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          Automation rate
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={automationRate}
            onChange={(e) => setAutomationRate(Number(e.target.value))}
            className="w-24"
          />
          <span className="w-10 text-right tabular-nums">
            {(automationRate * 100).toFixed(0)}%
          </span>
        </label>
        {loading && (
          <div className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />
        )}
      </div>
      {data && data.candidates.length > 0 ? (
        <div className={clsx('mt-4 overflow-auto rounded-lg border border-line transition-opacity', loading && 'opacity-40')}>
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-1">
                <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Frequency</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Avg dwell</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Hours saved</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Cost saved</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c, i) => (
                <tr key={c.activity} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                  <td className="flex items-center gap-2 px-3 py-1.5 text-fg">
                    <Target size={11} className="text-fg-muted" />
                    {c.activity}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-fg-secondary">
                    {c.frequency.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-fg-secondary">
                    {fmtDur(c.avg_duration_seconds)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-success">
                    {c.estimated_hours_saved.toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-accent">
                    <TrendingDown size={9} className="inline" /> {fmtMoney(c.estimated_cost_saved)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading ? (
        <p className="mt-4 text-[11px] text-fg-muted">No candidates found.</p>
      ) : (
        /* Skeleton table while first load hasn't returned yet */
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-1">
                <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Frequency</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Avg dwell</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Hours saved</th>
                <th className="px-3 py-2 text-right font-semibold text-fg-faint">Cost saved</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-3 py-2.5">
                      <div className="h-3 animate-pulse rounded bg-surface-3" style={{ width: j === 0 ? '70%' : '40%' }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
