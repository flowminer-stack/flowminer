import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  TrendingUp,
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronRight,
  Activity,
} from 'lucide-react';
import clsx from 'clsx';
import PageHeader from '@/components/common/PageHeader';
import FeatureGuide from '@/components/common/FeatureGuide';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Dot,
} from 'recharts';
import { useEventLogData } from '@/hooks/useProcessMining';
import { useDrift } from '@/hooks/useProcessMining';
import type { DriftPoint, DriftWindow } from '@/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function jsdSeverity(jsd: number): 'low' | 'medium' | 'high' {
  if (jsd < 0.15) return 'low';
  if (jsd < 0.3) return 'medium';
  return 'high';
}

const severityBadge: Record<string, string> = {
  low: 'badge-slate',
  medium: 'badge-amber',
  high: 'badge-rose',
};

const severityLabel: Record<string, string> = {
  low: 'Low',
  medium: 'Moderate',
  high: 'High',
};

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon,
  label,
  value,
  colorClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  colorClass: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className={clsx('rounded-md p-2', colorClass)}>
          <Icon size={18} className="opacity-80" />
        </div>
        <div>
          <p className="text-xl font-bold tabular-nums text-fg">{value}</p>
          <p className="text-[12px] text-fg-muted">{label}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Drift card ───────────────────────────────────────────────────────────────

