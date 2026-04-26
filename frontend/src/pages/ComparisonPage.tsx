import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { GitCompare, AlertCircle, ChevronDown } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import clsx from 'clsx';
import { type ColumnDef } from '@tanstack/react-table';
import { useEventLogData } from '@/hooks/useProcessMining';
import { mining } from '@/api/client';
import DataTable from '@/components/common/DataTable';
import type { ComparisonResponse, ComparisonEdge } from '@/types';

// ─── Status badge styles ──────────────────────────────────────────────────────

const statusConfig: Record<
  string,
  { label: string; className: string }
> = {
  added:     { label: 'Added',     className: 'bg-success/10 text-success' },
  removed:   { label: 'Removed',   className: 'bg-danger/10 text-danger' },
  increased: { label: 'Increased', className: 'bg-accent/10 text-accent' },
  decreased: { label: 'Decreased', className: 'bg-warning/10 text-warning' },
  unchanged: { label: 'Unchanged', className: 'bg-tint text-fg-muted' },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { label: status, className: 'bg-tint text-fg-muted' };
  return (
    <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold', cfg.className)}>
      {cfg.label}
    </span>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  title,
  stats,
  colorClass,
}: {
  title: string;
  stats: Record<string, number>;
  colorClass: string;
}) {
  return (
    <div className="card flex-1 p-4">
      <h3 className={clsx('mb-3 text-[12px] font-semibold', colorClass)}>{title}</h3>
      <dl className="space-y-2">
        {Object.entries(stats).map(([key, val]) => (
          <div key={key} className="flex items-center justify-between">
            <dt className="text-[12px] text-fg-muted capitalize">{key.replace(/_/g, ' ')}</dt>
            <dd className="text-[12px] font-medium text-fg">{typeof val === 'number' && val % 1 !== 0 ? val.toFixed(2) : val.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ─── Table columns ────────────────────────────────────────────────────────────

const edgeColumns: ColumnDef<ComparisonEdge, unknown>[] = [
  {
    accessorKey: 'source',
    header: 'Source',
    cell: (info) => (
      <span className="rounded-md bg-tint px-1.5 py-0.5 text-[11px] font-medium text-fg-secondary">
        {info.getValue() as string}
      </span>
    ),
  },
  {
    accessorKey: 'target',
    header: 'Target',
    cell: (info) => (
      <span className="rounded-md bg-tint px-1.5 py-0.5 text-[11px] font-medium text-fg-secondary">
        {info.getValue() as string}
      </span>
    ),
  },
  {
    accessorKey: 'frequency_a',
    header: 'Freq A',
    cell: (info) => (info.getValue() as number).toLocaleString(),
  },
  {
    accessorKey: 'frequency_b',
    header: 'Freq B',
    cell: (info) => (info.getValue() as number).toLocaleString(),
  },
  {
    accessorKey: 'diff',
    header: 'Diff',
    cell: (info) => {
      const v = info.getValue() as number;
      return (
        <span className={clsx('font-medium tabular-nums', v > 0 ? 'text-success' : v < 0 ? 'text-danger' : 'text-fg-muted')}>
          {v > 0 ? '+' : ''}{v.toLocaleString()}
        </span>
      );
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: (info) => <StatusBadge status={info.getValue() as string} />,
  },
];

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ComparisonPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog, preview } = useEventLogData(eventLogId);

  const [splitAttribute, setSplitAttribute] = useState('');
  const [valueA, setValueA] = useState('');
  const [valueB, setValueB] = useState('');
  const [result, setResult] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Populate split attribute from event log columns
  const availableColumns = useMemo(() => {
    if (!preview) return [];
    return preview.columns;
  }, [preview]);

  useEffect(() => {
    if (availableColumns.length > 0 && !splitAttribute) {
      setSplitAttribute(availableColumns[0]);
    }
  }, [availableColumns, splitAttribute]);

  const handleCompare = async () => {
    if (!eventLogId || !splitAttribute || !valueA || !valueB) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await mining.compare({
        event_log_id: eventLogId,
        split_attribute: splitAttribute,
        split_value_a: valueA,
        split_value_b: valueB,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed');
    } finally {
      setLoading(false);
    }
  };

  // Edge diff summary counts
  const edgeSummary = useMemo(() => {
    if (!result) return null;
    const added = result.edges.filter((e) => e.status === 'added').length;
    const removed = result.edges.filter((e) => e.status === 'removed').length;
    const changed = result.edges.filter(
      (e) => e.status === 'increased' || e.status === 'decreased',
    ).length;
    return { added, removed, changed };
  }, [result]);

  const canCompare = !!splitAttribute && !!valueA && !!valueB;

  return (
    <div>
      <PageHeader
        title="Process Comparison"
        icon={GitCompare}
        backTo={-1}
        description="Split the event log by an attribute value and compare two process variants side by side. Highlights added, removed, and frequency-changed flows."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      {/* Configuration panel */}
      <div className="card mt-5 p-5">
        <h2 className="text-[13px] font-semibold text-fg mb-4">Comparison Configuration</h2>
        <div className="flex flex-wrap items-end gap-4">
          {/* Split by */}
          <div className="min-w-[160px]">
            <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
              Split by
            </label>
            <div className="relative">
              <select
                value={splitAttribute}
                onChange={(e) => setSplitAttribute(e.target.value)}
                className="input w-full appearance-none pr-8 text-[12px]"
              >
                {availableColumns.length === 0 && (
                  <option value="">Loading columns...</option>
                )}
                {availableColumns.map((col) => (
                  <option key={col} value={col}>
                    {col}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint"
              />
            </div>
          </div>

          {/* Group A value */}
          <div className="min-w-[140px]">
            <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
              Group A value
            </label>
            <input
              type="text"
              value={valueA}
              onChange={(e) => setValueA(e.target.value)}
              placeholder="e.g. high"
              className="input w-full text-[12px]"
            />
          </div>

          {/* Group B value */}
          <div className="min-w-[140px]">
            <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
              Group B value
            </label>
            <input
              type="text"
              value={valueB}
              onChange={(e) => setValueB(e.target.value)}
              placeholder="e.g. low"
              className="input w-full text-[12px]"
            />
          </div>

          {/* Compare button */}
          <button
            onClick={handleCompare}
            disabled={!canCompare || loading}
            className={clsx(
              'btn-primary shrink-0',
              (!canCompare || loading) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-surface-0/30 border-t-surface-0" />
                Comparing...
              </span>
            ) : (
              'Compare'
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3">
          <AlertCircle size={16} className="shrink-0 text-danger" />
          <p className="text-[12px] text-danger">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          {/* Side-by-side stats */}
          <div className="mt-6">
            <h2 className="mb-4 text-[14px] font-semibold text-fg">Statistics Comparison</h2>
            <div className="flex gap-4">
              <StatCard
                title={`Group A: ${valueA}`}
                stats={result.stats_a}
                colorClass="text-accent"
              />
              <StatCard
                title={`Group B: ${valueB}`}
                stats={result.stats_b}
                colorClass="text-warning"
              />
            </div>
          </div>

          {/* Summary */}
          {edgeSummary && (
            <div className="mt-5 flex flex-wrap gap-3">
              <div className="flex items-center gap-1.5 rounded-full border border-success/20 bg-success/5 px-3 py-1.5">
                <span className="text-[12px] font-medium text-success">
                  {edgeSummary.added} edge{edgeSummary.added !== 1 ? 's' : ''} added
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-danger/20 bg-danger/5 px-3 py-1.5">
                <span className="text-[12px] font-medium text-danger">
                  {edgeSummary.removed} edge{edgeSummary.removed !== 1 ? 's' : ''} removed
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-full border border-line bg-tint px-3 py-1.5">
                <span className="text-[12px] font-medium text-fg-secondary">
                  {edgeSummary.changed} edge{edgeSummary.changed !== 1 ? 's' : ''} changed
                </span>
              </div>
            </div>
          )}

          {/* Edge diff table */}
          <div className="mt-6">
            <h2 className="mb-4 text-[14px] font-semibold text-fg">Edge Differences</h2>
            <DataTable
              data={result.edges}
              columns={edgeColumns}
              searchable
              searchPlaceholder="Search edges..."
              paginated
              pageSize={15}
              emptyMessage="No edge differences"
              emptyDescription="Both groups have identical process flows."
            />
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <EmptyState
          className="mt-10"
          icon={GitCompare}
          title="Configure and run a comparison"
          description="Split the event log by an attribute value to compare two process variants."
        />
      )}
    </div>
  );
}
