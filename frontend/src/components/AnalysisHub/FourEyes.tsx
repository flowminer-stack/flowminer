import { useEffect, useState } from 'react';
import { mining as miningApi, eventLogs as eventLogsApi } from '@/api/client';
import type { FourEyesResponse, EventLog } from '@/types';
import { Eye } from 'lucide-react';
import clsx from 'clsx';
import { getCached, setCached } from '@/store/analysisCache';

interface Props { eventLogId: string; }

export default function FourEyes({ eventLogId }: Props) {
  const cachedLog = getCached<EventLog>(eventLogId, 'eventLog');
  const [eventLog, setEventLog] = useState<EventLog | null>(cachedLog);
  const [act1, setAct1] = useState(() => {
    const acts = cachedLog?.activities_list ?? [];
    return acts.length >= 1 ? acts[0] : '';
  });
  const [act2, setAct2] = useState(() => {
    const acts = cachedLog?.activities_list ?? [];
    return acts.length >= 2 ? acts[1] : '';
  });
  const [result, setResult] = useState<FourEyesResponse | null>(null);
  const [loading, setLoading] = useState(!cachedLog);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<EventLog>(eventLogId, 'eventLog');
    if (existing) {
      setEventLog(existing);
      const acts = existing.activities_list ?? [];
      if (acts.length >= 1) setAct1(acts[0]);
      if (acts.length >= 2) setAct2(acts[1]);
      setLoading(false);
      return;
    }
    setLoading(true);
    eventLogsApi.get(eventLogId)
      .then((el) => {
        setCached(eventLogId, 'eventLog', el);
        setEventLog(el);
        const acts = el.activities_list ?? [];
        if (acts.length >= 1) setAct1(acts[0]);
        if (acts.length >= 2) setAct2(acts[1]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [eventLogId]);

  const check = () => {
    if (!act1 || !act2) return;
    setChecking(true);
    setError(null);
    setResult(null);
    miningApi.checkFourEyes(eventLogId, act1, act2)
      .then(setResult)
      .catch(() => setError('Failed to check four-eyes constraint'))
      .finally(() => setChecking(false));
  };

  const activities = eventLog?.activities_list ?? [];

  return (
    <div className="space-y-4">
      <p className="mb-3 text-[11px] text-fg-muted">Checks whether two activities are always performed by different people (segregation of duties). Violations may indicate compliance risks.</p>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="block text-[10px] font-medium uppercase tracking-wider text-fg-faint">Activity A</label>
          {loading ? (
            <div className="h-7 w-40 animate-pulse rounded border border-line bg-surface-1" />
          ) : (
            <select
              value={act1}
              onChange={(e) => setAct1(e.target.value)}
              className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
            >
              {activities.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
        </div>
        <div className="space-y-1">
          <label className="block text-[10px] font-medium uppercase tracking-wider text-fg-faint">Activity B</label>
          {loading ? (
            <div className="h-7 w-40 animate-pulse rounded border border-line bg-surface-1" />
          ) : (
            <select
              value={act2}
              onChange={(e) => setAct2(e.target.value)}
              className="rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
            >
              {activities.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
        </div>
        <button
          onClick={check}
          disabled={checking || loading || !act1 || !act2}
          className={clsx(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            checking || loading ? 'cursor-not-allowed opacity-50 bg-tint text-fg-muted' : 'bg-accent text-white hover:bg-accent/90',
          )}
        >
          {checking ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Eye size={12} />}
          Check
        </button>
      </div>

      {error && <p className="text-[11px] text-danger">{error}</p>}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Total Cases', value: result.total_cases.toLocaleString() },
              { label: 'Violating Cases', value: result.violating_cases.toLocaleString() },
              {
                label: 'Violation Rate',
                value: result.total_cases > 0
                  ? `${((result.violating_cases / result.total_cases) * 100).toFixed(1)}%`
                  : '0%',
              },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-line bg-surface-1 p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{s.label}</p>
                <p className={clsx(
                  'mt-1 text-[18px] font-bold tabular-nums',
                  s.label === 'Violation Rate' && result.violating_cases > 0 ? 'text-danger' : 'text-fg',
                )}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Violations table */}
          {result.violations.length > 0 ? (
            <div>
              <p className="mb-2 text-[11px] text-fg-faint">Cases where the same resource performed both activities:</p>
              <div className="overflow-auto rounded-lg border border-line">
                <table className="min-w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-1">
                      <th className="px-3 py-2 text-left font-semibold text-fg-faint">Case ID</th>
                      <th className="px-3 py-2 text-left font-semibold text-fg-faint">Resource</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.violations.map((v, i) => (
                      <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                        <td className="px-3 py-1.5 font-mono text-fg-secondary">{v.case_id}</td>
                        <td className="px-3 py-1.5 text-fg-secondary">{v.resource}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/5 px-3 py-2.5">
              <span className="text-[18px]">✓</span>
              <p className="text-[11px] text-success">No violations found. The four-eyes constraint is satisfied.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
