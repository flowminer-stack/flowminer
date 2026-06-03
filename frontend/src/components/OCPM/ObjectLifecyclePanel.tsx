import type { ObjectLifecycleResponse } from '@/types';
import { formatDuration } from '@/utils/format';
import { getTypeColor, formatNumber } from './shared';

// ─── Object Lifecycle Panel ───────────────────────────────────────────────────

export default function ObjectLifecyclePanel({
  data,
  objectTypes,
}: {
  data: ObjectLifecycleResponse;
  objectTypes: string[];
}) {
  if (data.lifecycles.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No lifecycle data available.
      </p>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {data.lifecycles.map((lc) => {
        const color = getTypeColor(objectTypes, lc.object_type);
        return (
          <div
            key={lc.object_type}
            className="rounded-md border border-line bg-surface-1 p-3"
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span
                className="text-[12px] font-semibold truncate"
                style={{ color }}
                title={lc.object_type}
              >
                {lc.object_type}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center mb-2">
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {formatNumber(lc.object_count)}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">objects</p>
              </div>
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {lc.avg_lifecycle_duration == null ? '—' : formatDuration(lc.avg_lifecycle_duration)}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">avg life</p>
              </div>
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {lc.avg_events_per_object > 0 ? lc.avg_events_per_object.toFixed(1) : '—'}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">evt/obj</p>
              </div>
            </div>
            {lc.activities.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {lc.activities.slice(0, 8).map((act) => (
                  <span
                    key={act}
                    className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-tint text-fg-muted truncate max-w-[100px]"
                    title={act}
                  >
                    {act}
                  </span>
                ))}
                {lc.activities.length > 8 && (
                  <span className="rounded px-1.5 py-0.5 text-[9px] text-fg-faint bg-tint">
                    +{lc.activities.length - 8} more
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
