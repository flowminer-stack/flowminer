import type { ObjectInteractionsResponse } from '@/types';
import { getTypeColor, formatNumber, intensity } from './shared';

// ─── Object Interactions Panel ────────────────────────────────────────────────

export default function ObjectInteractionsPanel({
  data,
  objectTypes,
}: {
  data: ObjectInteractionsResponse;
  objectTypes: string[];
}) {
  if (data.interactions.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No object interactions found.
      </p>
    );
  }

  // Build a type-pair matrix
  const typesInvolved = Array.from(
    new Set(data.interactions.flatMap((i) => [i.type_a, i.type_b])),
  ).sort();

  // Map (a, b) -> count (treat as undirected: use canonical order for lookup)
  const countMap = new Map<string, number>();
  const maxCount = Math.max(...data.interactions.map((i) => i.interaction_count), 1);

  for (const interaction of data.interactions) {
    const key = `${interaction.type_a}|||${interaction.type_b}`;
    const keyRev = `${interaction.type_b}|||${interaction.type_a}`;
    const existing = countMap.get(key) ?? countMap.get(keyRev) ?? 0;
    countMap.set(key, existing + interaction.interaction_count);
  }

  function getCount(a: string, b: string): number {
    return (
      countMap.get(`${a}|||${b}`) ??
      countMap.get(`${b}|||${a}`) ??
      0
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="w-28 border-b border-line pb-2 pr-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              Type
            </th>
            {typesInvolved.map((t) => (
              <th
                key={t}
                className="border-b border-line pb-2 px-2 text-center text-[10px] font-medium text-fg-muted"
                style={{ minWidth: 64 }}
              >
                <span
                  className="inline-block truncate max-w-[80px]"
                  title={t}
                  style={{ color: getTypeColor(objectTypes, t) }}
                >
                  {t}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {typesInvolved.map((rowType) => (
            <tr key={rowType} className="group">
              <td className="border-b border-line/50 py-1.5 pr-3 font-medium text-fg-secondary">
                <span
                  className="truncate block max-w-[100px]"
                  title={rowType}
                  style={{ color: getTypeColor(objectTypes, rowType) }}
                >
                  {rowType}
                </span>
              </td>
              {typesInvolved.map((colType) => {
                const count = getCount(rowType, colType);
                const alpha = count > 0 ? 0.12 + 0.7 * intensity(count, maxCount) : 0;
                return (
                  <td
                    key={colType}
                    className="border-b border-line/50 py-1.5 px-2 text-center tabular-nums"
                    style={{
                      backgroundColor: count > 0
                        ? `color-mix(in srgb, ${getTypeColor(objectTypes, rowType)} ${Math.round(alpha * 100)}%, transparent)`
                        : undefined,
                    }}
                    title={count > 0 ? `${rowType} ↔ ${colType}: ${count}` : undefined}
                  >
                    {count > 0 ? (
                      <span className="text-[11px] font-medium text-fg">
                        {formatNumber(count)}
                      </span>
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
        Total interactions: {formatNumber(data.total_interactions)}
      </p>
    </div>
  );
}
