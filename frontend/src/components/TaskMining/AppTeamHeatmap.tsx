import { useEffect, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import clsx from 'clsx';
import { competitive } from '@/api/client';
import type { AppTeamHeatmapResponse } from '@/api/client';

// Workfellow-style heatmap: rows = teams/resources, columns =
// applications, cell = time spent. Warmest cells surface the
// team × app combinations where most time is going.

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export default function AppTeamHeatmap({ eventLogId }: { eventLogId: string }) {
  const [data, setData] = useState<AppTeamHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    competitive
      .appTeamHeatmap(eventLogId)
      .then(setData)
      .catch((e) => setError(e?.response?.data?.detail ?? 'Failed to load heatmap'))
      .finally(() => setLoading(false));
  }, [eventLogId]);

  if (loading) return <p className="text-[11px] text-fg-muted">Loading…</p>;
  if (error) {
    return (
      <div className="card p-5">
        <p className="text-[11px] text-fg-muted">{error}</p>
      </div>
    );
  }
  if (!data || data.teams.length === 0) return null;

  const maxSec = Math.max(...data.cells.map((c) => c.seconds), 1);
  const cellFor = (team: string, app: string) =>
    data.cells.find((c) => c.team === team && c.app === app);

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center gap-2">
        <Grid3x3 size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          Team × application time heatmap
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        How much time each team spends in each application. Darker cells
        are hotter — click any cell to focus on that team-app combination.
      </p>
      <div className="mt-4 overflow-auto rounded-lg border border-line">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface-1">
              <th className="sticky left-0 bg-surface-1 px-3 py-2 text-left font-semibold text-fg-faint">
                Team
              </th>
              {data.apps.map((a) => (
                <th key={a} className="px-3 py-2 text-left font-semibold text-fg-faint">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.teams.map((t, ti) => (
              <tr key={t} className={ti % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                <td className="sticky left-0 bg-surface-0 px-3 py-1.5 text-fg">{t}</td>
                {data.apps.map((a) => {
                  const cell = cellFor(t, a);
                  if (!cell) return <td key={a} className="px-3 py-1.5 text-fg-ghost">—</td>;
                  const intensity = cell.seconds / maxSec;
                  return (
                    <td
                      key={a}
                      className={clsx(
                        'px-3 py-1.5 text-center tabular-nums',
                        intensity > 0.7
                          ? 'bg-danger/30 text-danger'
                          : intensity > 0.4
                            ? 'bg-warning/20 text-warning'
                            : intensity > 0.1
                              ? 'bg-accent/10 text-accent'
                              : 'text-fg-muted',
                      )}
                      title={`${cell.seconds.toFixed(0)}s`}
                    >
                      {fmtDur(cell.seconds)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
