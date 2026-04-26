import { useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import { competitive } from '@/api/client';
import type { InterAppGraphResponse } from '@/api/client';

// Workfellow-style inter-application path graph. Shows every app as a
// node and every observed "user switched from A to B" transition as
// an edge, with weight = count and avg dwell time on the source app.
// Rendered as a simple force-free circular layout so it works without
// any graph library setup. Nodes are keyed by app name.

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export default function InterAppGraph({
  eventLogId,
  appColumn = 'application',
}: {
  eventLogId: string;
  appColumn?: string;
}) {
  const [data, setData] = useState<InterAppGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    competitive
      .interAppGraph(eventLogId, appColumn)
      .then(setData)
      .catch((e) => setError(e?.response?.data?.detail ?? 'Failed to load graph'))
      .finally(() => setLoading(false));
  }, [eventLogId, appColumn]);

  const { positions, size } = useMemo(() => {
    if (!data || data.apps.length === 0) return { positions: new Map(), size: 400 };
    const s = Math.max(380, 80 * Math.ceil(Math.sqrt(data.apps.length * 2)));
    const cx = s / 2;
    const cy = s / 2;
    const r = s / 2 - 50;
    const positions = new Map<string, { x: number; y: number }>();
    data.apps.forEach((app, i) => {
      const angle = (i / data.apps.length) * 2 * Math.PI - Math.PI / 2;
      positions.set(app, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return { positions, size: s };
  }, [data]);

  if (loading) return <p className="text-[11px] text-fg-muted">Computing…</p>;
  if (error) {
    return (
      <div className="card p-5">
        <p className="text-[11px] text-fg-muted">
          <Network size={12} className="mr-1 inline text-fg-faint" />
          {error}
        </p>
      </div>
    );
  }
  if (!data || data.apps.length === 0) {
    return (
      <div className="card p-5">
        <p className="text-[11px] text-fg-muted">
          No application-switching data for this log. Enable task mining to
          populate an <code>application</code> column.
        </p>
      </div>
    );
  }

  const maxCount = Math.max(...data.edges.map((e) => e.count), 1);

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center gap-2">
        <Network size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          Inter-application path graph
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Directed graph of worker navigation between applications. Edge
        thickness = number of transitions, tooltip shows avg dwell.
      </p>
      <div className="mt-4 overflow-auto">
        <svg width={size} height={size} className="rounded-lg bg-surface-1">
          {/* Edges */}
          {data.edges.map((e, i) => {
            const p1 = positions.get(e.source_app);
            const p2 = positions.get(e.target_app);
            if (!p1 || !p2) return null;
            const w = 1 + (e.count / maxCount) * 5;
            return (
              <line
                key={i}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke="#06b6d4"
                strokeWidth={w}
                strokeOpacity={0.5}
              >
                <title>
                  {e.source_app} → {e.target_app} · {e.count} transitions · avg {fmtDur(e.avg_dwell_seconds)}
                </title>
              </line>
            );
          })}
          {/* Nodes */}
          {data.apps.map((app) => {
            const p = positions.get(app)!;
            return (
              <g key={app}>
                <circle cx={p.x} cy={p.y} r={18} fill="#242428" stroke="#06b6d4" strokeWidth={1.5} />
                <text
                  x={p.x}
                  y={p.y + 34}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#e0e0e4"
                >
                  {app}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
