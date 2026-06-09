import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  GripVertical,
  Settings,
  Trash2,
  BarChart3,
  LineChart,
  PieChart,
  Activity,
  Hash,
  Table2,
  Gauge,
  GitBranch,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import KPICard from './KPICard';
import ProcessChart from './ProcessChart';
import { mining } from '@/api/client';
import { formatDuration } from '@/utils/format';
import type {
  BottleneckResponse,
  VariantResponse,
  ConformanceResponse,
  ProcessStatistics,
  TimelineResponse,
} from '@/types';
import { confirmDialog } from '@/components/common/ConfirmDialog';

interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  config: Record<string, any>;
  position: { x: number; y: number; w: number; h: number };
}

interface WidgetGridProps {
  widgets: WidgetConfig[];
  onWidgetUpdate: (widget: WidgetConfig) => void;
  onWidgetDelete: (widgetId: string) => void;
  editable: boolean;
  // Optional: when the user drags-and-drops widget A onto widget B,
  // we call this with the new ordering. If omitted, drag-drop is
  // simply disabled (keeps the component backwards-compatible).
  onWidgetsReorder?: (widgets: WidgetConfig[]) => void;
}

const widgetIconMap: Record<string, React.ReactNode> = {
  kpi: <Hash className="w-4 h-4" />,
  line_chart: <LineChart className="w-4 h-4" />,
  bar_chart: <BarChart3 className="w-4 h-4" />,
  area_chart: <Activity className="w-4 h-4" />,
  pie_chart: <PieChart className="w-4 h-4" />,
  process_map: <Activity className="w-4 h-4" />,
  variant_list: <GitBranch className="w-4 h-4" />,
  bottleneck_table: <Table2 className="w-4 h-4" />,
  conformance_gauge: <Gauge className="w-4 h-4" />,
};

/* ── Shared loading / error / empty shells ───────────────────────────────── */

const CenteredMessage: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'danger' }> = ({
  children,
  tone = 'muted',
}) => (
  <div className="flex h-full items-center justify-center p-4">
    <p className={clsx('text-[12px]', tone === 'danger' ? 'text-danger' : 'text-fg-muted')}>
      {children}
    </p>
  </div>
);

const WidgetLoading: React.FC = () => (
  <div className="flex h-full items-center justify-center gap-2 text-fg-faint">
    <Loader2 className="h-3.5 w-3.5 animate-spin" />
    <span className="text-[11px]">Loading…</span>
  </div>
);

const WidgetError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
    <AlertCircle className="h-5 w-5 text-danger" />
    <p className="text-[11px] text-fg-muted">{message}</p>
    <button
      onClick={onRetry}
      className="text-[11px] font-semibold text-accent transition-colors hover:text-accent-hover"
    >
      Retry
    </button>
  </div>
);

/* ── Data fetching hook ──────────────────────────────────────────────────── */

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useWidgetData<T>(
  eventLogId: string | undefined,
  fetcher: (id: string) => Promise<T>,
): FetchState<T> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<T>>({
    data: null,
    loading: false,
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!eventLogId) {
      setState({ data: null, loading: false, error: 'No event log selected' });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher(eventLogId)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          const msg =
            (err?.response?.data?.detail as string | undefined) ||
            (err instanceof Error ? err.message : 'Failed to load');
          setState({ data: null, loading: false, error: msg });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventLogId, tick]);

  return { ...state, refetch: () => setTick((t) => t + 1) };
}

/* ── Individual widgets ──────────────────────────────────────────────────── */