function DriftCard({
  drift,
  window,
}: {
  drift: DriftPoint;
  window: DriftWindow | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const sev = jsdSeverity(drift.jsd);

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-4 p-4 text-left hover:bg-tint/50 transition-colors"
      >
        {/* Index bubble */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-fg-secondary">
          {drift.window_index}
        </div>

        {/* Date range */}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg truncate">
            {window
              ? `${formatTs(window.start)} — ${formatTs(window.end)}`
              : formatTs(drift.timestamp)}
          </p>
          <p className="mt-0.5 text-[11px] text-fg-muted">
            {window
              ? `${window.case_count} cases · ${window.variant_count} variants`
              : `Window ${drift.window_index}`}
          </p>
        </div>

        {/* JSD badge */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={clsx('badge', severityBadge[sev])}>
            {severityLabel[sev]}
          </span>
          <span className="text-[12px] font-mono font-semibold text-fg-secondary">
            JSD {drift.jsd.toFixed(3)}
          </span>
          {expanded ? (
            <ChevronDown size={14} className="text-fg-faint" />
          ) : (
            <ChevronRight size={14} className="text-fg-faint" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line px-4 pb-4 pt-3 space-y-3">
          {drift.added_edges.length > 0 && (
            <EdgeList
              title="New transitions (added)"
              edges={drift.added_edges}
              colorClass="text-success"
            />
          )}
          {drift.removed_edges.length > 0 && (
            <EdgeList
              title="Lost transitions (removed)"
              edges={drift.removed_edges}
              colorClass="text-danger"
            />
          )}
          {drift.magnitude_changes.length > 0 && (
            <div>
              <p className="mb-2 text-[12px] font-semibold text-fg-secondary uppercase tracking-wider">
                Frequency shifts
              </p>
              <div className="space-y-1.5">
                {drift.magnitude_changes.map((mc, i) => (
                  <MagnitudeRow key={i} change={mc} />
                ))}
              </div>
            </div>
          )}
          {drift.added_edges.length === 0 &&
            drift.removed_edges.length === 0 &&
            drift.magnitude_changes.length === 0 && (
              <p className="text-[12px] text-fg-faint italic">
                No structural detail available.
              </p>
            )}
        </div>
      )}
    </div>
  );
}

function EdgeList({
  title,
  edges,
  colorClass,
}: {
  title: string;
  edges: [string, string][];
  colorClass: string;
}) {
  return (
    <div>
      <p className="mb-2 text-[12px] font-semibold text-fg-secondary uppercase tracking-wider">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {edges.map((e, i) => (
          <span
            key={i}
            className={clsx(
              'inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-medium',
              colorClass,
            )}
          >
            {e[0]} &rarr; {e[1]}
          </span>
        ))}
      </div>
    </div>
  );
}

function MagnitudeRow({
  change,
}: {
  change: { edge: [string, string]; before: number; after: number; delta: number };
}) {
  const maxWidth = 100;
  const beforePct = Math.round(change.before * maxWidth * 10);
  const afterPct = Math.round(change.after * maxWidth * 10);
  const up = change.delta > 0;

  return (
    <div className="flex items-center gap-3 text-[11px]">
      <span className="w-44 shrink-0 truncate text-fg-secondary font-medium">
        {change.edge[0]} &rarr; {change.edge[1]}
      </span>
      <div className="flex flex-1 items-center gap-2">
        <div
          className="h-1.5 rounded-full bg-fg-ghost"
          style={{ width: `${beforePct}%`, minWidth: 2 }}
        />
        <span className="text-fg-faint">&rarr;</span>
        <div
          className={clsx(
            'h-1.5 rounded-full',
            up ? 'bg-warning' : 'bg-accent',
          )}
          style={{ width: `${afterPct}%`, minWidth: 2 }}
        />
      </div>
      <span
        className={clsx(
          'w-14 text-right font-mono font-semibold shrink-0',
          up ? 'text-warning' : 'text-accent',
        )}
      >
        {up ? '+' : ''}
        {(change.delta * 100).toFixed(1)}%
      </span>
    </div>
  );
}

// ─── JSD timeline chart ───────────────────────────────────────────────────────

interface ChartPoint {
  label: string;
  windowIndex: number;
  jsd: number;
}

function JsdTimeline({
  chartData,
  driftSet,
  sensitivity,
  onClickDrift,
}: {
  chartData: ChartPoint[];
  driftSet: Set<number>;
  sensitivity: number;
  onClickDrift: (idx: number) => void;
}) {
  const data = chartData;

  return (
    <div className="card mt-6 p-5">
      <h2 className="text-[14px] font-semibold text-fg">
        Jensen-Shannon Divergence per Window Transition
      </h2>
      <p className="mt-1 text-[12px] text-fg-muted">
        Red dot = drift point (JSD above threshold). Click to highlight.
      </p>
      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              fontSize={11}
              tick={{ fill: 'var(--chart-tick)' }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 1]}
              fontSize={11}
              tick={{ fill: 'var(--chart-tick)' }}
              tickFormatter={(v: number) => v.toFixed(2)}
            />
            <Tooltip
              formatter={(value: number) => [value.toFixed(4), 'JSD']}
              contentStyle={{
                borderRadius: 8,
                border: '1px solid var(--chart-tooltip-border)',
                fontSize: 12,
                backgroundColor: 'var(--chart-tooltip-bg)',
                color: 'var(--chart-tooltip-text)',
              }}
            />
            <ReferenceLine
              y={sensitivity}
              stroke="var(--color-danger, #f43f5e)"
              strokeDasharray="4 3"
              label={{
                value: `threshold ${sensitivity}`,
                position: 'right',
                fontSize: 10,
                fill: 'var(--color-danger, #f43f5e)',
              }}
            />
            <Line
              type="monotone"
              dataKey="jsd"
              stroke="var(--color-accent, #6366f1)"
              strokeWidth={2}
              dot={(props: { cx: number; cy: number; payload: { windowIndex: number } }) => {
                const { cx, cy, payload } = props;
                const isDrift = driftSet.has(payload.windowIndex);
                return (
                  <Dot
                    key={`dot-${payload.windowIndex}`}
                    cx={cx}
                    cy={cy}
                    r={isDrift ? 5 : 3}
                    fill={isDrift ? 'var(--color-danger, #f43f5e)' : 'var(--color-accent, #6366f1)'}
                    stroke="none"
                    onClick={() => isDrift && onClickDrift(payload.windowIndex)}
                    style={{ cursor: isDrift ? 'pointer' : 'default' }}
                  />
                );
              }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export default function DriftPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  const [windowParam, setWindowParam] = useState('auto');
  const [sensitivity, setSensitivity] = useState(0.15);
  const [pendingWindow, setPendingWindow] = useState('auto');
  const [pendingSensitivity, setPendingSensitivity] = useState(0.15);
  const [highlightedWindow, setHighlightedWindow] = useState<number | null>(null);

  const { data, loading, error, refetch } = useDrift(eventLogId, windowParam, sensitivity);

  const driftSet = useMemo(
    () => new Set((data?.drifts ?? []).map((d) => d.window_index)),
    [data],
  );

  // Build JSD lookup for chart
  const jsdByWindow = useMemo(() => {
    const m = new Map<number, number>();
    for (const d of data?.drifts ?? []) m.set(d.window_index, d.jsd);
    return m;
  }, [data]);

  // Enrich windows for the chart — we know JSD only for drift points; show 0
  // for non-drift transitions so the line is complete.
  const chartData = useMemo(
    () =>
      (data?.windows ?? []).slice(1).map((w, i) => ({
        label: formatTs(w.start),
        windowIndex: i + 1,
        jsd: jsdByWindow.get(i + 1) ?? 0,
      })),
    [data, jsdByWindow],
  );

  function applyParams() {
    setWindowParam(pendingWindow);
    setSensitivity(pendingSensitivity);
  }

  if (loading) {
    return <LoadingSpinner size="lg" text="Detecting concept drift..." fullPage />;
  }

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          refetch();
        }}
      />
    );
  }

  const summary = data?.summary;
  const windows = data?.windows ?? [];
  const drifts = data?.drifts ?? [];

  return (
    <div>
      <PageHeader
        title="Concept Drift"
        icon={TrendingUp}
        backTo={-1}
        description="Detect when the process behaviour shifts over time using Jensen-Shannon divergence on transition-frequency distributions."
        subtitle={
          <>
            {eventLog?.name ?? 'Event Log'} &mdash;{' '}
            {summary?.total_drifts ?? 0} drift
            {(summary?.total_drifts ?? 0) !== 1 ? 's' : ''} detected across{' '}
            {summary?.total_windows ?? 0} windows
          </>
        }
      />

      <FeatureGuide
        storageKey="drift"
        icon={TrendingUp}
        title="What concept-drift detection finds"
        lead="Processes change over time — a new system, policy or season shifts how work flows. Drift detection scans the log chronologically and flags the points where process behaviour measurably changed."
        steps={[
          { label: 'Spot the change points', detail: 'markers show when behaviour shifted' },
          { label: 'Compare before vs after', detail: 'see how the process differed across a drift point' },
          { label: 'Trace the cause', detail: 'line drift dates up with known operational changes' },
        ]}
      />

      {/* Parameters bar */}
      <div className="mt-6 flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface-1 p-4">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-1">
            Window
          </label>
          <div className="flex rounded-lg border border-line bg-surface-0 p-0.5 gap-0.5">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPendingWindow(opt.value)}
                className={clsx(
                  'rounded-md px-2.5 py-1 text-[11px] capitalize transition-all',
                  pendingWindow === opt.value
                    ? 'bg-surface-2 text-fg shadow-xs'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-[180px]">
          <label className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-1">
            <span>Sensitivity (JSD threshold)</span>
            <span className="font-mono font-normal normal-case text-fg-secondary">
              {pendingSensitivity.toFixed(2)}
            </span>
          </label>
          <input
            type="range"
            min={0.01}
            max={0.5}
            step={0.01}
            value={pendingSensitivity}
            onChange={(e) => setPendingSensitivity(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>

        <button
          type="button"
          onClick={applyParams}
          className="btn-primary text-[12px]"
        >
          Apply
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard
            icon={Activity}
            label="Windows"
            value={summary.total_windows}
            colorClass="bg-accent/10 text-accent"
          />
          <SummaryCard
            icon={AlertTriangle}
            label="Drift points"
            value={summary.total_drifts}
            colorClass="bg-danger/10 text-danger"
          />
          <SummaryCard
            icon={BarChart2}
            label="Avg JSD"
            value={summary.avg_jsd.toFixed(3)}
            colorClass="bg-warning/10 text-warning"
          />
          <SummaryCard
            icon={TrendingUp}
            label="Max JSD"
            value={summary.max_jsd.toFixed(3)}
            colorClass={summary.max_jsd >= 0.3 ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'}
          />
        </div>
      )}

      {/* JSD timeline */}
      {chartData.length > 0 && (
        <JsdTimeline
          chartData={chartData}
          driftSet={driftSet}
          sensitivity={sensitivity}
          onClickDrift={(idx) =>
            setHighlightedWindow(highlightedWindow === idx ? null : idx)
          }
        />
      )}

      {/* No data state */}
      {windows.length === 0 && !loading && (
        <div className="mt-10 text-center text-[14px] text-fg-muted">
          <p>No windows could be built. The log may be too small or lack timestamps.</p>
        </div>
      )}

      {/* Drift list */}
      {drifts.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[14px] font-semibold text-fg">
            Drift Points ({drifts.length})
          </h2>
          <p className="mt-1 text-[12px] text-fg-muted">
            Sorted by JSD descending — highest divergence first.
          </p>
          <div className="mt-4 space-y-3">
            {drifts.map((drift) => (
              <div
                key={drift.window_index}
                id={`drift-${drift.window_index}`}
                className={clsx(
                  'transition-all duration-200',
                  highlightedWindow === drift.window_index && 'ring-2 ring-accent rounded-xl',
                )}
              >
                <DriftCard
                  drift={drift}
                  window={windows[drift.window_index]}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No drifts state */}
      {drifts.length === 0 && windows.length > 1 && !loading && (
        <div className="mt-10 rounded-xl border border-line bg-surface-1 p-8 text-center">
          <Activity size={32} className="mx-auto text-fg-faint mb-3" />
          <p className="text-[14px] font-medium text-fg">No drift detected</p>
          <p className="mt-1 text-[12px] text-fg-muted">
            All window transitions are below the JSD threshold of{' '}
            <span className="font-mono">{sensitivity.toFixed(2)}</span>. Lower the sensitivity
            to surface subtle shifts.
          </p>
        </div>
      )}
    </div>
  );
}
