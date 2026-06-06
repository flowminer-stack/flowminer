/**
 * Shared inline chart renderers used by both the floating AI chat
 * panel and the AnalysisHub Ask panel. Each renderer takes a typed
 * `render` envelope from the backend chat-tool result and draws a
 * small recharts widget.
 *
 * The optional `eventLogId` prop enables "See full view →" links
 * that navigate the user to the dedicated analysis page.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wrench, ExternalLink, Filter as FilterIcon } from 'lucide-react';
import type {
  ChatToolRender,
  ChatToolResultEvent,
} from '@/api/client';
import { useFilterStore } from '@/store/filterStore';
import { formatDuration } from '@/utils/format';
import {
  BarChart as RBarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  CartesianGrid,
  Legend,
} from 'recharts';
import clsx from 'clsx';

// ── Helpers ───────────────────────────────────────────────────────────

/** Map a chat-tool name to the route the user should visit for
 *  the full-page version of that analysis. */
function fullViewRoute(toolName: string, eventLogId?: string): string | null {
  if (!eventLogId) return null;
  const routes: Record<string, string> = {
    show_bottlenecks: `/bottlenecks/${eventLogId}`,
    show_rework: `/rework/${eventLogId}`,
    show_variants: `/variants/${eventLogId}`,
    show_events_over_time: `/process/${eventLogId}?tab=analysis&analysis=perf-spectrum`,
    get_summary: `/process/${eventLogId}`,
  };
  return routes[toolName] ?? null;
}

// ── Chart renderers ──────────────────────────────────────────────────

