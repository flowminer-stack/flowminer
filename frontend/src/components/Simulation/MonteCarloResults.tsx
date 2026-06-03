import { TrendingDown, TrendingUp } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import clsx from 'clsx';
import DataTable from '@/components/common/DataTable';
import ActivityCostTable from '@/components/Simulation/ActivityCostTable';
import { formatDuration } from '@/utils/format';
import { formatPct } from './format';
import type { SimulationResponse } from '@/types';

// ─── Activity comparison table row type ──────────────────────────────────────

interface ActivityRow {
  name: string;
  originalFreq: number;
  simulatedFreq: number;
  originalDuration: number;
  simulatedDuration: number;
  removed: boolean;
}

interface MonteCarloResultsProps {
  result: SimulationResponse;
  eventLogId: string;
}

export default function MonteCarloResults({ result, eventLogId }: MonteCarloResultsProps) {
  // Build activity table rows
  const activityRows: ActivityRow[] = (() => {
    const origMap = new Map(result.original.activities.map((a) => [a.name, a]));
    const simMap = new Map(result.simulated.activities.map((a) => [a.name, a]));
    const removed = new Set(result.improvement.activities_removed);
    const allNames = new Set([...origMap.keys(), ...simMap.keys()]);
    return [...allNames].map((name) => ({
      name,
      originalFreq: origMap.get(name)?.frequency ?? 0,
      simulatedFreq: simMap.get(name)?.frequency ?? 0,
      originalDuration: origMap.get(name)?.avg_duration ?? 0,
      simulatedDuration: simMap.get(name)?.avg_duration ?? 0,
      removed: removed.has(name),
    }));
  })();

  const activityColumns: ColumnDef<ActivityRow, unknown>[] = [
    {
      accessorKey: 'name',
      header: 'Activity',
      cell: ({ row }) => (
        <span className={clsx('text-[12px]', row.original.removed ? 'line-through text-fg-faint' : 'text-fg-secondary')}>
          {row.original.name}
          {row.original.removed && (
            <span className="ml-1.5 rounded bg-danger/10 px-1 py-0.5 text-[9px] font-medium text-danger">
              removed
            </span>
          )}
        </span>
      ),
    },
    {
      accessorKey: 'originalFreq',
      header: 'Orig. Freq',
      cell: ({ getValue }) => (
        <span className="text-[12px] tabular-nums text-fg-secondary">{(getValue() as number).toLocaleString()}</span>
      ),
    },
    {
      accessorKey: 'simulatedFreq',
      header: 'Sim. Freq',
      cell: ({ row }) => {
        const diff = row.original.simulatedFreq - row.original.originalFreq;
        return (
          <span className={clsx('text-[12px] tabular-nums font-medium', diff < 0 ? 'text-success' : diff > 0 ? 'text-danger' : 'text-fg-secondary')}>
            {row.original.simulatedFreq.toLocaleString()}
          </span>
        );
      },
    },
    {
      id: 'freqChange',
      header: 'Change',
      cell: ({ row }) => {
        const orig = row.original.originalFreq;
        const sim = row.original.simulatedFreq;
        if (orig === 0) return <span className="text-[11px] text-fg-faint">—</span>;
        const pct = ((sim - orig) / orig) * 100;
        const improved = pct <= 0;
        return (
          <span className={clsx('text-[11px] font-semibold tabular-nums', improved ? 'text-success' : 'text-danger')}>
            {formatPct(pct)}
          </span>
        );
      },
    },
  ];

  // ── Improvement banner ───────────────────────────────────────────────────────

  const durationChange = result.improvement.avg_duration_change_pct ?? 0;
  const isImprovement = durationChange < 0;

  return (
    <>
      {/* Improvement banner */}
      <div
        className={clsx(
          'flex items-center gap-4 rounded-xl border px-5 py-4',
          isImprovement
            ? 'border-success/25 bg-success/8'
            : 'border-danger/25 bg-danger/8',
        )}
      >
        <div className={clsx('rounded-xl p-3', isImprovement ? 'bg-success/15' : 'bg-danger/15')}>
          {isImprovement
            ? <TrendingDown size={22} className="text-success" />
            : <TrendingUp size={22} className="text-danger" />}
        </div>
        <div className="flex-1">
          <p
            className={clsx(
              'text-[28px] font-black leading-none tabular-nums',
              isImprovement ? 'text-success' : 'text-danger',
            )}
          >
            {formatPct(durationChange)}
          </p>
          <p className="mt-0.5 text-[12px] font-medium text-fg-secondary">avg case duration</p>
        </div>
        <div className="text-right">
          <p className="text-[13px] font-semibold text-fg">
            {result.improvement.case_count_change >= 0 ? '+' : ''}
            {result.improvement.case_count_change.toLocaleString()} cases
          </p>
          {result.improvement.activities_removed.length > 0 && (
            <p className="mt-0.5 text-[11px] text-fg-muted">
              {result.improvement.activities_removed.length} activit
              {result.improvement.activities_removed.length > 1 ? 'ies' : 'y'} removed
            </p>
          )}
        </div>
      </div>

      {/* Side-by-side stats */}
      <div className="grid grid-cols-2 gap-3">
        {/* Original */}
        <div className="card p-3.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Original
          </p>
          <div className="space-y-0.5">
            {[
              { label: 'Total Cases', value: result.original.total_cases.toLocaleString() },
              { label: 'Total Events', value: result.original.total_events.toLocaleString() },
              { label: 'Avg Duration', value: formatDuration(result.original.avg_case_duration) },
              { label: 'Median Duration', value: formatDuration(result.original.median_case_duration) },
              { label: 'Events / Case', value: result.original.avg_events_per_case.toFixed(1) },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-1">
                <span className="text-[11px] text-fg-muted">{row.label}</span>
                <span className="text-[11px] font-semibold tabular-nums text-fg-secondary">{row.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Simulated */}
        <div className="card p-3.5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Simulated
          </p>
          <div className="space-y-0.5">
            {([
              {
                label: 'Total Cases',
                orig: result.original.total_cases,
                sim: result.simulated.total_cases,
                fmt: (v: number) => v.toLocaleString(),
                lowerIsBetter: false,
              },
              {
                label: 'Total Events',
                orig: result.original.total_events,
                sim: result.simulated.total_events,
                fmt: (v: number) => v.toLocaleString(),
                lowerIsBetter: true,
              },
              {
                label: 'Avg Duration',
                orig: result.original.avg_case_duration,
                sim: result.simulated.avg_case_duration,
                fmt: formatDuration,
                lowerIsBetter: true,
              },
              {
                label: 'Median Duration',
                orig: result.original.median_case_duration,
                sim: result.simulated.median_case_duration,
                fmt: formatDuration,
                lowerIsBetter: true,
              },
              {
                label: 'Events / Case',
                orig: result.original.avg_events_per_case,
                sim: result.simulated.avg_events_per_case,
                fmt: (v: number) => v.toFixed(1),
                lowerIsBetter: true,
              },
            ] as const).map((row) => {
              const improved = row.lowerIsBetter ? row.sim < row.orig : row.sim > row.orig;
              const neutral = row.sim === row.orig;
              return (
                <div key={row.label} className="flex items-center justify-between py-1">
                  <span className="text-[11px] text-fg-muted">{row.label}</span>
                  <span
                    className={clsx(
                      'text-[11px] font-semibold tabular-nums',
                      neutral ? 'text-fg-secondary' : improved ? 'text-success' : 'text-danger',
                    )}
                  >
                    {row.fmt(row.sim)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Comparison stats bar chart (inline bar) */}
      <div className="card p-3.5">
        <p className="mb-3 text-[12px] font-semibold text-fg">Metric Comparison</p>
        <div className="space-y-2.5">
          {[
            {
              label: 'Avg Duration',
              orig: result.original.avg_case_duration,
              sim: result.simulated.avg_case_duration,
              fmt: formatDuration,
              lowerIsBetter: true,
            },
            {
              label: 'Median Duration',
              orig: result.original.median_case_duration,
              sim: result.simulated.median_case_duration,
              fmt: formatDuration,
              lowerIsBetter: true,
            },
            {
              label: 'Events / Case',
              orig: result.original.avg_events_per_case,
              sim: result.simulated.avg_events_per_case,
              fmt: (v: number) => v.toFixed(1),
              lowerIsBetter: true,
            },
          ].map((row) => {
            const max = Math.max(row.orig, row.sim) || 1;
            const origPct = (row.orig / max) * 100;
            const simPct = (row.sim / max) * 100;
            const improved = row.lowerIsBetter ? row.sim < row.orig : row.sim > row.orig;
            return (
              <div key={row.label}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] text-fg-muted">{row.label}</span>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-fg-faint">{row.fmt(row.orig)}</span>
                    <span className={clsx('font-semibold', improved ? 'text-success' : 'text-danger')}>
                      {row.fmt(row.sim)}
                    </span>
                  </div>
                </div>
                <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-l-full bg-fg-faint/30 transition-all"
                    style={{ width: `${origPct}%` }}
                  />
                </div>
                <div className="mt-0.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={clsx(
                      'h-full rounded-l-full transition-all',
                      improved ? 'bg-success/50' : 'bg-danger/50',
                    )}
                    style={{ width: `${simPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Activity comparison table */}
      {activityRows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="border-b border-line px-4 py-2.5">
            <h3 className="text-[12px] font-semibold text-fg">Activity Breakdown</h3>
          </div>
          <DataTable
            data={activityRows}
            columns={activityColumns}
            searchable
            searchPlaceholder="Search activities…"
            paginated
            pageSize={10}
            emptyMessage="No activity data"
          />
        </div>
      )}

      {/* IBM Process Mining-style editable cost table. Lets
          users price every activity by hourly rate and
          automation %, projecting total savings live. */}
      {eventLogId && <ActivityCostTable eventLogId={eventLogId} />}
    </>
  );
}
