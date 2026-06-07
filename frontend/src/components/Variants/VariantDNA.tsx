import { useMemo } from 'react';

interface Variant {
  id: number;
  activities: string[];
  frequency: number;
  percentage: number;
  avg_duration?: number | null;
  min_duration?: number | null;
  max_duration?: number | null;
}

interface Props {
  variants: Variant[];
  totalCases: number;
}

// Hash a string to an index in the palette — deterministic & stable across renders.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// 16-color palette chosen to be distinguishable in both light and dark contexts.
const PALETTE = [
  '#6ea8d8', // blue
  '#5cc8a8', // teal
  '#e0a458', // amber
  '#cf6f8a', // rose
  '#9b8bd4', // violet
  '#5bb0c9', // cyan
  '#d49a5b', // orange
  '#7ec97e', // green
  '#e87171', // red
  '#c9a05b', // gold
  '#a36dd4', // purple
  '#5bcfb5', // mint
  '#d4735b', // coral
  '#7097d4', // periwinkle
  '#bbd45b', // lime
  '#d45b9b', // pink
];

function activityColor(name: string): string {
  return PALETTE[hashStr(name) % PALETTE.length];
}

// How many "steps" (columns) do we need?
function maxSteps(variants: Variant[]): number {
  return Math.max(...variants.map((v) => v.activities.length), 1);
}

export default function VariantDNA({ variants }: Props) {
  const top = useMemo(() => variants.slice(0, 25), [variants]);

  const steps = useMemo(() => maxSteps(top), [top]);

  // Legend: activities sorted by total frequency across top variants.
  const legend = useMemo(() => {
    const freq = new Map<string, number>();
    for (const v of top) {
      for (const a of v.activities) {
        freq.set(a, (freq.get(a) ?? 0) + v.frequency);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name]) => name);
  }, [top]);

  if (top.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-line bg-surface-1">
        <p className="text-[12px] text-fg-muted">No variants to display.</p>
      </div>
    );
  }

  // Block width: fill available space per step, min 32 px, max 80 px.
  const BLOCK_W = 'minmax(32px, 80px)';
  const META_W = 160; // px

  return (
    <div className="card p-5">
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold text-fg">Variant DNA</h3>
        <p className="text-[11px] text-fg-muted">
          Each row is a variant; each block is one activity step. Columns align so
          common prefixes line up. Hover a block for the activity name.
          Showing top {top.length} of {variants.length} variants.
        </p>
      </div>

      <div className="overflow-auto">
        {/* Grid: meta column + one column per step */}
        <div
          className="min-w-max"
          style={{
            display: 'grid',
            gridTemplateColumns: `${META_W}px repeat(${steps}, ${BLOCK_W})`,
            gap: '2px 2px',
          }}
        >
          {/* Header row */}
          <div className="flex items-center pb-1 text-[10px] font-medium text-fg-faint">
            Variant
          </div>
          {Array.from({ length: steps }, (_, i) => (
            <div
              key={i}
              className="pb-1 text-center text-[9px] text-fg-ghost"
            >
              {i + 1}
            </div>
          ))}

          {/* Variant rows */}
          {top.map((v, rowIdx) => (
            <>
              {/* Meta */}
              <div
                key={`meta-${v.id}`}
                className="flex items-center gap-2 pr-2"
                style={{ minHeight: 24 }}
              >
                <span className="shrink-0 text-[10px] font-medium text-fg-muted">
                  #{rowIdx + 1}
                </span>
                <span className="truncate text-[10px] text-fg-faint">
                  {v.frequency.toLocaleString()}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-ghost">
                  {v.percentage.toFixed(1)}%
                </span>
              </div>

              {/* Activity blocks */}
              {Array.from({ length: steps }, (_, col) => {
                const act = v.activities[col];
                if (!act) {
                  return (
                    <div
                      key={`block-${v.id}-${col}`}
                      className="rounded-sm"
                      style={{ minHeight: 24, backgroundColor: 'transparent' }}
                    />
                  );
                }
                const bg = activityColor(act);
                return (
                  <div
                    key={`block-${v.id}-${col}`}
                    title={act}
                    className="flex items-center justify-center overflow-hidden rounded-sm px-1 text-[9px] font-medium text-white"
                    style={{
                      minHeight: 24,
                      backgroundColor: bg,
                      opacity: 0.85,
                    }}
                  >
                    <span className="truncate leading-none">{act}</span>
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>

      {/* Legend */}
      {legend.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
          {legend.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1.5 text-[10px] text-fg-muted"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: activityColor(name) }}
              />
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
