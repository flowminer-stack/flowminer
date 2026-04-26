import { useEffect, useState } from 'react';
import { BarChart3, Check } from 'lucide-react';
import { competitive } from '@/api/client';
import type { AttributeHistogramResponse } from '@/api/client';
import { useFilterStore } from '@/store/filterStore';

// Apromore-style attribute filter popover. Fetches a histogram for
// the given attribute and lets the user drag-select a numeric range
// (or click categorical values) to add a chip to the shared filter
// store. Numeric ranges become an `attribute_range` chip; categorical
// selections become `attribute_value` chips.

interface Props {
  eventLogId: string;
  attribute: string;
  onClose?: () => void;
}

export default function AttributeHistogramPopover({
  eventLogId,
  attribute,
  onClose,
}: Props) {
  const [data, setData] = useState<AttributeHistogramResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // For numeric: indices of first/last selected buckets. For
  // categorical: the set of selected bucket labels.
  const [numRange, setNumRange] = useState<[number, number] | null>(null);
  const [catSelected, setCatSelected] = useState<Set<string>>(new Set());
  const addChip = useFilterStore((s) => s.addChip);

  useEffect(() => {
    setLoading(true);
    setError(null);
    competitive
      .attributeHistogram(eventLogId, attribute)
      .then(setData)
      .catch((e) =>
        setError(e?.response?.data?.detail ?? 'Failed to load histogram'),
      )
      .finally(() => setLoading(false));
  }, [eventLogId, attribute]);

  const maxCount = Math.max(...(data?.buckets.map((b) => b.count) ?? [1]), 1);

  const applyNumeric = () => {
    if (!data || !numRange) return;
    const [lo, hi] = numRange;
    const a = data.buckets[Math.min(lo, hi)];
    const b = data.buckets[Math.max(lo, hi)];
    if (!a || !b) return;
    addChip({
      type: 'attribute_range',
      label: `${attribute}: ${(a.min ?? 0).toFixed(1)}–${(b.max ?? 0).toFixed(1)}`,
      payload: { attribute, min: a.min, max: b.max },
    });
    onClose?.();
  };

  const applyCategorical = () => {
    if (catSelected.size === 0) return;
    for (const v of catSelected) {
      addChip({
        type: 'attribute_value',
        label: `${attribute}: ${v}`,
        payload: { attribute, value: v },
      });
    }
    onClose?.();
  };

  return (
    <div className="w-[320px] rounded-lg border border-line bg-surface-0 p-3 shadow-xl">
      <div className="mb-2 flex items-center gap-2">
        <BarChart3 size={12} className="text-accent" />
        <span className="truncate text-[12px] font-semibold text-fg">
          {attribute}
        </span>
      </div>
      {loading ? (
        <p className="text-[11px] text-fg-muted">Loading histogram…</p>
      ) : error ? (
        <p className="text-[11px] text-danger">{error}</p>
      ) : !data || data.buckets.length === 0 ? (
        <p className="text-[11px] text-fg-muted">No data.</p>
      ) : data.is_numeric ? (
        <>
          {/* Clickable bar chart for numeric ranges. Click the first
              bucket, then click the second to define a range. */}
          <div className="flex h-24 items-end gap-0.5">
            {data.buckets.map((b, i) => {
              const inRange =
                numRange &&
                i >= Math.min(numRange[0], numRange[1]) &&
                i <= Math.max(numRange[0], numRange[1]);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (!numRange) setNumRange([i, i]);
                    else if (numRange[0] === numRange[1]) setNumRange([numRange[0], i]);
                    else setNumRange([i, i]);
                  }}
                  className="flex-1 transition-colors"
                  style={{
                    height: `${(b.count / maxCount) * 100}%`,
                    backgroundColor: inRange ? '#06b6d4' : '#3a3a40',
                  }}
                  title={`${b.label}: ${b.count} events`}
                />
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-fg-faint">
            <span>{data.min?.toFixed(1)}</span>
            <span>{data.max?.toFixed(1)}</span>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={!numRange}
              onClick={applyNumeric}
              className="btn-primary text-[11px] disabled:opacity-40"
            >
              <Check size={10} /> Apply range
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Categorical: checkable list of values */}
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {data.buckets.map((b) => {
              const sel = catSelected.has(b.label);
              return (
                <button
                  key={b.label}
                  type="button"
                  onClick={() => {
                    const next = new Set(catSelected);
                    if (sel) next.delete(b.label);
                    else next.add(b.label);
                    setCatSelected(next);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors hover:bg-tint"
                >
                  <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded border border-line">
                    {sel && <Check size={8} className="text-accent" />}
                  </span>
                  <span className="flex-1 truncate">{b.label}</span>
                  <span className="tabular-nums text-[10px] text-fg-faint">
                    {b.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={catSelected.size === 0}
              onClick={applyCategorical}
              className="btn-primary text-[11px] disabled:opacity-40"
            >
              <Check size={10} /> Apply ({catSelected.size})
            </button>
          </div>
        </>
      )}
    </div>
  );
}
