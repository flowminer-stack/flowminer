import { Activity, Hash, Layers, GitBranch } from 'lucide-react';
import type { OCELSummary } from '@/types';
import { formatNumber } from './shared';

// ─── Summary Cards ────────────────────────────────────────────────────────────

export default function SummaryCards({ summary }: { summary: OCELSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {[
        { icon: Activity, label: 'Events', value: formatNumber(summary.event_count) },
        { icon: Hash, label: 'Objects', value: formatNumber(summary.object_count) },
        { icon: Layers, label: 'Object Types', value: summary.object_types.length },
        { icon: GitBranch, label: 'Activities', value: summary.activities.length },
      ].map((card) => (
        <div key={card.label} className="card p-3">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-accent/10 p-1.5">
              <card.icon size={13} className="text-accent" />
            </div>
            <span className="text-[11px] text-fg-muted">{card.label}</span>
          </div>
          <p className="mt-2 text-[20px] font-bold tabular-nums text-fg">{card.value}</p>
        </div>
      ))}
    </div>
  );
}