export function BarChartRender({
  render,
  toolName,
  eventLogId,
}: {
  render: Extract<ChatToolRender, { type: 'bar_chart' }>;
  toolName?: string;
  eventLogId?: string;
}) {
  const isHorizontal = render.orientation === 'horizontal';
  const format = render.y_formatter;
  const tickFormatter = (v: number) =>
    format === 'duration_seconds'
      ? formatDuration(v)
      : format === 'percent'
        ? `${v}%`
        : String(v);
  const data = render.data.slice(0, 8);
  const truncLabel = (s: string) => (s.length > 28 ? s.slice(0, 25) + '…' : s);
  const route = fullViewRoute(toolName ?? '', eventLogId);

  return (
    <div className="mt-2 rounded-md border border-line bg-surface-1 p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {render.title}
        </p>
        {route && (
          <Link
            to={route}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Full view <ExternalLink size={9} />
          </Link>
        )}
      </div>
      <div style={{ width: '100%', height: Math.max(160, data.length * 36) }}>
        <ResponsiveContainer>
          <RBarChart
            data={data}
            layout={isHorizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 4, right: 12, bottom: 4, left: isHorizontal ? 4 : 4 }}
          >
            <CartesianGrid strokeDasharray="2 2" stroke="var(--line)" vertical={false} />
            {isHorizontal ? (
              <>
                <XAxis
                  type="number"
                  tickFormatter={tickFormatter}
                  tick={{ fill: 'var(--fg-muted)', fontSize: 10 }}
                />
                <YAxis
                  dataKey={render.x_key}
                  type="category"
                  width={120}
                  tickFormatter={(v: string) => truncLabel(v)}
                  tick={{ fill: 'var(--fg-muted)', fontSize: 9 }}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey={render.x_key}
                  tickFormatter={(v: string) => truncLabel(v)}
                  tick={{ fill: 'var(--fg-muted)', fontSize: 9 }}
                  interval={0}
                  angle={data.length > 3 ? -35 : 0}
                  textAnchor={data.length > 3 ? 'end' : 'middle'}
                  height={data.length > 3 ? 60 : 30}
                />
                <YAxis
                  tickFormatter={tickFormatter}
                  tick={{ fill: 'var(--fg-muted)', fontSize: 10 }}
                  width={45}
                />
              </>
            )}
            <Tooltip
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                fontSize: 11,
              }}
              formatter={(v: number) => [tickFormatter(v), render.y_label || 'Value']}
              labelFormatter={(l: string) => l}
            />
            <Bar dataKey={render.y_key} fill="var(--accent)" radius={[2, 2, 0, 0]} />
          </RBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function LineChartRender({
  render,
  toolName,
  eventLogId,
}: {
  render: Extract<ChatToolRender, { type: 'line_chart' }>;
  toolName?: string;
  eventLogId?: string;
}) {
  const route = fullViewRoute(toolName ?? '', eventLogId);
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-1 p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {render.title}
        </p>
        {route && (
          <Link
            to={route}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Full view <ExternalLink size={9} />
          </Link>
        )}
      </div>
      <div style={{ width: '100%', height: 160 }}>
        <ResponsiveContainer>
          <RLineChart data={render.data} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="2 2" stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey={render.x_key}
              tick={{ fill: 'var(--fg-muted)', fontSize: 10 }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fill: 'var(--fg-muted)', fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                fontSize: 11,
              }}
            />
            <Line
              type="monotone"
              dataKey={render.y_key}
              stroke="var(--accent)"
              strokeWidth={1.5}
              dot={false}
            />
          </RLineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function MetricCardRender({
  render,
  toolName,
  eventLogId,
}: {
  render: Extract<ChatToolRender, { type: 'metric_card' }>;
  toolName?: string;
  eventLogId?: string;
}) {
  const route = fullViewRoute(toolName ?? '', eventLogId);
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-1 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {render.title}
        </p>
        {route && (
          <Link
            to={route}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Full view <ExternalLink size={9} />
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {render.metrics.map((m) => (
          <div key={m.label} className="rounded bg-surface-2 px-2 py-1.5">
            <p className="text-[10px] text-fg-faint">{m.label}</p>
            <p className="text-[13px] font-semibold text-fg">{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FilterProposalRender({
  render,
}: {
  render: Extract<ChatToolRender, { type: 'filter_proposal' }>;
}) {
  const addChip = useFilterStore((s) => s.addChip);
  const [applied, setApplied] = useState(false);
  const applyAll = () => {
    render.chips.forEach((c) => {
      addChip({
        type: c.type as never,
        label: c.label,
        payload: c.payload,
      });
    });
    setApplied(true);
  };
  return (
    <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 p-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">
          {render.title}
        </p>
        <button
          type="button"
          onClick={applyAll}
          disabled={applied || render.chips.length === 0}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          <FilterIcon size={10} />
          {applied ? 'Applied' : 'Apply to page'}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {render.chips.map((c, i) => (
          <span
            key={`${c.label}-${i}`}
            className="rounded-full border border-line bg-surface-1 px-2 py-0.5 text-[10px] text-fg-secondary"
          >
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ConformanceChartRender({
  render,
  eventLogId,
}: {
  render: Extract<ChatToolRender, { type: 'conformance_chart' }>;
  eventLogId?: string;
}) {
  const route = eventLogId ? `/conformance/${eventLogId}` : null;
  const fitness = render.stochastic_fitness;
  const emd = render.emd_distance;
  const fitnessLabel = `${(fitness * 100).toFixed(1)}%`;
  const fitnessColor =
    fitness >= 0.9
      ? 'text-success'
      : fitness >= 0.7
        ? 'text-warning'
        : 'text-danger';

  return (
    <div className="mt-2 rounded-md border border-line bg-surface-1 p-2">
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {render.title}
        </p>
        {route && (
          <Link
            to={route}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Full view <ExternalLink size={9} />
          </Link>
        )}
      </div>

      {/* Headline scores */}
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <div className="rounded bg-surface-2 px-2 py-1.5 text-center">
          <p className={clsx('text-[13px] font-bold tabular-nums', fitnessColor)}>
            {fitnessLabel}
          </p>
          <p className="text-[9px] text-fg-faint">Stochastic Fitness</p>
        </div>
        <div className="rounded bg-surface-2 px-2 py-1.5 text-center">
          <p className="text-[13px] font-bold tabular-nums text-fg">
            {emd.toFixed(4)}
          </p>
          <p className="text-[9px] text-fg-faint">EMD Distance</p>
        </div>
        <div className="rounded bg-surface-2 px-2 py-1.5 text-center">
          <p className="text-[13px] font-bold tabular-nums text-danger">
            {render.severity_breakdown.severe}
          </p>
          <p className="text-[9px] text-fg-faint">Severe Variants</p>
        </div>
      </div>

      {/* Distribution comparison chart */}
      {render.data.length > 0 && (
        <div style={{ width: '100%', height: Math.max(140, render.data.length * 36) }}>
          <ResponsiveContainer>
            <RBarChart
              data={render.data}
              layout="vertical"
              margin={{ top: 2, right: 10, bottom: 2, left: 4 }}
            >
              <CartesianGrid strokeDasharray="2 2" stroke="var(--line)" horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fill: 'var(--fg-muted)', fontSize: 9 }}
              />
              <YAxis
                dataKey="label"
                type="category"
                width={110}
                tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 15) + '…' : v)}
                tick={{ fill: 'var(--fg-muted)', fontSize: 8 }}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  fontSize: 10,
                }}
                formatter={(v: number, name: string) => [
                  `${v}%`,
                  name === 'log_pct' ? 'Log frequency' : 'Model probability',
                ]}
              />
              <Legend
                formatter={(v) => (v === 'log_pct' ? 'Log freq.' : 'Model prob.')}
                wrapperStyle={{ fontSize: 9 }}
              />
              <Bar dataKey="log_pct" name="log_pct" fill="var(--accent)" radius={[0, 2, 2, 0]} />
              <Bar dataKey="model_pct" name="model_pct" fill="var(--fg-faint)" radius={[0, 2, 2, 0]} />
            </RBarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Tool result dispatcher ───────────────────────────────────────────

export interface ToolCallState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: ChatToolResultEvent['result'] | null;
}

export function ToolResultRender({
  tc,
  eventLogId,
}: {
  tc: ToolCallState;
  eventLogId?: string;
}) {
  if (tc.result === null) {
    return (
      <div className="mt-1 flex items-center gap-1.5 rounded-md border border-dashed border-line bg-surface-1 px-2 py-1 text-[10px] text-fg-muted">
        <div className="h-2 w-2 animate-spin rounded-full border border-line border-t-accent" />
        <Wrench size={10} />
        Running <span className="font-mono">{tc.name}</span>…
      </div>
    );
  }
  if (tc.result.error) {
    return (
      <div className="mt-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 text-[10px] text-danger">
        Tool <span className="font-mono">{tc.name}</span> failed: {tc.result.error}
      </div>
    );
  }
  const render = tc.result.render;
  if (!render) return null;
  if (render.type === 'bar_chart') return <BarChartRender render={render} toolName={tc.name} eventLogId={eventLogId} />;
  if (render.type === 'line_chart') return <LineChartRender render={render} toolName={tc.name} eventLogId={eventLogId} />;
  if (render.type === 'metric_card') return <MetricCardRender render={render} toolName={tc.name} eventLogId={eventLogId} />;
  if (render.type === 'filter_proposal') return <FilterProposalRender render={render} />;
  if (render.type === 'conformance_chart') return <ConformanceChartRender render={render} eventLogId={eventLogId} />;
  return null;
}
