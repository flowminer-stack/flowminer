import { useEffect, useMemo, useState } from 'react';
import { DollarSign, Clock, TrendingDown, Save } from 'lucide-react';
import { mining as miningApi } from '@/api/client';

// IBM Process Mining-style editable cost table. Each row is an activity
// with user-editable hourly-cost / headcount / automation-% fields.
// Computing the column totals on-the-fly gives an ROI-style as-is vs
// to-be comparison without a full what-if simulation run.
//
// The numbers are derived from the bottleneck analysis the user
// already ran (avg_duration × frequency). We don't re-query per edit
// — the edit is local state and the projected savings are a simple
// multiplication the browser does instantly.

interface Row {
  activity: string;
  frequency: number;
  avgDuration: number;
  hourlyCost: number;
  automationPct: number;
}

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function fmtMoney(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export default function ActivityCostTable({ eventLogId }: { eventLogId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultHourly, setDefaultHourly] = useState(50);

  useEffect(() => {
    setLoading(true);
    miningApi
      .getBottlenecks(eventLogId)
      .then((r) => {
        const initial: Row[] = r.bottlenecks
          .sort((a, b) => b.frequency * b.avg_duration - a.frequency * a.avg_duration)
          .slice(0, 15)
          .map((b) => ({
            activity: b.activity,
            frequency: b.frequency,
            avgDuration: b.avg_duration,
            hourlyCost: 50,
            automationPct: 0,
          }));
        setRows(initial);
      })
      .finally(() => setLoading(false));
  }, [eventLogId]);

  const totals = useMemo(() => {
    let asIsCost = 0;
    let toBeCost = 0;
    let savedSec = 0;
    for (const r of rows) {
      const totalSec = r.frequency * r.avgDuration;
      const asIs = (totalSec / 3600) * r.hourlyCost;
      const savedFrac = r.automationPct / 100;
      const toBe = asIs * (1 - savedFrac);
      asIsCost += asIs;
      toBeCost += toBe;
      savedSec += totalSec * savedFrac;
    }
    return { asIsCost, toBeCost, savedSec, savings: asIsCost - toBeCost };
  }, [rows]);

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const applyDefault = () => setRows((rs) => rs.map((r) => ({ ...r, hourlyCost: defaultHourly })));

  return (
    <div className="card mt-6 p-5">
      <div className="mb-2 flex items-center gap-2">
        <DollarSign size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          Activity cost calculator
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Edit cost per hour and automation % per activity. Totals update live —
        export the scenario to save it for a stakeholder review.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-fg-muted">
          Default hourly rate
          <input
            type="number"
            value={defaultHourly}
            onChange={(e) => setDefaultHourly(Number(e.target.value))}
            className="input w-20 py-1 text-[11px]"
          />
        </label>
        <button type="button" onClick={applyDefault} className="btn-secondary text-[10px]">
          <Save size={10} />
          Apply to all
        </button>
      </div>
      {loading ? (
        <p className="mt-4 text-[11px] text-fg-muted">Loading activity list…</p>
      ) : (
        <>
          <div className="mt-4 overflow-auto rounded-lg border border-line">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="border-b border-line bg-surface-1">
                  <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Frequency</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Avg dwell</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">$/hr</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Automation %</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">As-is cost</th>
                  <th className="px-3 py-2 text-right font-semibold text-fg-faint">Saved</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const totalSec = r.frequency * r.avgDuration;
                  const asIs = (totalSec / 3600) * r.hourlyCost;
                  const saved = asIs * (r.automationPct / 100);
                  return (
                    <tr key={r.activity} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                      <td className="px-3 py-1.5 text-fg">{r.activity}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-fg-secondary">
                        {r.frequency.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-fg-secondary">
                        <Clock size={9} className="mr-1 inline" />
                        {fmtDur(r.avgDuration)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          type="number"
                          value={r.hourlyCost}
                          onChange={(e) => updateRow(i, { hourlyCost: Number(e.target.value) })}
                          className="w-16 rounded border border-line bg-surface-0 px-1 py-0.5 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={r.automationPct}
                          onChange={(e) => updateRow(i, { automationPct: Number(e.target.value) })}
                          className="w-14 rounded border border-line bg-surface-0 px-1 py-0.5 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-fg">
                        {fmtMoney(asIs)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-success">
                        {saved > 0 ? `-${fmtMoney(saved)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-1 font-semibold">
                  <td colSpan={5} className="px-3 py-2 text-right text-fg-faint">
                    Total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-fg">
                    {fmtMoney(totals.asIsCost)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-success">
                    <TrendingDown size={10} className="mr-1 inline" />
                    {fmtMoney(totals.savings)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-fg-muted">
            Projected savings: <span className="font-semibold text-success">{fmtMoney(totals.savings)}</span>{' '}
            ({(totals.savedSec / 3600).toFixed(0)} hours reclaimed)
          </p>
        </>
      )}
    </div>
  );
}
