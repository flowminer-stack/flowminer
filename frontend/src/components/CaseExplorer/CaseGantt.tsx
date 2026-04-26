import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { competitive } from '@/api/client';
import type { CaseGanttResponse } from '@/api/client';

// Disco-style case Gantt: one lane per case, each event an horizontal
// block on a shared time axis. Reveals concurrency and idle gaps at a
// glance that aggregate bar charts hide.

export default function CaseGantt({ eventLogId }: { eventLogId: string }) {
  const [data, setData] = useState<CaseGanttResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    competitive.caseGantt(eventLogId, 40).then(setData).finally(() => setLoading(false));
  }, [eventLogId]);

  if (loading) return <p className="text-[11px] text-fg-muted">Loading…</p>;
  if (!data || data.cases.length === 0) return null;

  // Build a shared timeline [minStart, maxEnd] across all cases.
  const starts = data.cases.map((c) => new Date(c.start).getTime());
  const ends = data.cases.map((c) => new Date(c.end).getTime());
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  const span = Math.max(maxEnd - minStart, 1);

  // Stable colour per activity so the same label keeps its colour.
  const palette = ['#06b6d4', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#3b82f6', '#ec4899', '#84cc16'];
  const colourMap = new Map<string, string>();
  const colour = (act: string) => {
    if (!colourMap.has(act)) {
      colourMap.set(act, palette[colourMap.size % palette.length]);
    }
    return colourMap.get(act)!;
  };

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center gap-2">
        <Timer size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          Case Gantt ({data.cases.length} of {data.total})
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        One lane per case. Each block is an activity; gaps are waiting time.
      </p>
      <div className="mt-4 max-h-[480px] overflow-auto">
        <div className="space-y-0.5">
          {data.cases.map((c) => {
            const caseStart = new Date(c.start).getTime();
            const caseEnd = new Date(c.end).getTime();
            const left = ((caseStart - minStart) / span) * 100;
            const width = Math.max(0.5, ((caseEnd - caseStart) / span) * 100);
            return (
              <div
                key={c.case_id}
                className="flex items-center gap-2 text-[10px]"
                title={c.case_id}
              >
                <span className="w-32 shrink-0 truncate text-fg-muted">{c.case_id}</span>
                <div className="relative h-3 flex-1 rounded bg-surface-1">
                  <div
                    className="absolute inset-y-0"
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <div className="flex h-full w-full">
                      {c.events.map((e, i) => {
                        const eStart = new Date(e.start).getTime();
                        const eEnd = new Date(e.end).getTime();
                        const eWidth = Math.max(1, ((eEnd - eStart) / (caseEnd - caseStart)) * 100);
                        return (
                          <div
                            key={i}
                            className="h-full"
                            style={{
                              width: `${eWidth}%`,
                              backgroundColor: colour(e.activity),
                              opacity: 0.85,
                            }}
                            title={`${e.activity}\n${e.start} → ${e.end}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
