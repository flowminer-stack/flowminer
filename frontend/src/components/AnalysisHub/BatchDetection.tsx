import { mining as miningApi } from '@/api/client';
import type { BatchResponse } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { Layers } from 'lucide-react';
import { useAnalysisData } from '@/hooks/useAnalysisData';

interface Props { eventLogId: string; }

const batchTypeLabel: Record<string, string> = {
  sequential: 'Sequential',
  concurrent: 'Concurrent',
  parallel: 'Parallel',
  simultaneous: 'Simultaneous',
  batching: 'Batching',
};

const batchTypeBadge: Record<string, string> = {
  sequential: 'bg-accent/10 text-accent',
  concurrent: 'bg-accent/10 text-accent',
  parallel: 'bg-warning/10 text-warning',
  simultaneous: 'bg-success/10 text-success',
  batching: 'bg-accent/10 text-accent',
};

export default function BatchDetection({ eventLogId }: Props) {
  const { data, loading, error } = useAnalysisData<BatchResponse>(
    eventLogId, 'batches', miningApi.getBatches, 'Failed to load batch detection',
  );

  if (loading) return <div className="flex items-center justify-center py-16"><LoadingSpinner size="md" /></div>;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;
  if (!data) return null;

  if (data.batches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <Layers size={28} className="mb-2 text-fg-ghost" />
        <p className="text-[12px] font-medium text-fg-muted">No batches detected</p>
        <p className="mt-1 text-[11px] text-fg-faint">No batch processing patterns were found in this event log.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-[11px] text-fg-muted">Activities processed in batches rather than individually. Batching can improve efficiency but may increase waiting times.</p>
      <p className="mb-3 text-[11px] text-fg-faint">{data.batches.length} batch{data.batches.length !== 1 ? 'es' : ''} detected across activities and resources.</p>
      <div className="overflow-auto rounded-lg border border-line">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface-1">
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Activity</th>
              <th className="px-3 py-2 text-left font-semibold text-fg-faint">Resource</th>
              <th className="px-3 py-2 text-center font-semibold text-fg-faint">Type</th>
              <th className="px-3 py-2 text-right font-semibold text-fg-faint">Cases</th>
            </tr>
          </thead>
          <tbody>
            {data.batches.map((b, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-surface-0' : 'bg-surface-1'}>
                <td className="px-3 py-1.5 font-medium text-fg">{b.activity}</td>
                <td className="px-3 py-1.5 text-fg-secondary">{b.resource || '—'}</td>
                <td className="px-3 py-1.5 text-center">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${batchTypeBadge[b.batch_type] ?? 'bg-tint text-fg-muted'}`}>
                    {batchTypeLabel[b.batch_type] ?? b.batch_type}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-fg">{b.num_cases.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
