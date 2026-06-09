import { useEffect, useState } from 'react';
import { Layers, Clock, Hourglass, ShieldCheck, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { mining as miningApi } from '@/api/client';
import type { ProcessStatistics } from '@/types';
import { formatDuration } from '@/utils/format';

// An X-ray-style headline strip: the four numbers that matter, the instant a
// log opens — no analysis to pick first. Deliberately backed by the single
// cheap getStatistics call (no variants/bottlenecks/conformance) so it stays
// fast even on million-event logs.
function Tile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
        <Icon size={13} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider leading-tight text-fg-faint">{label}</p>
        <p className="truncate text-[13px] font-semibold leading-tight tabular-nums text-fg">{value}</p>
      </div>
    </div>
  );
}

export default function QuickSnapshot({ eventLogId }: { eventLogId: string }) {
  const [stats, setStats] = useState<ProcessStatistics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setFailed(false);
    miningApi
      .getStatistics(eventLogId)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  if (failed) return null;

  if (!stats) {
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[46px] animate-pulse rounded-lg border border-line bg-surface-1" />
        ))}
      </div>
    );
  }

  // sla_compliance may arrive as a fraction (0–1) or a percentage (0–100).
  const slaPct =
    stats.sla_compliance == null
      ? null
      : Math.round(stats.sla_compliance <= 1 ? stats.sla_compliance * 100 : stats.sla_compliance);

  const tiles: { icon: LucideIcon; label: string; value: string }[] = [
    { icon: Layers, label: 'Cases', value: stats.total_cases.toLocaleString() },
    { icon: Clock, label: 'Avg cycle time', value: formatDuration(stats.avg_case_duration) },
    { icon: Hourglass, label: 'Median cycle time', value: formatDuration(stats.median_case_duration) },
    slaPct != null
      ? { icon: ShieldCheck, label: 'SLA compliance', value: `${slaPct}%` }
      : { icon: BarChart3, label: 'Activities', value: stats.total_activities.toLocaleString() },
  ];

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <Tile key={t.label} {...t} />
      ))}
    </div>
  );
}
