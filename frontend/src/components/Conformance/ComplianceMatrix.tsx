import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { competitive } from '@/api/client';
import type { ComplianceMatrixResponse } from '@/api/client';

// Minit / ARIS style compliance matrix: rules × segments heatmap of
// pass rates. Lets users pick which attribute to segment cases by
// (the column must exist in the log).

export default function ComplianceMatrix({
  eventLogId,
  defaultSegment = 'org:resource',
}: {
  eventLogId: string;
  defaultSegment?: string;
}) {
  const [segment, setSegment] = useState(defaultSegment);
  const [data, setData] = useState<ComplianceMatrixResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    competitive
      .complianceMatrix(eventLogId, segment)
      .then(setData)
      .catch((e) => {
        setError(
          e?.response?.data?.detail ??
            'Failed to compute matrix — check segment column',
        );
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [eventLogId, segment]);

  const cellFor = (rule: string, seg: string) =>
    data?.cells.find((c) => c.rule === rule && c.segment === seg) ?? null;

  const colorForRate = (rate: number) => {
    if (rate >= 0.95) return 'bg-success/20 text-success';
    if (rate >= 0.8) return 'bg-success/10 text-success';
    if (rate >= 0.6) return 'bg-warning/10 text-warning';
    return 'bg-danger/15 text-danger';
  };

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">Compliance matrix</h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Rule pass-rate per segment — cells show what fraction of cases in that
        segment honour each rule. Red = concentrated non-compliance.
      </p>
      <div className="mt-3 flex items-center gap-2 text-[11px]">
        <label className="text-fg-muted">Segment by column</label>
        <input
          type="text"
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          className="input w-48 py-1 text-[11px]"
          placeholder="e.g. org:resource"
        />
      </div>
      {loading ? (
        <p className="mt-4 text-[11px] text-fg-muted">Building matrix…</p>
      ) : error ? (
        <p className="mt-4 text-[11px] text-danger">{error}</p>
      ) : data && data.segments.length > 0 ? (
        <div className="mt-4 overflow-auto rounded-lg border border-line">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-1">
                <th className="sticky left-0 bg-surface-1 px-3 py-2 text-left font-semibold text-fg-faint">
                  Rule
                </th>
                {data.segments.map((s) => (
                  <th key={s} className="px-3 py-2 text-left font-semibold text-fg-faint">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r, ri) => (
                <tr key={r} className={ri % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                  <td className="sticky left-0 bg-surface-0 px-3 py-1.5 text-fg">{r}</td>
                  {data.segments.map((s) => {
                    const cell = cellFor(r, s);
                    if (!cell)
                      return (
                        <td key={s} className="px-3 py-1.5 text-fg-ghost">—</td>
                      );
                    return (
                      <td
                        key={s}
                        className={clsx(
                          'px-3 py-1.5 text-center font-semibold',
                          colorForRate(cell.pass_rate),
                        )}
                        title={`${cell.cases} cases`}
                      >
                        {(cell.pass_rate * 100).toFixed(0)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-fg-muted">No data for this segment.</p>
      )}
    </div>
  );
}
