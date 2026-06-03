import type { ActivityObjectTypesResponse } from '@/types';
import { getTypeColor, formatNumber, intensity } from './shared';

// ─── Activity × Object Type Panel ────────────────────────────────────────────

export default function ActivityObjectTypesPanel({
  data,
  objectTypes,
}: {
  data: ActivityObjectTypesResponse;
  objectTypes: string[];
}) {
  if (data.activities.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No activity data available.
      </p>
    );
  }

  // Collect all object types appearing in any row
  const colTypes = objectTypes.length > 0
    ? objectTypes
    : Array.from(
        new Set(data.activities.flatMap((a) => Object.keys(a.object_types))),
      ).sort();

  const maxInCol = new Map<string, number>();
  for (const colType of colTypes) {
    const vals = data.activities.map((a) => a.object_types[colType] ?? 0);
    maxInCol.set(colType, Math.max(...vals, 1));
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="border-b border-line pb-2 pr-4 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
              Activity
            </th>
            <th className="border-b border-line pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
              Events
            </th>
            {colTypes.map((t) => (
              <th
                key={t}
                className="border-b border-line pb-2 px-2 text-center text-[10px] font-medium whitespace-nowrap"
                style={{ minWidth: 60, color: getTypeColor(objectTypes, t) }}
                title={t}
              >
                <span className="block truncate max-w-[72px]">{t}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.activities.map((row) => (
            <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
              <td className="border-b border-line/40 py-1.5 pr-4 font-medium text-fg-secondary whitespace-nowrap">
                {row.activity}
              </td>
              <td className="border-b border-line/40 py-1.5 px-2 text-right tabular-nums text-fg-muted">
                {formatNumber(row.total_events)}
              </td>
              {colTypes.map((colType) => {
                const val = row.object_types[colType] ?? 0;
                const alpha = val > 0 ? 0.1 + 0.65 * intensity(val, maxInCol.get(colType) ?? 1) : 0;
                return (
                  <td
                    key={colType}
                    className="border-b border-line/40 py-1.5 px-2 text-center tabular-nums"
                    style={{
                      backgroundColor: val > 0
                        ? `color-mix(in srgb, ${getTypeColor(objectTypes, colType)} ${Math.round(alpha * 100)}%, transparent)`
                        : undefined,
                    }}
                  >
                    {val > 0 ? (
                      <span className="text-[11px] font-medium text-fg">{val}</span>
                    ) : (
                      <span className="text-[10px] text-fg-ghost">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-fg-faint">
        Cell values show average number of objects of each type per event execution.
      </p>
    </div>
  );
}
