import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import {
  X,
  ChevronRight,
  Clock,
  Hash,
  ArrowRight,
  User,
  Loader2,
  AlertCircle,
  Inbox,
} from 'lucide-react';
import clsx from 'clsx';
import { format, parseISO } from 'date-fns';
import DataTable from '@/components/common/DataTable';
import { mining } from '@/api/client';
import type { CaseInfo, CaseDetailResponse } from '@/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDurationSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatTimestamp(ts: string): string {
  try {
    return format(parseISO(ts), 'MMM d, HH:mm');
  } catch {
    return ts;
  }
}

// ─── Case Detail Panel ────────────────────────────────────────────────────────

interface CaseDetailPanelProps {
  eventLogId: string;
  caseId: string;
  onClose: () => void;
}

const CaseDetailPanel: React.FC<CaseDetailPanelProps> = ({
  eventLogId,
  caseId,
  onClose,
}) => {
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    mining
      .getCaseDetail(eventLogId, caseId)
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load case details.');
        setLoading(false);
      });
  }, [eventLogId, caseId]);

  return (
    <div className="flex h-full flex-col border-l border-line bg-surface-1">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Case Detail
          </p>
          <p className="mt-0.5 font-mono text-[12px] font-semibold text-fg">
            {caseId}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-tint hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-fg-muted" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-[12px] text-danger">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {detail && !loading && (
          <>
            {/* Summary */}
            <div className="mb-4 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                <p className="text-[10px] text-fg-faint uppercase tracking-wider">Events</p>
                <p className="mt-0.5 text-sm font-semibold text-fg">
                  {detail.events.length}
                </p>
              </div>
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                <p className="text-[10px] text-fg-faint uppercase tracking-wider">Duration</p>
                <p className="mt-0.5 text-sm font-semibold text-fg">
                  {formatDurationSeconds(detail.total_duration)}
                </p>
              </div>
            </div>

            {/* Vertical timeline */}
            <div className="space-y-0">
              {detail.events.map((evt, idx) => {
                const isLast = idx === detail.events.length - 1;
                const isFirst = idx === 0;
                return (
                  <div key={idx} className="flex gap-3">
                    {/* Timeline track */}
                    <div className="flex flex-col items-center">
                      <div
                        className={clsx(
                          'z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                          isFirst
                            ? 'border-success/40 bg-success/10 text-success'
                            : isLast
                            ? 'border-danger/40 bg-danger/10 text-danger'
                            : 'border-line bg-surface-2 text-fg-muted',
                        )}
                      >
                        <span className="text-[9px] font-bold">{idx + 1}</span>
                      </div>
                      {!isLast && (
                        <div className="w-px flex-1 bg-line my-0.5" />
                      )}
                    </div>

                    {/* Event card */}
                    <div className={clsx('flex-1 pb-3', isLast && 'pb-0')}>
                      <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                        <p className="text-[12px] font-medium text-fg">
                          {evt.activity}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-fg-muted">
                          <span className="flex items-center gap-1">
                            <Clock size={9} />
                            {formatTimestamp(evt.timestamp)}
                          </span>
                          {evt.resource && (
                            <span className="flex items-center gap-1">
                              <User size={9} />
                              {evt.resource}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Duration to next */}
                      {!isLast && evt.duration_to_next !== null && (
                        <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-fg-faint">
                          <ArrowRight size={9} />
                          <span>{formatDurationSeconds(evt.duration_to_next)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

interface CaseExplorerProps {
  eventLogId: string;
  isOpen: boolean;
  onClose: () => void;
  embedded?: boolean;
}

const CaseExplorer: React.FC<CaseExplorerProps> = ({
  eventLogId,
  isOpen,
  onClose,
  embedded = false,
}) => {
  const [cases, setCases] = useState<CaseInfo[]>([]);
  const [totalCases, setTotalCases] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    mining
      .getCases(eventLogId)
      .then((data) => {
        setCases(data.cases);
        setTotalCases(data.total_cases);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to load cases.');
        setLoading(false);
      });
  }, [eventLogId, isOpen]);

  const handleRowClick = useCallback((caseInfo: CaseInfo) => {
    setSelectedCaseId((prev) =>
      prev === caseInfo.case_id ? null : caseInfo.case_id,
    );
  }, []);

  const handleTableClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const tr = (e.target as HTMLElement).closest('tbody tr');
    if (!tr) return;
    const tbody = tr.closest('tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const idx = rows.indexOf(tr as HTMLTableRowElement);
    if (idx >= 0 && cases[idx]) {
      handleRowClick(cases[idx]);
    }
  }, [cases, handleRowClick]);

  const columns = useMemo<ColumnDef<CaseInfo, unknown>[]>(
    () => [
      {
        accessorKey: 'case_id',
        header: 'Case ID',
        cell: ({ getValue }) => (
          <span className="font-mono text-[11px] text-fg">
            {String(getValue())}
          </span>
        ),
        size: 140,
      },
      {
        accessorKey: 'event_count',
        header: 'Events',
        cell: ({ getValue }) => (
          <span className="flex items-center gap-1 text-[12px] text-fg-secondary">
            <Hash size={10} className="text-fg-faint" />
            {String(getValue())}
          </span>
        ),
        size: 70,
      },
      {
        accessorKey: 'duration_seconds',
        header: 'Duration',
        cell: ({ getValue }) => (
          <span className="flex items-center gap-1 text-[12px] text-fg-secondary">
            <Clock size={10} className="text-fg-faint" />
            {formatDurationSeconds(getValue() as number | null)}
          </span>
        ),
        size: 90,
      },
      {
        accessorKey: 'start_activity',
        header: 'Start',
        cell: ({ getValue }) => (
          <span className="inline-block max-w-[110px] truncate rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
            {String(getValue())}
          </span>
        ),
        size: 130,
      },
      {
        accessorKey: 'end_activity',
        header: 'End',
        cell: ({ getValue }) => (
          <span className="inline-block max-w-[110px] truncate rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
            {String(getValue())}
          </span>
        ),
        size: 130,
      },
      {
        accessorKey: 'variant',
        header: 'Variant',
        cell: ({ getValue }) => (
          <span className="inline-block max-w-[120px] truncate text-[11px] text-fg-muted" title={String(getValue())}>
            {String(getValue())}
          </span>
        ),
      },
      {
        id: 'expand',
        header: '',
        cell: ({ row }) => (
          <ChevronRight
            size={13}
            className={clsx(
              'transition-transform text-fg-faint',
              selectedCaseId === (row.original as CaseInfo).case_id && 'rotate-90 text-accent',
            )}
          />
        ),
        size: 30,
        enableSorting: false,
      },
    ],
    [selectedCaseId],
  );

  if (!isOpen) return null;

  const bodyContent = (
    <>
      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2.5 text-[12px] text-danger">
          <AlertCircle size={14} />
          {error}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={22} className="animate-spin text-fg-muted" />
        </div>
      ) : cases.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-fg-faint">
          <Inbox size={24} />
          <p className="text-[12px]">No cases found</p>
        </div>
      ) : (
        <div
          className="[&_tr]:cursor-pointer"
          onClick={handleTableClick}
        >
          <DataTable
            data={cases}
            columns={columns}
            loading={false}
            searchable
            searchPlaceholder="Search cases..."
            paginated
            pageSize={20}
            emptyMessage="No cases found"
            emptyDescription="No cases match your search."
          />
        </div>
      )}
    </>
  );

  // Embedded mode: render inline (used as a tab in ProcessViewPage)
  if (embedded) {
    return (
      <div className="flex h-full gap-3">
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-2">
          <div className="flex-1 overflow-auto p-4">
            {bodyContent}
          </div>
        </div>
        {selectedCaseId && (
          <div className="w-80 shrink-0 overflow-hidden rounded-lg border border-line">
            <CaseDetailPanel
              eventLogId={eventLogId}
              caseId={selectedCaseId}
              onClose={() => setSelectedCaseId(null)}
            />
          </div>
        )}
      </div>
    );
  }

  // Slide-over mode (original)
  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end">
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div
        className={clsx(
          'relative z-50 flex h-full w-full max-w-5xl shadow-2xl',
          'animate-in slide-in-from-right duration-200',
        )}
      >
        <div className="flex flex-1 flex-col bg-surface-0">
          <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
            <div className="flex items-center gap-3">
              <h2 className="text-[14px] font-semibold text-fg">Case Explorer</h2>
              {!loading && (
                <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] text-fg-muted">
                  {totalCases.toLocaleString()} cases
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-tint hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {bodyContent}
          </div>
        </div>
        {selectedCaseId && (
          <div className="w-80 shrink-0">
            <CaseDetailPanel
              eventLogId={eventLogId}
              caseId={selectedCaseId}
              onClose={() => setSelectedCaseId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default CaseExplorer;
