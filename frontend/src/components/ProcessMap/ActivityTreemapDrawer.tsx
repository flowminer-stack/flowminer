import { useEffect, useMemo, useState } from 'react';
import { X, Layers, Grid3x3 } from 'lucide-react';
import { competitive } from '@/api/client';
import type { ActivityTreemapResponse } from '@/api/client';

// ABBYY Timeline-style mid-map treemap drill-down. When a user asks
// "break this activity down by X", we fetch the attribute split and
// render it as a squarified treemap — cells sized by volume, coloured
// by average dwell.
//
// Squarified treemap algorithm: sort by value descending, then greedy-
// fill rows to keep aspect ratios close to 1. ~60 lines, no library.

interface Props {
  eventLogId: string;
  activity: string;
  onClose: () => void;
}

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

type Cell = { label: string; value: number; avg: number | null };
type Rect = { x: number; y: number; w: number; h: number };

function squarify(cells: Cell[], rect: Rect): Array<Cell & { r: Rect }> {
  // Standard squarified treemap — simplified for ~20 cells.
  const total = cells.reduce((s, c) => s + c.value, 0);
  if (total === 0) return [];
  const scale = (rect.w * rect.h) / total;
  const scaled = cells.map((c) => ({ ...c, area: c.value * scale }));
  const out: Array<Cell & { r: Rect }> = [];

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  let i = 0;

  while (i < scaled.length) {
    const short = Math.min(w, h);
    const row: typeof scaled = [];
    let rowSum = 0;
    let bestRatio = Infinity;

    while (i < scaled.length) {
      const next = scaled[i];
      const newSum = rowSum + next.area;
      const rowMax = Math.max(...row.map((r) => r.area), next.area);
      const rowMin = Math.min(...row.map((r) => r.area), next.area);
      const ratio = Math.max(
        (short * short * rowMax) / (newSum * newSum),
        (newSum * newSum) / (short * short * rowMin),
      );
      if (row.length > 0 && ratio > bestRatio) break;
      row.push(next);
      rowSum = newSum;
      bestRatio = ratio;
      i++;
    }

    // Lay out the row along the short axis.
    const rowLen = rowSum / short;
    let cursor = 0;
    for (const cell of row) {
      const cellShort = cell.area / rowLen;
      const r: Rect =
        w >= h
          ? { x, y: y + cursor, w: rowLen, h: cellShort }
          : { x: x + cursor, y, w: cellShort, h: rowLen };
      out.push({ label: cell.label, value: cell.value, avg: cell.avg, r });
      cursor += cellShort;
    }

    if (w >= h) {
      x += rowLen;
      w -= rowLen;
    } else {
      y += rowLen;
      h -= rowLen;
    }
  }
  return out;
}

export default function ActivityTreemapDrawer({ eventLogId, activity, onClose }: Props) {
  const [splitBy, setSplitBy] = useState('org:resource');
  const [data, setData] = useState<ActivityTreemapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    competitive
      .activityTreemap(eventLogId, activity, splitBy)
      .then(setData)
      .catch((e) => setError(e?.response?.data?.detail ?? 'Failed to load treemap'))
      .finally(() => setLoading(false));
  }, [eventLogId, activity, splitBy]);

  const rects = useMemo(() => {
    if (!data) return [];
    const cells: Cell[] = data.cells
      .sort((a, b) => b.value - a.value)
      .map((c) => ({ label: c.label, value: c.value, avg: c.avg_duration_seconds }));
    return squarify(cells, { x: 0, y: 0, w: 540, h: 320 });
  }, [data]);

  const maxAvg = Math.max(...rects.map((r) => r.avg ?? 0), 1);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-line bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Grid3x3 size={13} className="text-accent" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                Activity breakdown
              </span>
            </div>
            <p className="mt-1 text-[13px] font-semibold leading-tight text-fg">
              {activity}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-fg-muted hover:bg-tint hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[11px]">
          <Layers size={11} className="text-fg-faint" />
          <span className="text-fg-muted">Split by</span>
          <input
            value={splitBy}
            onChange={(e) => setSplitBy(e.target.value)}
            className="input w-40 py-1 text-[11px]"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <p className="text-[11px] text-fg-muted">Loading…</p>
          ) : error ? (
            <p className="text-[11px] text-danger">{error}</p>
          ) : rects.length === 0 ? (
            <p className="text-[11px] text-fg-muted">No data for this split.</p>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-fg-muted">
                Cell area = volume · colour intensity = avg dwell time. Hover
                each cell for exact numbers.
              </p>
              <svg width={540} height={320} className="rounded-lg bg-surface-1">
                {rects.map((r, i) => {
                  const intensity = r.avg ? r.avg / maxAvg : 0;
                  const fill = `rgba(6, 182, 212, ${0.15 + intensity * 0.55})`;
                  return (
                    <g key={i}>
                      <rect
                        x={r.r.x}
                        y={r.r.y}
                        width={Math.max(0, r.r.w - 1)}
                        height={Math.max(0, r.r.h - 1)}
                        fill={fill}
                        stroke="#06b6d4"
                        strokeWidth={0.5}
                      >
                        <title>
                          {r.label}: {r.value} events
                          {r.avg ? `, avg ${fmtDur(r.avg)}` : ''}
                        </title>
                      </rect>
                      {r.r.w > 60 && r.r.h > 18 && (
                        <text
                          x={r.r.x + 4}
                          y={r.r.y + 14}
                          fontSize={10}
                          fill="#e0e0e4"
                          style={{ pointerEvents: 'none' }}
                        >
                          {r.label.slice(0, 22)}
                        </text>
                      )}
                      {r.r.w > 60 && r.r.h > 30 && (
                        <text
                          x={r.r.x + 4}
                          y={r.r.y + 26}
                          fontSize={9}
                          fill="#9a9ca3"
                          style={{ pointerEvents: 'none' }}
                        >
                          {r.value} · {r.avg ? fmtDur(r.avg) : '—'}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
