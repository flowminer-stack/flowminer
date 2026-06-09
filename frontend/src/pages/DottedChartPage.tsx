import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { ScatterChart as ScatterIcon, Calendar, Hash } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import FilterScopeNotice from '@/components/common/FilterScopeNotice';
import EmptyState from '@/components/common/EmptyState';
import clsx from 'clsx';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { useEventLogData } from '@/hooks/useProcessMining';
import { mining } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import type { DottedChartResponse, DottedChartEvent } from '@/types';
import { getCached, setCached } from '@/store/analysisCache';

// ─── Categorical color palette (10 muted tones) ──────────────────────────────

const ACTIVITY_COLORS = [
  '#6ea8d8', // muted blue
  '#7ec8a0', // sage green
  '#e6a56e', // warm amber
  '#b88fd4', // soft violet
  '#e88080', // dusty rose
  '#5bbcb8', // teal
  '#d4c56a', // muted gold
  '#e08daf', // mauve
  '#7ab3e0', // sky blue
  '#a8d48a', // light green
];

type YMode = 'case' | 'resource' | 'activity';

const yModeLabels: Record<YMode, string> = {
  case: 'Case ID',
  resource: 'Resource',
  activity: 'Activity',
};

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return ts;
  }
}

interface DotEntry {
  x: number;
  y: number;
  activity: string;
  case_id: string;
  resource: string | null;
  timestamp: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d: DotEntry = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 shadow-xl text-[11px]">
      <p className="font-semibold text-fg mb-1">{d.activity}</p>
      <p className="text-fg-muted">Case: <span className="text-fg-secondary">{d.case_id}</span></p>
      {d.resource && (
        <p className="text-fg-muted">Resource: <span className="text-fg-secondary">{d.resource}</span></p>
      )}
      <p className="text-fg-muted">Time: <span className="text-fg-secondary">{new Date(d.timestamp).toLocaleString()}</span></p>
    </div>
  );
}