const BottleneckTableWidget: React.FC<{ eventLogId: string }> = ({ eventLogId }) => {
  const { data, loading, error, refetch } = useWidgetData<BottleneckResponse>(
    eventLogId,
    mining.getBottlenecks,
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;
  const rows = data?.bottlenecks ?? [];
  if (rows.length === 0) return <CenteredMessage>No bottleneck data</CenteredMessage>;

  return (
    <div className="h-full overflow-auto p-3">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2">
          <tr className="border-b border-line">
            <th className="py-2 px-2 text-left font-medium text-fg-muted">Activity</th>
            <th className="py-2 px-2 text-right font-medium text-fg-muted">Avg Duration</th>
            <th className="py-2 px-2 text-right font-medium text-fg-muted">Severity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={i} className="border-b border-line/60">
              <td className="py-2 px-2 text-fg-secondary font-medium truncate max-w-[180px]">
                {b.activity}
              </td>
              <td className="py-2 px-2 text-right text-fg-muted tabular-nums">
                {formatDuration(b.avg_duration)}
              </td>
              <td className="py-2 px-2 text-right">
                <span
                  className={clsx(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize',
                    b.severity === 'critical' || b.severity === 'high'
                      ? 'bg-danger/10 text-danger'
                      : b.severity === 'medium'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-success/10 text-success',
                  )}
                >
                  {b.severity}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const VariantListWidget: React.FC<{ eventLogId: string }> = ({ eventLogId }) => {
  const { data, loading, error, refetch } = useWidgetData<VariantResponse>(
    eventLogId,
    mining.getVariants,
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;
  const variants = data?.variants ?? [];
  if (variants.length === 0) return <CenteredMessage>No variant data</CenteredMessage>;

  return (
    <div className="h-full space-y-2 overflow-y-auto p-3">
      {variants.slice(0, 5).map((v, i) => (
        <div key={v.id ?? i} className="flex items-center justify-between gap-2 rounded-lg bg-tint px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-bold text-fg-faint">#{i + 1}</span>
            <span className="truncate text-[12px] text-fg-secondary">
              {v.activities.join(' → ')}
            </span>
          </div>
          <span className="flex-shrink-0 text-xs font-semibold text-fg-muted tabular-nums">
            {v.frequency.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
};

const ConformanceGaugeWidget: React.FC<{ eventLogId: string }> = ({ eventLogId }) => {
  const { data, loading, error, refetch } = useWidgetData<ConformanceResponse>(
    eventLogId,
    (id) => mining.getConformance(id),
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;

  const fitness = data?.fitness ?? 0;
  const precision = data?.precision ?? 0;
  const fitnessPercent = Math.round(fitness * 100);
  const precisionPercent = Math.round((precision ?? 0) * 100);

  return (
    <div className="flex h-full items-center justify-center gap-8 p-4">
      <GaugeDial label="Fitness" percent={fitnessPercent} />
      <GaugeDial label="Precision" percent={data?.precision == null ? null : precisionPercent} />
    </div>
  );
};

const GaugeDial: React.FC<{ label: string; percent: number | null }> = ({ label, percent }) => {
  const value = percent ?? 0;
  const stroke =
    percent == null
      ? 'rgb(var(--c-fgg))'
      : value >= 80
        ? 'rgb(var(--c-success))'
        : value >= 60
          ? 'rgb(var(--c-warning))'
          : 'rgb(var(--c-danger))';

  return (
    <div className="text-center">
      <div className="relative h-24 w-24">
        <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke="var(--chart-grid)"
            strokeWidth="10"
          />
          {percent != null && (
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke={stroke}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${value * 2.51} 251`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold text-fg">
            {percent == null ? 'N/A' : `${value}%`}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[12px] font-medium text-fg-muted">{label}</p>
    </div>
  );
};

type ChartWidgetKind = 'line' | 'bar' | 'area' | 'pie';

const StatisticsChartWidget: React.FC<{
  eventLogId: string;
  kind: ChartWidgetKind;
  config: Record<string, any>;
}> = ({ eventLogId, kind, config }) => {
  const { data, loading, error, refetch } = useWidgetData<ProcessStatistics>(
    eventLogId,
    mining.getStatistics,
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;
  if (!data) return <CenteredMessage>No statistics available</CenteredMessage>;

  // Activity frequencies are a universally useful dataset for bar/pie/line/area.
  const chartData = (data.activity_frequencies ?? [])
    .slice(0, 10)
    .map((a) => ({ name: truncate(a.activity, 14), value: a.frequency }));

  if (chartData.length === 0) {
    return <CenteredMessage>No activity data</CenteredMessage>;
  }

  return (
    <div className="h-full w-full p-2">
      <ProcessChart
        type={kind}
        data={chartData}
        dataKey="value"
        xAxisKey="name"
        title={config.chartTitle}
        color={config.color}
        seriesName="Events"
        xAxisLabel="Activity"
        yAxisLabel="Event count"
        subtitle="Top 10 activities by event frequency"
      />
    </div>
  );
};

const LineChartWidget: React.FC<{ eventLogId: string; config: Record<string, any> }> = ({
  eventLogId,
  config,
}) => {
  const { data, loading, error, refetch } = useWidgetData<TimelineResponse>(
    eventLogId,
    mining.getTimeline,
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;
  if (!data || data.events.length === 0) {
    return <CenteredMessage>No timeline data</CenteredMessage>;
  }

  // Bucket events by day for an events-per-day time series.
  const buckets = new Map<string, number>();
  for (const e of data.events) {
    const day = e.timestamp.slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  const chartData = Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, count]) => ({ name: day.slice(5), value: count }));

  // Human-readable date range for the subtitle — lets users see at
  // a glance which slice of the log is in view without staring at
  // the x-axis ticks.
  const first = chartData[0]?.name;
  const last = chartData[chartData.length - 1]?.name;
  const subtitle = first && last && first !== last
    ? `Events per day · ${chartData.length} days (${first} → ${last})`
    : `Events per day · ${chartData.length} ${chartData.length === 1 ? 'day' : 'days'}`;

  return (
    <div className="h-full w-full p-2">
      <ProcessChart
        type="line"
        data={chartData}
        dataKey="value"
        xAxisKey="name"
        title={config.chartTitle}
        color={config.color}
        seriesName="Events"
        xAxisLabel="Day (MM-DD)"
        yAxisLabel="Events"
        subtitle={subtitle}
      />
    </div>
  );
};

const KPIWidget: React.FC<{ eventLogId: string; config: Record<string, any>; title: string }> = ({
  eventLogId,
  config,
  title,
}) => {
  const { data, loading, error, refetch } = useWidgetData<ProcessStatistics>(
    eventLogId,
    mining.getStatistics,
  );

  if (loading) return <WidgetLoading />;
  if (error) return <WidgetError message={error} onRetry={refetch} />;

  const metric: string = config.metric || 'total_cases';
  let value: string | number = '—';
  let unit: string | undefined = config.unit;
  let currentNumeric: number | undefined;
  if (data) {
    switch (metric) {
      case 'total_cases':
        value = data.total_cases.toLocaleString();
        currentNumeric = data.total_cases;
        break;
      case 'total_events':
        value = data.total_events.toLocaleString();
        currentNumeric = data.total_events;
        break;
      case 'total_activities':
        value = data.total_activities;
        currentNumeric = data.total_activities;
        break;
      case 'avg_case_duration':
        value = formatDuration(data.avg_case_duration);
        unit = undefined;
        currentNumeric = data.avg_case_duration;
        break;
      case 'median_case_duration':
        value = formatDuration(data.median_case_duration);
        unit = undefined;
        currentNumeric = data.median_case_duration;
        break;
      case 'avg_events_per_case':
        value = data.avg_events_per_case.toFixed(1);
        currentNumeric = data.avg_events_per_case;
        break;
      default:
        value = '—';
    }
  }

  // Duration metrics are "lower is better" (faster = good). Defaults vary
  // per-metric; config overrides.
  const durationMetrics = new Set(['avg_case_duration', 'median_case_duration']);
  const lowerIsBetter =
    config.lowerIsBetter ?? durationMetrics.has(metric);

  return (
    <KPICard
      title={config.title || title}
      value={value}
      unit={unit}
      change={config.change}
      changeLabel={config.changeLabel}
      icon={config.icon}
      color={config.color || 'indigo'}
      currentNumeric={currentNumeric}
      target={typeof config.target === 'number' ? config.target : undefined}
      bestInClass={typeof config.bestInClass === 'number' ? config.bestInClass : undefined}
      lowerIsBetter={lowerIsBetter}
    />
  );
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ── Dispatcher ──────────────────────────────────────────────────────────── */

const WidgetContent: React.FC<{ widget: WidgetConfig }> = ({ widget }) => {
  const eventLogId: string | undefined = widget.config?.eventLogId;

  if (!eventLogId && widget.type !== 'process_map') {
    return (
      <CenteredMessage tone="muted">
        This widget has no event log bound. Open its settings to pick one.
      </CenteredMessage>
    );
  }

  switch (widget.type) {
    case 'kpi':
      return <KPIWidget eventLogId={eventLogId!} config={widget.config} title={widget.title} />;
    case 'line_chart':
      return <LineChartWidget eventLogId={eventLogId!} config={widget.config} />;
    case 'bar_chart':
      return <StatisticsChartWidget eventLogId={eventLogId!} kind="bar" config={widget.config} />;
    case 'area_chart':
      return <StatisticsChartWidget eventLogId={eventLogId!} kind="area" config={widget.config} />;
    case 'pie_chart':
      return <StatisticsChartWidget eventLogId={eventLogId!} kind="pie" config={widget.config} />;
    case 'bottleneck_table':
      return <BottleneckTableWidget eventLogId={eventLogId!} />;
    case 'variant_list':
      return <VariantListWidget eventLogId={eventLogId!} />;
    case 'conformance_gauge':
      return <ConformanceGaugeWidget eventLogId={eventLogId!} />;
    case 'process_map':
      return (
        <div className="flex h-full items-center justify-center rounded-lg bg-tint">
          <div className="text-center">
            <Activity className="mx-auto mb-2 h-8 w-8 text-fg-ghost" />
            <p className="text-[12px] text-fg-muted">Process Map Widget</p>
            <p className="mt-0.5 text-[11px] text-fg-faint">Embedded mini process map</p>
          </div>
        </div>
      );
    default:
      return <CenteredMessage>Unknown widget type: {widget.type}</CenteredMessage>;
  }
};

/* ── Grid ────────────────────────────────────────────────────────────────── */

const WidgetGrid: React.FC<WidgetGridProps> = ({
  widgets,
  onWidgetUpdate,
  onWidgetDelete,
  editable,
  onWidgetsReorder,
}) => {
  // Native HTML5 drag-and-drop reorder (Celonis Studio polish). When
  // editable + onWidgetsReorder is wired, users can grab a widget by
  // its header handle and drop it onto another widget to swap their
  // grid positions. No library — keeps the bundle lean.
  const [dragId, setDragId] = React.useState<string | null>(null);

  const handleDragStart = (id: string) => (e: React.DragEvent) => {
    if (!editable || !onWidgetsReorder) return;
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!editable || !onWidgetsReorder || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId || dragId === targetId || !onWidgetsReorder) return;
    const src = widgets.find((w) => w.id === dragId);
    const tgt = widgets.find((w) => w.id === targetId);
    if (!src || !tgt) return;
    // Swap x/y positions (keep width/height). Fires a parent update.
    const next = widgets.map((w) => {
      if (w.id === src.id)
        return { ...w, position: { ...w.position, x: tgt.position.x, y: tgt.position.y } };
      if (w.id === tgt.id)
        return { ...w, position: { ...w.position, x: src.position.x, y: src.position.y } };
      return w;
    });
    onWidgetsReorder(next);
    setDragId(null);
  };

  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: 'repeat(12, 1fr)',
        gridAutoRows: '80px',
      }}
    >
      {widgets.map((widget) => (
        <div
          key={widget.id}
          onDragOver={handleDragOver}
          onDrop={handleDrop(widget.id)}
          className={clsx(
            'group overflow-hidden rounded-xl border border-line bg-surface-2',
            'transition-colors duration-200 hover:border-line-strong',
            dragId === widget.id && 'opacity-50',
            dragId && dragId !== widget.id && 'outline-2 outline-dashed outline-accent/0 hover:outline-accent/60',
          )}
          style={{
            gridColumn: `${widget.position.x + 1} / span ${widget.position.w}`,
            gridRow: `${widget.position.y + 1} / span ${widget.position.h}`,
          }}
        >
          {/* Widget header */}
          <div
            className="flex items-center justify-between border-b border-line bg-surface-1/50 px-3 py-2"
            draggable={editable && !!onWidgetsReorder}
            onDragStart={handleDragStart(widget.id)}
            onDragEnd={() => setDragId(null)}
          >
            <div className="flex min-w-0 items-center gap-2">
              {editable && (
                <div className="cursor-grab text-fg-ghost transition-colors hover:text-fg-muted">
                  <GripVertical className="h-4 w-4" />
                </div>
              )}
              <span className="text-fg-faint">{widgetIconMap[widget.type]}</span>
              <span className="truncate text-[12px] font-medium text-fg-muted">
                {widget.title}
              </span>
            </div>
            <div className="flex flex-shrink-0 items-center gap-0.5">
              <button
                onClick={() => onWidgetUpdate(widget)}
                className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
                title="Widget settings"
                aria-label="Widget settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={async () => {
                  const ok = await confirmDialog({ title: `Delete widget "${widget.title}"?`, message: 'This widget will be permanently removed from the dashboard.', confirmLabel: 'Delete widget', danger: true });
                  if (ok) onWidgetDelete(widget.id);
                }}
                className="rounded p-1 text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger"
                title="Delete widget"
                aria-label="Delete widget"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Widget content */}
          <div className="h-[calc(100%-37px)] w-full">
            <WidgetContent widget={widget} />
          </div>
        </div>
      ))}

      {widgets.length === 0 && (
        <div className="col-span-12 row-span-3 flex items-center justify-center rounded-xl border-2 border-dashed border-line">
          <div className="text-center">
            <BarChart3 className="mx-auto mb-3 h-10 w-10 text-fg-ghost" />
            <p className="text-sm font-medium text-fg-muted">No widgets yet</p>
            <p className="mt-1 text-[12px] text-fg-faint">Click "Add Widget" to get started</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default WidgetGrid;
