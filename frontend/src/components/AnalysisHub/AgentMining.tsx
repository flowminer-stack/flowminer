import { analytics as analyticsApi } from '@/api/client';
import { useAnalysisData } from '@/hooks/useAnalysisData';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { Bot, User } from 'lucide-react';

interface Props {
  eventLogId: string;
}

export default function AgentMining({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<any>(
    eventLogId,
    'agent_mining',
    analyticsApi.agentMining,
    'Failed to load agent mining',
  );

  if (loading)
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner size="md" />
      </div>
    );
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return <p className="py-10 text-center text-[12px] text-fg-muted">No data</p>;

  const { resources = [], handoffs = [], automation_ratio, bot_events, human_events, summary } = data;
  const pct = Math.round((automation_ratio || 0) * 100);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-fg-muted">{summary}</p>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-line bg-surface-1 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Automation ratio</p>
          <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{pct}%</p>
        </div>
        <div className="rounded-lg border border-line bg-surface-1 p-3">
          <div className="flex items-center gap-1.5">
            <Bot size={12} className="text-accent" />
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Bot events</p>
          </div>
          <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{(bot_events || 0).toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface-1 p-3">
          <div className="flex items-center gap-1.5">
            <User size={12} className="text-warning" />
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Human events</p>
          </div>
          <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{(human_events || 0).toLocaleString()}</p>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[12px] font-semibold text-fg">Handoff transitions</h3>
        <div className="space-y-1">
          {handoffs.map((h: any) => (
            <div key={h.transition} className="flex items-center justify-between rounded bg-tint/40 px-3 py-1.5">
              <span className="text-[11px] text-fg">{h.transition}</span>
              <span className="text-[11px] tabular-nums text-fg-muted">{h.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[12px] font-semibold text-fg">Resources (top 20)</h3>
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[11px]">
            <thead className="bg-tint/40 text-fg-faint">
              <tr>
                <th className="px-3 py-1.5 text-left">Resource</th>
                <th className="px-3 py-1.5 text-left">Kind</th>
                <th className="px-3 py-1.5 text-right">Events</th>
                <th className="px-3 py-1.5 text-right">Median dur</th>
                <th className="px-3 py-1.5 text-right">Activities</th>
              </tr>
            </thead>
            <tbody>
              {resources.slice(0, 20).map((r: any) => (
                <tr key={r.resource} className="border-t border-line text-fg">
                  <td className="px-3 py-1.5 text-fg-secondary">{r.resource}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className={`badge ${
                        r.kind === 'bot' ? 'badge-emerald' : r.kind === 'likely_bot' ? 'badge-amber' : 'badge-slate'
                      }`}
                    >
                      {r.kind}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.events}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.median_duration_sec}s</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.unique_activities}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
