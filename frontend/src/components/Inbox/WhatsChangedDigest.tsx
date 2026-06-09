import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, TrendingUp, TrendingDown, Plus, ShieldCheck, ArrowRight, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useProjectsStore } from '@/store';
import { eventLogs as eventLogsApi, mining as miningApi } from '@/api/client';
import { recordSnapshot, acknowledgeLog } from '@/utils/digestMetrics';
import { formatDuration } from '@/utils/format';

interface Delta {
  key: string;
  logId: string;
  logName: string;
  icon: LucideIcon;
  label: string;
  tone: 'good' | 'bad' | 'neutral';
  to: string;
}

// Bounded so the Inbox stays snappy even with many projects / huge logs.
const MAX_PROJECTS = 5;
const MAX_CARDS = 6;

/**
 * "Since your last visit" — Tableau-Pulse-style proactive digest. For the most
 * recent few projects, diffs cheap current metrics against the previous
 * snapshot (see utils/digestMetrics) and surfaces what moved, each linking to
 * the relevant analysis. Renders nothing on a first visit or when nothing
 * changed; deltas persist across refreshes until dismissed or superseded.
 */
export default function WhatsChangedDigest() {
  const navigate = useNavigate();
  const projects = useProjectsStore((s) => s.projects);
  const [deltas, setDeltas] = useState<Delta[]>([]);

  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    (async () => {
      const recent = [...projects]
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
        .slice(0, MAX_PROJECTS);

      // Each project is independent — fetch them concurrently, keep the order.
      const perProject = await Promise.all(
        recent.map(async (project): Promise<Delta[]> => {
          let primaryId: string;
          let primaryName: string;
          try {
            const logs = await eventLogsApi.list(project.id);
            const primary = logs.find((l) => l.status === 'ready');
            if (!primary) return [];
            primaryId = primary.id;
            primaryName = primary.name;
          } catch {
            return [];
          }

          let stats;
          try {
            stats = await miningApi.getStatistics(primaryId);
          } catch {
            return [];
          }

          const slaNorm =
            stats.sla_compliance == null
              ? null
              : stats.sla_compliance <= 1
              ? stats.sla_compliance * 100
              : stats.sla_compliance;
          const prev = recordSnapshot(primaryId, {
            avgDuration: stats.avg_case_duration,
            totalCases: stats.total_cases,
            slaCompliance: slaNorm,
          });
          if (!prev) return [];

          const found: Delta[] = [];

          // Avg cycle time
          if (prev.avgDuration > 0) {
            const pct = ((stats.avg_case_duration - prev.avgDuration) / prev.avgDuration) * 100;
            if (Math.abs(pct) >= 5) {
              found.push({
                key: `${primaryId}-dur`,
                logId: primaryId,
                logName: primaryName,
                icon: pct > 0 ? TrendingUp : TrendingDown,
                label: `Avg cycle time ${pct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(pct))}% (now ${formatDuration(stats.avg_case_duration)})`,
                tone: pct > 0 ? 'bad' : 'good',
                to: `/process/${primaryId}`,
              });
            }
          }

          // New cases
          const caseDiff = stats.total_cases - prev.totalCases;
          if (caseDiff > 0) {
            found.push({
              key: `${primaryId}-cases`,
              logId: primaryId,
              logName: primaryName,
              icon: Plus,
              label: `${caseDiff.toLocaleString()} new case${caseDiff === 1 ? '' : 's'} since last visit`,
              tone: 'neutral',
              to: `/process/${primaryId}`,
            });
          }

          // SLA compliance
          if (prev.slaCompliance != null && slaNorm != null) {
            const pts = Math.round(slaNorm - prev.slaCompliance);
            if (Math.abs(pts) >= 1) {
              found.push({
                key: `${primaryId}-sla`,
                logId: primaryId,
                logName: primaryName,
                icon: ShieldCheck,
                label: `SLA compliance ${pts > 0 ? 'up' : 'down'} ${Math.abs(pts)} pts (now ${Math.round(slaNorm)}%)`,
                tone: pts > 0 ? 'good' : 'bad',
                to: `/conformance/${primaryId}`,
              });
            }
          }

          return found;
        }),
      );

      if (!cancelled) setDeltas(perProject.flat().slice(0, MAX_CARDS));
    })();

    return () => {
      cancelled = true;
    };
  }, [projects]);

  if (deltas.length === 0) return null;

  const dismiss = () => {
    for (const logId of new Set(deltas.map((d) => d.logId))) acknowledgeLog(logId);
    setDeltas([]);
  };

  const toneClass = (tone: Delta['tone']) =>
    tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : 'text-accent';

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-1.5">
        <History size={14} className="text-accent" />
        <h2 className="text-[12px] font-bold uppercase tracking-widest text-fg-faint">
          Since your last visit
        </h2>
        <button
          onClick={dismiss}
          title="Dismiss — these reappear when the numbers move again"
          className="ml-auto rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
        >
          <X size={13} />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {deltas.map((d) => {
          const Icon = d.icon;
          return (
            <button
              key={d.key}
              onClick={() => navigate(d.to)}
              className="group flex items-start gap-2.5 rounded-xl border border-line bg-surface-1 p-3 text-left transition-all hover:border-line-strong"
            >
              <Icon size={15} className={clsx('mt-0.5 shrink-0', toneClass(d.tone))} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-fg">{d.logName}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{d.label}</p>
              </div>
              <ArrowRight
                size={12}
                className="mt-0.5 shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
