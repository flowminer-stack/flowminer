import { useEffect, useState } from 'react';
import { mining as miningApi } from '@/api/client';
import type { SNAResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import clsx from 'clsx';
import { getCached, setCached } from '@/store/analysisCache';

interface Props { eventLogId: string; }

type SNAType = 'handover' | 'working_together' | 'subcontracting';

const SNA_TYPES: { value: SNAType; label: string }[] = [
  { value: 'handover', label: 'Handover' },
  { value: 'working_together', label: 'Working Together' },
  { value: 'subcontracting', label: 'Subcontracting' },
];

export default function SNAView({ eventLogId }: Props) {
  const [snaType, setSnaType] = useState<SNAType>('handover');
  const cacheKey = `sna:${snaType}`;
  const cached = getCached<SNAResponse>(eventLogId, cacheKey);
  const [data, setData] = useState<SNAResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = `sna:${snaType}`;
    const existing = getCached<SNAResponse>(eventLogId, key);
    if (existing) {
      setData(existing);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    miningApi.getSNA(eventLogId, snaType)
      .then((d) => {
        setCached(eventLogId, key, d);
        setData(d);
      })
      .catch(() => setError('Failed to load SNA data'))
      .finally(() => setLoading(false));
  }, [eventLogId, snaType]);

  return (
    <div className="space-y-4">
      <p className="mb-3 text-[11px] text-fg-muted">How resources interact with each other. Handover shows work passing between people; Working Together shows collaboration.</p>
      {/* Type selector */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-fg-faint">Network type:</span>
        <div className="flex rounded border border-line bg-surface-1 p-px">
          {SNA_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setSnaType(t.value)}
              className={clsx(
                'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                snaType === t.value ? 'bg-accent text-white' : 'text-fg-muted hover:bg-tint hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><LoadingSpinner size="md" /></div>
      ) : error ? (
        <p className="py-8 text-center text-[12px] text-fg-muted">{error}</p>
      ) : !data || data.resources.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-fg-muted">No SNA data available. Resource column required.</p>
      ) : (
        <div>
          <p className="mb-3 text-[11px] text-fg-faint">
            {data.resources.length} resources. Cell value = interaction weight. Darker = stronger relationship.
          </p>
          <div className="overflow-auto rounded-lg border border-line">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="border-b border-line bg-surface-1">
                  <th className="sticky left-0 z-10 bg-surface-1 px-3 py-2 text-left font-semibold text-fg-faint">Resource</th>
                  {data.resources.map((r) => (
                    <th key={r} className="px-2 py-2 text-center font-medium text-fg-secondary whitespace-nowrap" title={r}>
                      {r.length > 8 ? r.slice(0, 8) + '…' : r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.resources.map((src, ri) => {
                  const row = data.matrix[ri] ?? [];
                  const rowMax = Math.max(...row.filter((v) => v > 0), 0.001);
                  return (
                    <tr key={src} className={ri % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                      <td className="sticky left-0 z-10 border-r border-line bg-inherit px-3 py-1.5 font-medium text-fg-secondary whitespace-nowrap" title={src}>
                        {src.length > 12 ? src.slice(0, 12) + '…' : src}
                      </td>
                      {row.map((val, ci) => {
                        const intensity = val > 0 ? Math.round((val / rowMax) * 70 + 8) : 0;
                        return (
                          <td
                            key={ci}
                            className="px-2 py-1.5 text-center"
                            style={val > 0 ? { backgroundColor: `color-mix(in srgb, var(--color-accent) ${intensity}%, transparent)` } : undefined}
                          >
                            {val > 0 ? (
                              <span className="tabular-nums text-[10px] font-medium text-fg">
                                {val % 1 === 0 ? val.toLocaleString() : val.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-fg-ghost">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