export default function DottedChartPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);

  const cached = eventLogId ? getCached<DottedChartResponse>(eventLogId, 'dotted_chart') : null;
  const [data, setData] = useState<DottedChartResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [yMode, setYMode] = useState<YMode>('case');

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!eventLogId) return;
    if (retryCount === 0) {
      const existing = getCached<DottedChartResponse>(eventLogId, 'dotted_chart');
      if (existing) { setData(existing); setLoading(false); return; }
    }
    setLoading(true);
    setError(null);
    mining
      .getDottedChart(eventLogId)
      .then((d) => { setCached(eventLogId, 'dotted_chart', d); setData(d); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load dotted chart'))
      .finally(() => setLoading(false));
  }, [eventLogId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build color map for activities
  const activityColorMap = useMemo(() => {
    if (!data) return {} as Record<string, string>;
    return Object.fromEntries(
      data.activities.map((act, i) => [act, ACTIVITY_COLORS[i % ACTIVITY_COLORS.length]]),
    );
  }, [data]);

  // Build Y-axis index maps for resource/activity modes
  const resourceIndexMap = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    return Object.fromEntries(data.resources.map((r, i) => [r, i]));
  }, [data]);

  const activityIndexMap = useMemo(() => {
    if (!data) return {} as Record<string, number>;
    return Object.fromEntries(data.activities.map((a, i) => [a, i]));
  }, [data]);

  // Transform events into scatter points
  const scatterData = useMemo((): DotEntry[] => {
    if (!data) return [];
    return data.events.map((ev: DottedChartEvent) => {
      let y: number;
      if (yMode === 'case') {
        y = ev.case_index;
      } else if (yMode === 'resource') {
        y = ev.resource ? (resourceIndexMap[ev.resource] ?? 0) : 0;
      } else {
        y = activityIndexMap[ev.activity] ?? 0;
      }
      return {
        x: new Date(ev.timestamp).getTime(),
        y,
        activity: ev.activity,
        case_id: ev.case_id,
        resource: ev.resource,
        timestamp: ev.timestamp,
      };
    });
  }, [data, yMode, resourceIndexMap, activityIndexMap]);

  // Y-axis tick formatter
  const yTickFormatter = useMemo(() => {
    if (yMode === 'resource') {
      const invMap = Object.fromEntries(
        Object.entries(resourceIndexMap).map(([k, v]) => [v, k]),
      );
      return (v: number) => invMap[v]?.slice(0, 12) ?? String(v);
    }
    if (yMode === 'activity') {
      const invMap = Object.fromEntries(
        Object.entries(activityIndexMap).map(([k, v]) => [v, k]),
      );
      return (v: number) => invMap[v]?.slice(0, 14) ?? String(v);
    }
    return (v: number) => String(v);
  }, [yMode, resourceIndexMap, activityIndexMap]);

  const yTicks = useMemo(() => {
    if (!data) return undefined;
    if (yMode === 'case') return undefined;
    if (yMode === 'resource') return data.resources.map((_, i) => i);
    return data.activities.map((_, i) => i);
  }, [data, yMode]);

  if (loading) {
    return <LoadingSpinner size="lg" text="Building dotted chart..." fullPage />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={retry} />;
  }

  const timeRange = data?.time_range;

  return (
    <div>
      <PageHeader
        title="Dotted Chart"
        icon={ScatterIcon}
        backTo={-1}
        description="Each dot represents one event. Columns are time; rows are cases, resources, or activities depending on the selected Y-axis mode."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      <FilterScopeNotice eventLogId={eventLogId} />

      {/* Stats bar */}
      {data && (
        <div className="mt-5 flex flex-wrap gap-4">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2">
            <Hash size={14} className="text-fg-faint" />
            <span className="text-[12px] text-fg-muted">Events:</span>
            <span className="text-[12px] font-semibold text-fg">
              {data.events.length.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2">
            <Hash size={14} className="text-fg-faint" />
            <span className="text-[12px] text-fg-muted">Cases:</span>
            <span className="text-[12px] font-semibold text-fg">
              {data.case_count.toLocaleString()}
            </span>
          </div>
          {timeRange && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2">
              <Calendar size={14} className="text-fg-faint" />
              <span className="text-[12px] text-fg-muted">Range:</span>
              <span className="text-[12px] font-semibold text-fg">
                {formatTs(timeRange.start)} &ndash; {formatTs(timeRange.end)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Y-axis mode toggle */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-[12px] text-fg-muted">Y-axis:</span>
        <div className="rounded-md border border-line bg-surface-1 p-0.5 flex">
          {(Object.keys(yModeLabels) as YMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setYMode(mode)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                yMode === mode
                  ? 'bg-accent text-surface-0'
                  : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
              )}
            >
              {yModeLabels[mode]}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      {data && scatterData.length > 0 ? (
        <div className="card mt-5 p-5">
          <div className="h-[600px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['auto', 'auto']}
                  scale="time"
                  tickFormatter={(v: number) =>
                    new Date(v).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })
                  }
                  fontSize={11}
                  tick={{ fill: 'var(--chart-tick)' }}
                  name="Timestamp"
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  tickFormatter={yTickFormatter}
                  ticks={yTicks}
                  fontSize={11}
                  tick={{ fill: 'var(--chart-tick)' }}
                  width={yMode === 'case' ? 50 : 110}
                  name={yModeLabels[yMode]}
                />
                <Tooltip content={<CustomTooltip />} />
                <Scatter data={scatterData} isAnimationActive={false}>
                  {scatterData.map((entry, index) => (
                    <Cell
                      key={index}
                      fill={activityColorMap[entry.activity] ?? '#94a3b8'}
                      fillOpacity={0.85}
                      r={5}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4">
            {data.activities.map((act) => (
              <div key={act} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: activityColorMap[act] }}
                />
                <span className="text-[11px] text-fg-muted">{act}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        !loading && (
          <EmptyState
            className="mt-8"
            icon={ScatterIcon}
            title="No event data available"
            description="The event log contains no events to display in the dotted chart."
          />
        )
      )}
    </div>
  );
}
