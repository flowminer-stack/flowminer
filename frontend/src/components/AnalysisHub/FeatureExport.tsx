import { mining as miningApi } from '@/api/client';
import type { FeatureExportResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { Download } from 'lucide-react';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(escape).join(',');
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
  return `${header}\n${body}`;
}

export default function FeatureExport({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<FeatureExportResponse>(
    eventLogId, 'features', miningApi.getFeatures, 'Failed to load feature data',
  );

  const downloadCsv = () => {
    if (!data) return;
    const csv = toCsv(data.columns, data.rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `features_${eventLogId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return null;

  const previewRows = data.rows.slice(0, 10);

  return (
    <div className="space-y-4">
      <p className="mb-3 text-[11px] text-fg-muted">Machine learning features extracted per case. Download as CSV for use in external analytics or prediction tools.</p>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-semibold text-fg">Case Feature Matrix</p>
          <p className="text-[11px] text-fg-faint">
            {data.total_cases.toLocaleString()} cases × {data.columns.length} features.
            {data.total_cases > 10 && ` Showing first 10 rows.`}
          </p>
        </div>
        <button
          onClick={downloadCsv}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent/90"
        >
          <Download size={12} />
          Download CSV
        </button>
      </div>

      {/* Preview table */}
      {data.columns.length === 0 ? (
        <p className="py-4 text-center text-[11px] text-fg-muted">No feature columns found.</p>
      ) : (
        <div className="overflow-auto rounded-lg border border-line">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="border-b border-line bg-surface-1">
                {data.columns.map((col) => (
                  <th key={col} className="px-3 py-2 text-left font-semibold text-fg-faint whitespace-nowrap" title={col}>
                    {col.length > 16 ? col.slice(0, 16) + '…' : col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.length === 0 ? (
                <tr><td colSpan={data.columns.length} className="py-6 text-center text-fg-muted">No rows available.</td></tr>
              ) : previewRows.map((row, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                  {data.columns.map((col) => {
                    const val = row[col];
                    const s = val === null || val === undefined ? '—' : String(val);
                    return (
                      <td key={col} className="px-3 py-1.5 tabular-nums text-fg-secondary whitespace-nowrap" title={s}>
                        {s.length > 14 ? s.slice(0, 14) + '…' : s}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
