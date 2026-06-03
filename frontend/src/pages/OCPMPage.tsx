import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Boxes,
  UploadCloud,
  RefreshCw,
  Maximize2,
  ChevronDown,
  X,
  Check,
  Activity,
  Hash,
  Layers,
  GitBranch,
  ArrowRightLeft,
  Clock,
  Table2,
  BarChart3,
  Network,
  Sparkles,
  Calendar,
  Share2,
  Download,
  Timer,
  Workflow,
  PackageOpen,
} from 'lucide-react';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

try { cytoscape.use(dagre); } catch { /* already registered */ }
import type { Core } from 'cytoscape';
import clsx from 'clsx';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ocel, projects as projectsApi, eventLogs as logsApi } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { getCached, setCached } from '@/store/analysisCache';
import { formatDuration } from '@/utils/format';
import ImprovementReport from '@/components/OCPM/ImprovementReport';
import type {
  OCELSummary,
  OCDFGResponse,
  EventLog,
  ObjectInteractionsResponse,
  ObjectLifecycleResponse,
  ActivityObjectTypesResponse,
  OCPetriNetResponse,
  ObjectsGraphResponse,
  OCELFeaturesResponse,
  OCELTemporalResponse,
  ConnectedComponentsResponse,
  OPeraPerformanceResponse,
  StateAwareResponse,
} from '@/types';

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_COLORS = [
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#64748b', // slate
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function getTypeColor(types: string[], type: string): string {
  const idx = types.indexOf(type);
  return TYPE_COLORS[idx % TYPE_COLORS.length] ?? '#64748b';
}

// Compute a relative intensity 0–1 for heat mapping
function intensity(value: number, max: number): number {
  if (max === 0) return 0;
  return value / max;
}

// ─── File Drop Zone ───────────────────────────────────────────────────────────

function OcelDropZone({
  onFile,
  loading,
}: {
  onFile: (file: File) => void;
  loading: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !loading && inputRef.current?.click()}
      className={clsx(
        'relative flex cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center transition-all',
        dragOver
          ? 'border-accent/60 bg-accent/5'
          : 'border-line bg-surface-1 hover:border-accent/40 hover:bg-surface-2',
        loading && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".json,.jsonocel,.xml,.xmlocel,.sqlite"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <div className={clsx('rounded-lg p-2.5', dragOver ? 'bg-accent/10 text-accent' : 'bg-tint text-fg-muted')}>
        {loading ? <RefreshCw size={22} className="animate-spin" /> : <UploadCloud size={22} />}
      </div>
      <div>
        <p className="text-[13px] font-medium text-fg-secondary">
          {loading ? 'Uploading OCEL file…' : 'Drop an OCEL file here'}
        </p>
        <p className="mt-1 text-[11px] text-fg-muted">
          or <span className="font-medium text-accent">browse</span>
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {['.json', '.jsonocel', '.xml', '.xmlocel', '.sqlite'].map((ext) => (
          <span key={ext} className="rounded bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
            {ext}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Multi-select dropdown ────────────────────────────────────────────────────

function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (val: string) => {
    onChange(
      selected.includes(val)
        ? selected.filter((v) => v !== val)
        : [...selected, val],
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-fg-secondary transition-colors hover:border-accent/50 focus:outline-none"
      >
        <span className="truncate text-fg-muted">
          {selected.length === 0
            ? placeholder
            : `${selected.length} column${selected.length > 1 ? 's' : ''} selected`}
        </span>
        <ChevronDown size={12} className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full animate-fade-in rounded-md border border-line bg-surface-2 py-1 shadow-xl">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-fg-faint">No columns available</p>
          ) : (
            options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-tint hover:text-fg"
              >
                <div className={clsx(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                  selected.includes(opt) ? 'border-accent bg-accent' : 'border-line',
                )}>
                  {selected.includes(opt) && <Check size={9} className="text-white" />}
                </div>
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: OCELSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {[
        { icon: Activity, label: 'Events', value: formatNumber(summary.event_count) },
        { icon: Hash, label: 'Objects', value: formatNumber(summary.object_count) },
        { icon: Layers, label: 'Object Types', value: summary.object_types.length },
        { icon: GitBranch, label: 'Activities', value: summary.activities.length },
      ].map((card) => (
        <div key={card.label} className="card p-3">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-accent/10 p-1.5">
              <card.icon size={13} className="text-accent" />
            </div>
            <span className="text-[11px] text-fg-muted">{card.label}</span>
          </div>
          <p className="mt-2 text-[20px] font-bold tabular-nums text-fg">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── OC-DFG Cytoscape graph ───────────────────────────────────────────────────

function OCDFGGraph({
  data,
  summary,
}: {
  data: OCDFGResponse;
  summary: OCELSummary;
}) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const cyContainerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const buildGraph = useCallback(() => {
    if (!cyContainerRef.current) return;
    if (data.nodes.length === 0) return;

    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const nodeBg = isDark ? '#2a2a30' : '#ffffff';
    const nodeBorder = isDark ? '#44444c' : '#c8cbd4';
    const nodeText = isDark ? '#e0e0e4' : '#1a1d24';
    const edgeTextBg = isDark ? '#1e1e22' : '#f7f8fa';
    const edgeTextColor = isDark ? '#71717a' : '#6c7283';

    const uniqueNodeIds = new Set<string>();
    const nodeElements: cytoscape.ElementDefinition[] = [];
    for (const node of data.nodes) {
      if (!uniqueNodeIds.has(node.id)) {
        uniqueNodeIds.add(node.id);
        nodeElements.push({
          data: {
            id: node.id,
            label: node.label,
            frequency: node.frequency,
          },
        });
      }
    }

    const edgeElements: cytoscape.ElementDefinition[] = data.edges.map((edge, i) => ({
      data: {
        id: `e-${i}`,
        source: edge.source,
        target: edge.target,
        frequency: edge.frequency,
        label: String(edge.frequency),
        edgeColor: getTypeColor(summary.object_types, edge.object_type),
        object_type: edge.object_type,
      },
    }));

    const cy = cytoscape({
      container: cyContainerRef.current,
      elements: [...nodeElements, ...edgeElements],
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'text-wrap': 'wrap',
            'text-max-width': '90px',
            'font-size': '11px',
            'font-family': 'Manrope, system-ui, sans-serif',
            'font-weight': 600,
            'background-color': nodeBg,
            'border-width': 1.5,
            'border-color': nodeBorder,
            'shape': 'roundrectangle',
            'width': 'label',
            'height': 'label',
            'padding': '10px',
            'text-valign': 'center',
            'text-halign': 'center',
            'color': nodeText,
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'target-arrow-shape': 'vee',
            'arrow-scale': 0.8,
            'line-color': 'data(edgeColor)',
            'target-arrow-color': 'data(edgeColor)',
            'width': 2,
            'opacity': 0.75,
            'label': 'data(label)',
            'font-size': '9px',
            'font-family': 'JetBrains Mono, monospace',
            'text-rotation': 'autorotate',
            'text-background-color': edgeTextBg,
            'text-background-opacity': 0.85,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle',
            'color': edgeTextColor,
            'text-margin-y': -8,
          } as any,
        },
      ],
      layout: {
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 60,
        rankSep: 120,
        edgeSep: 30,
        animate: false,
        fit: true,
        padding: 50,
      } as any,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      pixelRatio: 2,
      textureOnViewport: false,
    });

    cyRef.current = cy;
  }, [data, summary, isDark]);

  useEffect(() => {
    buildGraph();
    return () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [buildGraph]);

  if (data.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Boxes size={40} className="mx-auto mb-3 text-fg-ghost" />
          <p className="text-[13px] text-fg-muted">No activities found in this OCEL</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div ref={cyContainerRef} className="h-full w-full" />
      <button
        onClick={() => cyRef.current?.fit(undefined, 50)}
        className="btn-ghost absolute right-3 top-3 text-[11px]"
      >
        <Maximize2 size={13} />
        Fit
      </button>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 rounded-lg border border-line bg-surface-2/90 px-3 py-2 backdrop-blur-sm">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          Object Types
        </p>
        <div className="space-y-1">
          {summary.object_types.map((type) => (
            <div key={type} className="flex items-center gap-2">
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: getTypeColor(summary.object_types, type) }}
              />
              <span className="text-[11px] text-fg-secondary">{type}</span>
              <span className="ml-1 text-[10px] text-fg-faint">
                {formatNumber(summary.objects_per_type?.[type] ?? 0)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Object Interactions Panel ────────────────────────────────────────────────

function ObjectInteractionsPanel({
  data,
  objectTypes,
}: {
  data: ObjectInteractionsResponse;
  objectTypes: string[];
}) {
  if (data.interactions.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No object interactions found.
      </p>
    );
  }

  // Build a type-pair matrix
  const typesInvolved = Array.from(
    new Set(data.interactions.flatMap((i) => [i.type_a, i.type_b])),
  ).sort();

  // Map (a, b) -> count (treat as undirected: use canonical order for lookup)
  const countMap = new Map<string, number>();
  const maxCount = Math.max(...data.interactions.map((i) => i.interaction_count), 1);

  for (const interaction of data.interactions) {
    const key = `${interaction.type_a}|||${interaction.type_b}`;
    const keyRev = `${interaction.type_b}|||${interaction.type_a}`;
    const existing = countMap.get(key) ?? countMap.get(keyRev) ?? 0;
    countMap.set(key, existing + interaction.interaction_count);
  }

  function getCount(a: string, b: string): number {
    return (
      countMap.get(`${a}|||${b}`) ??
      countMap.get(`${b}|||${a}`) ??
      0
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="w-28 border-b border-line pb-2 pr-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              Type
            </th>
            {typesInvolved.map((t) => (
              <th
                key={t}
                className="border-b border-line pb-2 px-2 text-center text-[10px] font-medium text-fg-muted"
                style={{ minWidth: 64 }}
              >
                <span
                  className="inline-block truncate max-w-[80px]"
                  title={t}
                  style={{ color: getTypeColor(objectTypes, t) }}
                >
                  {t}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {typesInvolved.map((rowType) => (
            <tr key={rowType} className="group">
              <td className="border-b border-line/50 py-1.5 pr-3 font-medium text-fg-secondary">
                <span
                  className="truncate block max-w-[100px]"
                  title={rowType}
                  style={{ color: getTypeColor(objectTypes, rowType) }}
                >
                  {rowType}
                </span>
              </td>
              {typesInvolved.map((colType) => {
                const count = getCount(rowType, colType);
                const alpha = count > 0 ? 0.12 + 0.7 * intensity(count, maxCount) : 0;
                return (
                  <td
                    key={colType}
                    className="border-b border-line/50 py-1.5 px-2 text-center tabular-nums"
                    style={{
                      backgroundColor: count > 0
                        ? `color-mix(in srgb, ${getTypeColor(objectTypes, rowType)} ${Math.round(alpha * 100)}%, transparent)`
                        : undefined,
                    }}
                    title={count > 0 ? `${rowType} ↔ ${colType}: ${count}` : undefined}
                  >
                    {count > 0 ? (
                      <span className="text-[11px] font-medium text-fg">
                        {formatNumber(count)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-fg-ghost">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-fg-faint">
        Total interactions: {formatNumber(data.total_interactions)}
      </p>
    </div>
  );
}

// ─── Object Lifecycle Panel ───────────────────────────────────────────────────

function ObjectLifecyclePanel({
  data,
  objectTypes,
}: {
  data: ObjectLifecycleResponse;
  objectTypes: string[];
}) {
  if (data.lifecycles.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No lifecycle data available.
      </p>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {data.lifecycles.map((lc) => {
        const color = getTypeColor(objectTypes, lc.object_type);
        return (
          <div
            key={lc.object_type}
            className="rounded-md border border-line bg-surface-1 p-3"
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span
                className="text-[12px] font-semibold truncate"
                style={{ color }}
                title={lc.object_type}
              >
                {lc.object_type}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center mb-2">
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {formatNumber(lc.object_count)}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">objects</p>
              </div>
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {lc.avg_lifecycle_duration == null ? '—' : formatDuration(lc.avg_lifecycle_duration)}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">avg life</p>
              </div>
              <div>
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">
                  {lc.avg_events_per_object > 0 ? lc.avg_events_per_object.toFixed(1) : '—'}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">evt/obj</p>
              </div>
            </div>
            {lc.activities.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {lc.activities.slice(0, 8).map((act) => (
                  <span
                    key={act}
                    className="rounded px-1.5 py-0.5 text-[9px] font-medium bg-tint text-fg-muted truncate max-w-[100px]"
                    title={act}
                  >
                    {act}
                  </span>
                ))}
                {lc.activities.length > 8 && (
                  <span className="rounded px-1.5 py-0.5 text-[9px] text-fg-faint bg-tint">
                    +{lc.activities.length - 8} more
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Activity × Object Type Panel ────────────────────────────────────────────

function ActivityObjectTypesPanel({
  data,
  objectTypes,
}: {
  data: ActivityObjectTypesResponse;
  objectTypes: string[];
}) {
  if (data.activities.length === 0) {
    return (
      <p className="py-4 text-center text-[12px] text-fg-muted">
        No activity data available.
      </p>
    );
  }

  // Collect all object types appearing in any row
  const colTypes = objectTypes.length > 0
    ? objectTypes
    : Array.from(
        new Set(data.activities.flatMap((a) => Object.keys(a.object_types))),
      ).sort();

  const maxInCol = new Map<string, number>();
  for (const colType of colTypes) {
    const vals = data.activities.map((a) => a.object_types[colType] ?? 0);
    maxInCol.set(colType, Math.max(...vals, 1));
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="border-b border-line pb-2 pr-4 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
              Activity
            </th>
            <th className="border-b border-line pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
              Events
            </th>
            {colTypes.map((t) => (
              <th
                key={t}
                className="border-b border-line pb-2 px-2 text-center text-[10px] font-medium whitespace-nowrap"
                style={{ minWidth: 60, color: getTypeColor(objectTypes, t) }}
                title={t}
              >
                <span className="block truncate max-w-[72px]">{t}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.activities.map((row) => (
            <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
              <td className="border-b border-line/40 py-1.5 pr-4 font-medium text-fg-secondary whitespace-nowrap">
                {row.activity}
              </td>
              <td className="border-b border-line/40 py-1.5 px-2 text-right tabular-nums text-fg-muted">
                {formatNumber(row.total_events)}
              </td>
              {colTypes.map((colType) => {
                const val = row.object_types[colType] ?? 0;
                const alpha = val > 0 ? 0.1 + 0.65 * intensity(val, maxInCol.get(colType) ?? 1) : 0;
                return (
                  <td
                    key={colType}
                    className="border-b border-line/40 py-1.5 px-2 text-center tabular-nums"
                    style={{
                      backgroundColor: val > 0
                        ? `color-mix(in srgb, ${getTypeColor(objectTypes, colType)} ${Math.round(alpha * 100)}%, transparent)`
                        : undefined,
                    }}
                  >
                    {val > 0 ? (
                      <span className="text-[11px] font-medium text-fg">{val}</span>
                    ) : (
                      <span className="text-[10px] text-fg-ghost">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-fg-faint">
        Cell values show average number of objects of each type per event execution.
      </p>
    </div>
  );
}

// ─── OCEL-Native: OC Petri Net ────────────────────────────────────────────────

type OCELInsightsData = { insights: Array<{ severity: string; title: string; description: string; recommendation: string | null }>; summary: string };

function OCELInsightsPanel({ ocelId }: { ocelId: string }) {
  const cached = getCached<OCELInsightsData>(ocelId, 'ocel_insights');
  const [data, setData] = useState<OCELInsightsData | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const existing = getCached<OCELInsightsData>(ocelId, 'ocel_insights');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    ocel.getInsights(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_insights', d); setData(d); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex items-center gap-2 text-[11px] text-fg-muted py-2"><LoadingSpinner size="sm" /> Generating insights...</div>;
  if (!data || data.insights.length === 0) return null;

  const sevIcon = (s: string) => s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵';
  const shown = expanded ? data.insights : data.insights.slice(0, 3);

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-fg-muted">{data.summary}</p>
        {data.insights.length > 3 && (
          <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-accent hover:underline shrink-0 ml-2">
            {expanded ? 'Show less' : `Show all ${data.insights.length}`}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {shown.map((insight, i) => (
          <div key={i} className="flex gap-2.5">
            <span className="shrink-0 text-[12px] mt-0.5">{sevIcon(insight.severity)}</span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-fg">{insight.title}</p>
              <p className="text-[11px] text-fg-muted mt-0.5">{insight.description}</p>
              {insight.recommendation && (
                <p className="mt-1 rounded bg-tint/60 px-2 py-1 text-[10px] text-fg-secondary">
                  💡 {insight.recommendation}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OCPetriNetPanel({ ocelId }: { ocelId: string }) {
  const cached = getCached<OCPetriNetResponse>(ocelId, 'oc_petri_net');
  const [data, setData] = useState<OCPetriNetResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OCPetriNetResponse>(ocelId, 'oc_petri_net');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    ocel.getOCPetriNet(ocelId)
      .then((d) => { setCached(ocelId, 'oc_petri_net', d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId]);

  const cyContainerRef = useRef<HTMLDivElement>(null);
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  // Build cytoscape graph from petri net data
  useEffect(() => {
    if (!data || !cyContainerRef.current || data.object_types.length === 0) return;
    const nodeBg = isDark ? '#242428' : '#ffffff';
    const nodeBorder = isDark ? '#44444c' : '#c8cbd4';
    const nodeText = isDark ? '#e0e0e4' : '#1a1d24';
    const edgeColor = isDark ? '#4a8aaa' : '#7a9abb';

    // Build nodes: activities across all object types + places as small dots
    const allActivities = new Set<string>();
    data.object_types.forEach((ot) => ot.activities.forEach((a) => allActivities.add(a)));

    const elements: cytoscape.ElementDefinition[] = [];
    allActivities.forEach((act) => {
      elements.push({ data: { id: `act_${act}`, label: act }, classes: 'activity' });
    });
    // Add object type nodes as group headers
    data.object_types.forEach((ot) => {
      elements.push({ data: { id: `ot_${ot.object_type}`, label: `${ot.object_type}\n${ot.activity_count} acts, ${ot.place_count} places` }, classes: 'objtype' });
      // Connect type to its activities
      ot.activities.forEach((act) => {
        elements.push({ data: { id: `e_${ot.object_type}_${act}`, source: `ot_${ot.object_type}`, target: `act_${act}` } });
      });
    });

    const cy = cytoscape({
      container: cyContainerRef.current,
      elements,
      style: [
        { selector: 'node.activity', style: { 'label': 'data(label)', 'background-color': nodeBg, 'border-width': 1, 'border-color': nodeBorder, 'shape': 'roundrectangle', 'width': 'label', 'height': 'label', 'padding': '8px', 'font-size': '10px', 'font-family': 'Manrope, sans-serif', 'text-valign': 'center', 'text-halign': 'center', 'color': nodeText } as any },
        { selector: 'node.objtype', style: { 'label': 'data(label)', 'background-color': isDark ? '#083344' : '#ecfeff', 'border-width': 2, 'border-color': '#06b6d4', 'shape': 'roundrectangle', 'width': 'label', 'height': 'label', 'padding': '12px', 'font-size': '11px', 'font-weight': 700, 'font-family': 'Manrope, sans-serif', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': '120px', 'color': '#06b6d4' } as any },
        { selector: 'edge', style: { 'width': 1, 'line-color': edgeColor, 'target-arrow-shape': 'none', 'opacity': 0.4, 'curve-style': 'bezier' } as any },
      ],
      layout: { name: 'cose', animate: false, fit: true, nodeRepulsion: () => 30000, idealEdgeLength: () => 80, gravity: 0.5, padding: 30 } as any,
      userZoomingEnabled: true, userPanningEnabled: true, minZoom: 0.4, maxZoom: 5, wheelSensitivity: 1.0, pixelRatio: 2, textureOnViewport: false,
    });

    return () => { cy.destroy(); };
  }, [data, isDark]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Computing activity coverage…" /></div>;
  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data || data.object_types.length === 0) return <p className="text-[12px] text-fg-muted py-4 text-center">No activity-coverage structure found.</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-fg-muted">
        Each object type below is linked to the activities its objects participate in (derived from the
        discovered object-centric Petri net). This is an <b>activity-coverage</b> membership view, not the
        full Petri-net topology.
      </p>
      {/* Stats */}
      <div className="flex flex-wrap gap-2">
        {data.object_types.map((ot) => (
          <div key={ot.object_type} className="rounded-md border border-line bg-surface-1 px-3 py-2">
            <p className="text-[11px] font-semibold text-accent">{ot.object_type}</p>
            <p className="text-[10px] text-fg-muted">{ot.activity_count} activities &middot; {ot.place_count} places &middot; {ot.arc_count} arcs</p>
          </div>
        ))}
      </div>
      {/* Graph */}
      <div ref={cyContainerRef} className="h-[400px] w-full rounded-lg border border-line bg-surface-1" />
    </div>
  );
}

// ─── OCEL-Native: Object Graph ────────────────────────────────────────────────

const GRAPH_TYPE_OPTIONS = [
  { value: 'object_interaction', label: 'Object Interaction' },
  { value: 'object_descendants', label: 'Descendants' },
  { value: 'object_inheritance', label: 'Inheritance' },
  { value: 'object_cobirth', label: 'Co-Birth' },
  { value: 'object_codeath', label: 'Co-Death' },
];

function ObjectGraphVisual({ data }: { data: ObjectsGraphResponse }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  useEffect(() => {
    if (!containerRef.current || data.edges.length === 0) return;

    const nodeBg = isDark ? '#2a2a30' : '#ffffff';
    const nodeBorder = isDark ? '#44444c' : '#c8cbd4';
    const nodeText = isDark ? '#e0e0e4' : '#1a1d24';

    // Collect unique types and their total interaction counts
    const typeCounts: Record<string, number> = {};
    data.edges.forEach((e) => {
      typeCounts[e.source_obj] = (typeCounts[e.source_obj] || 0) + e.count;
      typeCounts[e.target_obj] = (typeCounts[e.target_obj] || 0) + e.count;
    });

    const maxCount = Math.max(...Object.values(typeCounts), 1);
    const maxEdgeCount = Math.max(...data.edges.map((e) => e.count), 1);

    const elements: cytoscape.ElementDefinition[] = [];

    // Nodes = object types
    Object.entries(typeCounts).forEach(([type, count]) => {
      const size = 50 + (count / maxCount) * 60;
      elements.push({
        data: { id: type, label: `${type}\n${count.toLocaleString()}`, size },
      });
    });

    // Edges = type-to-type with width by count
    data.edges.forEach((e, i) => {
      const w = 1 + (e.count / maxEdgeCount) * 8;
      elements.push({
        data: {
          id: `e${i}`,
          source: e.source_obj,
          target: e.target_obj,
          label: e.count.toLocaleString(),
          width: w,
        },
      });
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)', 'text-wrap': 'wrap', 'text-max-width': '100px',
            'font-size': '11px', 'font-family': 'Manrope, sans-serif', 'font-weight': 600,
            'background-color': nodeBg, 'border-width': 2, 'border-color': nodeBorder,
            'shape': 'ellipse', 'width': 'data(size)', 'height': 'data(size)',
            'text-valign': 'center', 'text-halign': 'center', 'color': nodeText,
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'width': 'data(width)', 'line-color': '#06b6d4', 'target-arrow-color': '#06b6d4',
            'target-arrow-shape': 'none', 'curve-style': 'bezier', 'opacity': 0.5,
            'label': 'data(label)', 'font-size': '9px', 'font-family': 'JetBrains Mono, monospace',
            'text-rotation': 'autorotate', 'color': isDark ? '#71717a' : '#6c7283',
            'text-background-color': isDark ? '#1e1e22' : '#f7f8fa',
            'text-background-opacity': 0.85, 'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle', 'text-margin-y': -8,
          } as any,
        },
      ],
      layout: { name: 'circle', padding: 60, animate: false } as any,
      userZoomingEnabled: true, userPanningEnabled: true, minZoom: 0.3, maxZoom: 3, wheelSensitivity: 0.3, pixelRatio: 2, textureOnViewport: false,
    });

    return () => { cy.destroy(); };
  }, [data, isDark]);

  if (data.edges.length === 0) {
    return <p className="text-[12px] text-fg-muted py-4 text-center">No relationships found for this graph type.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center inline-block">
        <p className="text-[18px] font-bold tabular-nums text-fg">{data.total_edges.toLocaleString()}</p>
        <p className="text-[9px] uppercase tracking-wider text-fg-faint mt-0.5">total relationships</p>
      </div>
      <div ref={containerRef} className="h-[350px] w-full rounded-lg border border-line bg-surface-1" />
    </div>
  );
}

function ObjectGraphPanel({ ocelId }: { ocelId: string }) {
  const [graphType, setGraphType] = useState('object_interaction');
  const cacheKey = `objects_graph:${graphType}`;
  const cached = getCached<ObjectsGraphResponse>(ocelId, cacheKey);
  const [data, setData] = useState<ObjectsGraphResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = `objects_graph:${graphType}`;
    const existing = getCached<ObjectsGraphResponse>(ocelId, key);
    if (existing) { setData(existing); setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);
    setData(null);
    ocel.getObjectsGraph(ocelId, graphType)
      .then((d) => { setCached(ocelId, key, d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId, graphType]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-fg-muted shrink-0">Graph type:</label>
        <select
          value={graphType}
          onChange={(e) => setGraphType(e.target.value)}
          className="rounded-md border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg-secondary focus:outline-none focus:border-accent/50"
        >
          {GRAPH_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {loading && <div className="flex justify-center py-6"><LoadingSpinner size="sm" text="Computing graph…" /></div>}
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {data && (
        <>
          <ObjectGraphVisual data={data} />
          {/* Type-to-type interaction cards */}
          {data.edges.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 mt-3">
              {data.edges.map((e, i) => {
                const maxCount = data.edges[0]?.count ?? 1;
                const intensity = Math.max(0.15, (e.count / maxCount));
                return (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-2.5">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-[12px] font-medium text-fg truncate">{e.source_obj}</span>
                      <span className="text-[10px] text-fg-ghost shrink-0">&harr;</span>
                      <span className="text-[12px] font-medium text-fg truncate">{e.target_obj}</span>
                    </div>
                    <div
                      className="shrink-0 rounded px-2 py-0.5 text-[11px] font-bold tabular-nums text-white"
                      style={{ backgroundColor: `rgba(6, 182, 212, ${intensity})` }}
                    >
                      {e.count.toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── OCEL-Native: Object Features ────────────────────────────────────────────

function cleanColumnName(name: string): string {
  return name
    .replace(/^@@/, '')
    .replace(/^ocel[_:]?/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || name;
}

// Identify the most useful feature columns to show prominently
const KEY_FEATURE_PATTERNS = [
  'lifecycle_length', 'lifecycle_duration', 'degree_centrality',
  'unique_activities', 'start_timestamp', 'end_timestamp',
  'num_', 'count', 'duration', 'wip',
];

function ObjectFeaturesPanel({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [selectedType, setSelectedType] = useState(objectTypes[0] ?? '');
  const featureKey = `ocel_features:${selectedType}`;
  const cached = getCached<OCELFeaturesResponse>(ocelId, featureKey);
  const [data, setData] = useState<OCELFeaturesResponse | null>(cached);
  const [loading, setLoading] = useState(!cached && !!selectedType);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedType) return;
    const key = `ocel_features:${selectedType}`;
    const existing = getCached<OCELFeaturesResponse>(ocelId, key);
    if (existing) { setData(existing); setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);
    setData(null);
    ocel.getOCELFeatures(ocelId, selectedType)
      .then((d) => { setCached(ocelId, key, d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId, selectedType]);

  const handleDownload = () => {
    if (!data) return;
    const header = data.columns.join(',');
    const csvRows = data.rows.map((row) =>
      data.columns.map((c) => {
        const v = row[c];
        const s = v === null || v === undefined ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    );
    const blob = new Blob([header + '\n' + csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `features_${selectedType}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-fg-muted shrink-0">Object type:</label>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          className="rounded-md border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg-secondary focus:outline-none focus:border-accent/50"
        >
          {objectTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {data && data.rows.length > 0 && (
          <button onClick={handleDownload} className="btn-ghost ml-auto text-[11px]">
            <Download size={12} />
            Download CSV
          </button>
        )}
      </div>

      {loading && <div className="flex justify-center py-6"><LoadingSpinner size="sm" text="Extracting features…" /></div>}
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {data && (
        <>
          <div className="flex gap-3 text-[11px]">
            <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
              <p className="text-[18px] font-bold tabular-nums text-fg">{data.total_objects.toLocaleString()}</p>
              <p className="text-[9px] uppercase tracking-wider text-fg-faint mt-0.5">objects</p>
            </div>
            <div className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
              <p className="text-[18px] font-bold tabular-nums text-fg">{data.columns.length}</p>
              <p className="text-[9px] uppercase tracking-wider text-fg-faint mt-0.5">features</p>
            </div>
          </div>

          {data.columns.length > 0 && data.rows.length > 0 ? (
            <>
              {/* Key features summary — show averages of numeric columns */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.columns
                  .filter((col) => {
                    // Only show numeric columns with interesting names
                    const lower = col.toLowerCase();
                    return KEY_FEATURE_PATTERNS.some((p) => lower.includes(p)) ||
                      (data.rows[0]?.[col] !== null && typeof data.rows[0]?.[col] === 'number');
                  })
                  .slice(0, 9)
                  .map((col) => {
                    const vals = data.rows.map((r) => r[col]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
                    const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                    const min = vals.length > 0 ? Math.min(...vals) : null;
                    const max = vals.length > 0 ? Math.max(...vals) : null;
                    const fmt = (v: number | null) => {
                      if (v === null) return '—';
                      if (Math.abs(v) > 86400) return `${(v / 86400).toFixed(1)}d`;
                      if (Math.abs(v) > 3600) return `${(v / 3600).toFixed(1)}h`;
                      if (Math.abs(v) > 60) return `${(v / 60).toFixed(1)}m`;
                      if (Number.isInteger(v)) return v.toLocaleString();
                      return v.toFixed(2);
                    };
                    return (
                      <div key={col} className="rounded-md border border-line bg-surface-1 px-3 py-2">
                        <p className="text-[10px] text-fg-muted truncate" title={col}>{cleanColumnName(col)}</p>
                        <p className="text-[16px] font-bold tabular-nums text-fg mt-0.5">{fmt(avg)}</p>
                        {min !== null && max !== null && (
                          <p className="text-[9px] text-fg-faint mt-0.5">min {fmt(min)} &middot; max {fmt(max)}</p>
                        )}
                      </div>
                    );
                  })}
              </div>

              {/* All features list */}
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium text-fg-secondary hover:text-fg select-none">
                  All {data.columns.length} features — preview table
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr>
                        {data.columns.map((col) => (
                          <th key={col} className="border-b border-line pb-1.5 px-2 text-left text-[10px] font-semibold tracking-wider text-fg-faint whitespace-nowrap">
                            {cleanColumnName(col)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.slice(0, 10).map((row, i) => (
                        <tr key={i} className="hover:bg-tint/50 transition-colors">
                          {data.columns.map((col) => {
                            const v = row[col];
                            const display = v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v).slice(0, 40);
                            return (
                              <td key={col} className="border-b border-line/40 py-1.5 px-2 tabular-nums text-fg-secondary whitespace-nowrap">{display}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : (
            <p className="text-[12px] text-fg-muted py-2 text-center">No feature data available for this type.</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── OCEL-Native: Temporal Summary ───────────────────────────────────────────

const CHART_COLORS = { primary: '#06b6d4', secondary: '#8b5cf6' };

function TemporalSummaryPanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<OCELTemporalResponse>(ocelId, 'ocel_temporal');
  const [data, setData] = useState<OCELTemporalResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OCELTemporalResponse>(ocelId, 'ocel_temporal');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    ocel.getTemporalSummary(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_temporal', d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Computing temporal summary…" /></div>;
  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  const hasHourData = data.events_by_hour.some((h) => h.count > 0);
  const hasDayData = data.events_by_day.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {hasHourData && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Events by Hour of Day</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data.events_by_hour} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="hour" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}h`} />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                labelFormatter={(v) => `Hour ${v}:00`}
                formatter={(v: number) => [v.toLocaleString(), 'Events']}
              />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {hasDayData && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Events by Day</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={data.events_by_day} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false}
                tickFormatter={(v: string) => v.slice(5)} /* MM-DD */
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                formatter={(v: number) => [v.toLocaleString(), 'Events']}
              />
              <Line type="monotone" dataKey="count" stroke={CHART_COLORS.secondary} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.activity_timeline.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Activity Timeline</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  {['Activity', 'Events', 'First Seen', 'Last Seen'].map((h) => (
                    <th key={h} className="border-b border-line pb-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activity_timeline.map((row) => (
                  <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
                    <td className="border-b border-line/40 py-1.5 px-3 font-medium text-fg-secondary">{row.activity}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 tabular-nums text-fg">{row.event_count.toLocaleString()}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted">{row.first_seen.slice(0, 10)}</td>
                    <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted">{row.last_seen.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!hasHourData && !hasDayData && data.activity_timeline.length === 0 && (
        <p className="text-[12px] text-fg-muted py-4 text-center">No temporal data available.</p>
      )}
    </div>
  );
}

// ─── OCEL-Native: Connected Components ───────────────────────────────────────

function ConnectedComponentsPanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<ConnectedComponentsResponse>(ocelId, 'ocel_components');
  const [data, setData] = useState<ConnectedComponentsResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<ConnectedComponentsResponse>(ocelId, 'ocel_components');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    ocel.getConnectedComponents(ocelId)
      .then((d) => { setCached(ocelId, 'ocel_components', d); setData(d); })
      .catch((e) => setError(e?.response?.data?.detail ?? e.message ?? 'Request failed'))
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Analyzing graph components…" /></div>;
  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Components', value: data.total_components.toLocaleString() },
          { label: 'Largest', value: data.largest_component_size.toLocaleString() },
          { label: 'Avg Size', value: data.avg_component_size.toFixed(1) },
          { label: 'Size Buckets', value: data.size_distribution.length },
        ].map((card) => (
          <div key={card.label} className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
            <p className="text-[18px] font-bold tabular-nums text-fg leading-none">{card.value}</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">{card.label}</p>
          </div>
        ))}
      </div>

      {data.size_distribution.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Component Size Distribution</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={data.size_distribution.slice(0, 40)}
              margin={{ top: 2, right: 8, bottom: 2, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="size" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} label={{ value: 'Component size (nodes)', position: 'insideBottom', offset: -2, fontSize: 9, fill: tickColor }} />
              <YAxis tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={36} label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 6, fontSize: 9, fill: tickColor }} />
              <Tooltip
                contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
                labelFormatter={(v) => `Size ${v}`}
                formatter={(v: number) => [v.toLocaleString(), 'Components']}
              />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          {data.size_distribution.length > 40 && (
            <p className="mt-1 text-[10px] text-fg-faint">Showing first 40 of {data.size_distribution.length} size buckets.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── OPerA Performance Panel ──────────────────────────────────────────────────

// Friendly metadata for the four OPerA timing metrics. Each metric is a column
// in the table and gets its own colour for the bar chart.
const OPERA_METRICS = [
  { key: 'flow_time', label: 'Flow', color: '#06b6d4', help: 'Total time from first to last object-token arrival at the activity' },
  { key: 'synchronization_time', label: 'Sync', color: '#8b5cf6', help: 'Time the activity waits for the last required object to become available' },
  { key: 'pooling_time', label: 'Pooling', color: '#f59e0b', help: 'Time pooling objects of a single type before the activity fires' },
  { key: 'lagging_time', label: 'Lagging', color: '#ef4444', help: 'Time an object waits because objects of other types lag behind' },
] as const;

function OPeraPerformancePanel({ ocelId }: { ocelId: string }) {
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';
  const gridColor = isDark ? '#2a2a30' : '#e8eaed';
  const tickColor = isDark ? '#71717a' : '#6c7283';

  const cached = getCached<OPeraPerformanceResponse>(ocelId, 'opera_performance');
  const [data, setData] = useState<OPeraPerformanceResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    const existing = getCached<OPeraPerformanceResponse>(ocelId, 'opera_performance');
    if (existing) { setData(existing); setLoading(false); return; }
    setLoading(true);
    setError(null);
    setUnavailable(null);
    ocel.getOPeraPerformance(ocelId)
      .then((d) => { setCached(ocelId, 'opera_performance', d); setData(d); })
      .catch((e) => {
        const status = e?.response?.status;
        const detail = e?.response?.data?.detail;
        // 501 = optional `ocpa` package not installed. Surface as an
        // informative empty state, not an error toast.
        if (status === 501) {
          setUnavailable(detail ?? 'OPerA metrics require the optional ocpa package.');
        } else {
          setError(detail ?? e.message ?? 'Request failed');
        }
      })
      .finally(() => setLoading(false));
  }, [ocelId]);

  if (loading) return <div className="flex justify-center py-8"><LoadingSpinner size="md" text="Computing OPerA performance…" /></div>;

  if (unavailable) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
        <div className="rounded-lg bg-tint p-2.5 text-fg-muted">
          <PackageOpen size={22} />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-fg">OPerA metrics unavailable</p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">{unavailable}</p>
        </div>
        <code className="rounded bg-tint px-2.5 py-1 text-[11px] text-fg-secondary">pip install ocpa</code>
      </div>
    );
  }

  if (error) return <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>;
  if (!data) return null;

  const hasMetrics = data.activities.some((a) =>
    OPERA_METRICS.some(({ key }) => a[key] !== null && a[key] !== undefined),
  );

  if (data.activities.length === 0 || !hasMetrics) {
    return (
      <p className="py-6 text-center text-[12px] text-fg-muted">
        {data.note ?? 'No per-activity OPerA timing diagnostics were produced for this OCEL.'}
      </p>
    );
  }

  // Chart data: top activities by flow time (the headline metric).
  const chartData = [...data.activities]
    .sort((a, b) => (b.flow_time ?? 0) - (a.flow_time ?? 0))
    .slice(0, 12)
    .map((a) => ({
      activity: a.activity.length > 18 ? `${a.activity.slice(0, 17)}…` : a.activity,
      fullActivity: a.activity,
      flow_time: a.flow_time ?? 0,
      synchronization_time: a.synchronization_time ?? 0,
      pooling_time: a.pooling_time ?? 0,
      lagging_time: a.lagging_time ?? 0,
    }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-fg-muted">
        OPerA decomposes each activity&rsquo;s time into <b>flow</b>, <b>synchronization</b>, <b>pooling</b>,
        and <b>lagging</b> time — the object-centric analogue of the waiting/service split in a flat log.
      </p>

      <div>
        <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Timing by Activity (top {chartData.length} by flow time)</p>
        <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 34)}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 2, right: 12, bottom: 2, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatDuration(v)} />
            <YAxis type="category" dataKey="activity" tick={{ fontSize: 9, fill: tickColor }} tickLine={false} axisLine={false} width={110} />
            <Tooltip
              contentStyle={{ background: isDark ? '#1e1e22' : '#fff', border: `1px solid ${gridColor}`, borderRadius: 6, fontSize: 11 }}
              formatter={(v: number, name: string) => [formatDuration(v), name]}
              labelFormatter={(_l, payload) => payload?.[0]?.payload?.fullActivity ?? ''}
            />
            {OPERA_METRICS.map((m) => (
              <Bar key={m.key} dataKey={m.key} name={m.label} stackId="opera" fill={m.color} radius={[0, 0, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap gap-3">
          {OPERA_METRICS.map((m) => (
            <div key={m.key} className="flex items-center gap-1.5" title={m.help}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
              <span className="text-[10px] text-fg-muted">{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="border-b border-line pb-2 pr-4 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">
                Activity
              </th>
              {OPERA_METRICS.map((m) => (
                <th
                  key={m.key}
                  className="border-b border-line pb-2 px-2 text-right text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
                  style={{ color: m.color }}
                  title={m.help}
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.activities.map((row) => (
              <tr key={row.activity} className="hover:bg-tint/50 transition-colors">
                <td className="border-b border-line/40 py-1.5 pr-4 font-medium text-fg-secondary whitespace-nowrap">{row.activity}</td>
                {OPERA_METRICS.map((m) => {
                  const v = row[m.key];
                  return (
                    <td key={m.key} className="border-b border-line/40 py-1.5 px-2 text-right tabular-nums text-fg">
                      {v == null
                        ? <span className="text-[10px] text-fg-ghost">—</span>
                        : formatDuration(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.note && <p className="text-[10px] text-fg-faint">{data.note}</p>}
    </div>
  );
}

// ─── State-Aware OCPM Panel ───────────────────────────────────────────────────

function StateAwarePanel({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [stateColumn, setStateColumn] = useState('');
  const [objectType, setObjectType] = useState('');
  const [data, setData] = useState<StateAwareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const run = useCallback(() => {
    const col = stateColumn.trim();
    if (!col) return;
    setLoading(true);
    setError(null);
    setUnavailable(null);
    setData(null);
    ocel.getStateAware(ocelId, col, objectType || undefined)
      .then((d) => setData(d))
      .catch((e) => {
        const status = e?.response?.status;
        const detail = e?.response?.data?.detail;
        if (status === 501) {
          setUnavailable(detail ?? 'State-aware OCPM is not available in this environment.');
        } else {
          setError(detail ?? e.message ?? 'Request failed');
        }
      })
      .finally(() => setLoading(false));
  }, [ocelId, stateColumn, objectType]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11px] text-fg-muted">
        State-Aware OCPM (Kretzschmann, Berti &amp; van der Aalst, EDOC 2025) materializes every change of an
        object attribute into a synthetic transition event and annotates existing events with the current
        object state — unlocking lifecycle analysis on standard OCEL 2.0 logs.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface-1 p-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">State attribute column</label>
          <input
            type="text"
            value={stateColumn}
            onChange={(e) => setStateColumn(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="e.g. status"
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-secondary focus:border-accent/50 focus:outline-none"
            style={{ minWidth: 180 }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">Object type (optional)</label>
          <select
            value={objectType}
            onChange={(e) => setObjectType(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-secondary focus:border-accent/50 focus:outline-none"
            style={{ minWidth: 160 }}
          >
            <option value="">All object types</option>
            {objectTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <button
          onClick={run}
          disabled={loading || !stateColumn.trim()}
          className="btn-primary text-[12px]"
        >
          {loading ? <><RefreshCw size={13} className="animate-spin" /> Enriching…</> : 'Enrich with state transitions'}
        </button>
      </div>

      {unavailable && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-1 px-6 py-10 text-center">
          <div className="rounded-lg bg-tint p-2.5 text-fg-muted">
            <PackageOpen size={22} />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-fg">State-aware enrichment unavailable</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">{unavailable}</p>
          </div>
        </div>
      )}
      {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] text-danger">{error}</div>}

      {data && (
        <div className="flex flex-col gap-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'New events', value: data.new_events_count.toLocaleString() },
              { label: 'Annotated', value: data.annotated_events.toLocaleString() },
              { label: 'Transitions', value: data.state_transitions.length.toLocaleString() },
              { label: 'Stateful types', value: Object.keys(data.distinct_states).length.toLocaleString() },
            ].map((card) => (
              <div key={card.label} className="rounded-md border border-line bg-surface-1 px-3 py-2 text-center">
                <p className="text-[18px] font-bold tabular-nums text-fg leading-none">{card.value}</p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-fg-faint">{card.label}</p>
              </div>
            ))}
          </div>

          {data.note && <p className="text-[10px] text-fg-faint">{data.note}</p>}

          {/* Distinct states per object type */}
          {Object.keys(data.distinct_states).length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold text-fg-secondary">Distinct States by Object Type</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(data.distinct_states).map(([type, states]) => (
                  <div key={type} className="rounded-md border border-line bg-surface-1 px-3 py-2">
                    <p className="text-[11px] font-semibold text-accent truncate" title={type}>{type}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {states.map((s) => (
                        <span key={s} className="rounded bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted truncate max-w-[140px]" title={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* State transition sample */}
          {data.state_transitions.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold text-fg-secondary">
                State Transitions {data.state_transitions.length > 50 && <span className="text-fg-faint">(first 50 of {data.state_transitions.length.toLocaleString()})</span>}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr>
                      {['Object', 'Type', 'From', 'To', 'Activity', 'Timestamp'].map((h) => (
                        <th key={h} className="border-b border-line pb-1.5 px-3 text-left text-[10px] font-semibold uppercase tracking-wider text-fg-faint whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.state_transitions.slice(0, 50).map((t, i) => (
                      <tr key={i} className="hover:bg-tint/50 transition-colors">
                        <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-secondary truncate max-w-[120px]" title={t.oid}>{t.oid}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.object_type}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.from_state ?? <span className="text-fg-ghost">—</span>}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 font-medium text-fg whitespace-nowrap">{t.to_state}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 text-fg-muted whitespace-nowrap">{t.activity}</td>
                        <td className="border-b border-line/40 py-1.5 px-3 font-mono text-[10px] text-fg-muted whitespace-nowrap">{t.timestamp.slice(0, 19).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── OCEL-Native Analysis Hub ─────────────────────────────────────────────────

interface NativeAnalysisItem {
  id: string;
  label: string;
  icon: React.ElementType;
  description: string;
}

const NATIVE_ANALYSIS_ITEMS: NativeAnalysisItem[] = [
  { id: 'oc-petri-net',  label: 'Activity Coverage',      icon: Network,   description: 'Which activities each object type participates in' },
  { id: 'opera',         label: 'OPerA Performance',      icon: Timer,     description: 'Flow / sync / pooling / lagging time per activity' },
  { id: 'state-aware',   label: 'State-Aware OCPM',       icon: Workflow,  description: 'Materialize object-state transitions (EDOC 2025)' },
  { id: 'object-graph',  label: 'Object Graph',           icon: Share2,    description: 'Object-level interaction / ancestry graphs' },
  { id: 'features',      label: 'Object Features',        icon: Sparkles,  description: 'Per-object feature matrix with CSV export' },
  { id: 'temporal',      label: 'Temporal Summary',       icon: Calendar,  description: 'Event distribution over time' },
  { id: 'components',    label: 'Connected Components',   icon: BarChart3, description: 'Graph component size distribution' },
];

function NativeAnalysisHub({ ocelId, objectTypes }: { ocelId: string; objectTypes: string[] }) {
  const [selected, setSelected] = useState(NATIVE_ANALYSIS_ITEMS[0].id);
  const active = NATIVE_ANALYSIS_ITEMS.find((a) => a.id === selected) ?? NATIVE_ANALYSIS_ITEMS[0];

  return (
    <div className="flex gap-3 overflow-hidden" style={{ minHeight: 420 }}>
      {/* Sidebar */}
      <div className="w-48 shrink-0 overflow-y-auto rounded-lg border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">OCEL-Native Tools</p>
        </div>
        <nav className="py-1">
          {NATIVE_ANALYSIS_ITEMS.map((item) => {
            const isActive = item.id === selected;
            return (
              <button
                key={item.id}
                onClick={() => setSelected(item.id)}
                title={item.description}
                className={clsx(
                  'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                )}
              >
                <item.icon size={13} className={isActive ? 'text-accent' : 'text-fg-faint'} />
                <span className="text-[11px] font-medium leading-tight">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-1">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <active.icon size={14} className="text-accent" />
          <div>
            <h2 className="text-[13px] font-semibold text-fg">{active.label}</h2>
            <p className="text-[10px] text-fg-faint">{active.description}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {active.id === 'oc-petri-net'  && <OCPetriNetPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'opera'         && <OPeraPerformancePanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'state-aware'   && <StateAwarePanel key={ocelId} ocelId={ocelId} objectTypes={objectTypes} />}
          {active.id === 'object-graph'  && <ObjectGraphPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'features'      && <ObjectFeaturesPanel key={ocelId} ocelId={ocelId} objectTypes={objectTypes} />}
          {active.id === 'temporal'      && <TemporalSummaryPanel key={ocelId} ocelId={ocelId} />}
          {active.id === 'components'    && <ConnectedComponentsPanel key={ocelId} ocelId={ocelId} />}
        </div>
      </div>
    </div>
  );
}

// ─── Analysis Section ─────────────────────────────────────────────────────────

function AnalysisSection({
  ocelId,
  objectTypes,
}: {
  ocelId: string;
  objectTypes: string[];
}) {
  const cachedInt = getCached<ObjectInteractionsResponse>(ocelId, 'ocel_interactions');
  const cachedLc = getCached<ObjectLifecycleResponse>(ocelId, 'ocel_lifecycle');
  const cachedAct = getCached<ActivityObjectTypesResponse>(ocelId, 'ocel_activity_types');
  const allCached = !!(cachedInt && cachedLc && cachedAct);

  const [interactions, setInteractions] = useState<ObjectInteractionsResponse | null>(cachedInt);
  const [lifecycle, setLifecycle] = useState<ObjectLifecycleResponse | null>(cachedLc);
  const [activityTypes, setActivityTypes] = useState<ActivityObjectTypesResponse | null>(cachedAct);
  const [loading, setLoading] = useState(!allCached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ci = getCached<ObjectInteractionsResponse>(ocelId, 'ocel_interactions');
    const cl = getCached<ObjectLifecycleResponse>(ocelId, 'ocel_lifecycle');
    const ca = getCached<ActivityObjectTypesResponse>(ocelId, 'ocel_activity_types');
    if (ci && cl && ca) {
      setInteractions(ci); setLifecycle(cl); setActivityTypes(ca);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.allSettled([
      ocel.getObjectInteractions(ocelId),
      ocel.getObjectLifecycle(ocelId),
      ocel.getActivityObjectTypes(ocelId),
    ]).then(([intRes, lcRes, actRes]) => {
      if (intRes.status === 'fulfilled') { setCached(ocelId, 'ocel_interactions', intRes.value); setInteractions(intRes.value); }
      if (lcRes.status === 'fulfilled') { setCached(ocelId, 'ocel_lifecycle', lcRes.value); setLifecycle(lcRes.value); }
      if (actRes.status === 'fulfilled') { setCached(ocelId, 'ocel_activity_types', actRes.value); setActivityTypes(actRes.value); }
      const anyFailed = [intRes, lcRes, actRes].some((r) => r.status === 'rejected');
      if (anyFailed && !interactions && !lifecycle && !activityTypes) {
        setError('Some analysis endpoints failed. Results may be partial.');
      }
      setLoading(false);
    });
  }, [ocelId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <LoadingSpinner size="md" text="Computing OCEL analysis…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          {error}
        </div>
      )}

      {/* Object Interactions */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <ArrowRightLeft size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Object Interactions</h3>
            <p className="text-[10px] text-fg-muted">
              Co-occurrence frequency between object type pairs across events
            </p>
          </div>
        </div>
        {interactions ? (
          <ObjectInteractionsPanel data={interactions} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>

      {/* Object Lifecycle */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <Clock size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Object Lifecycle</h3>
            <p className="text-[10px] text-fg-muted">
              Per-type object counts, average lifecycle duration, and associated activities
            </p>
          </div>
        </div>
        {lifecycle ? (
          <ObjectLifecyclePanel data={lifecycle} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>

      {/* Activity × Object Type */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="rounded-md bg-accent/10 p-1.5">
            <Table2 size={13} className="text-accent" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-fg">Activity × Object Type</h3>
            <p className="text-[10px] text-fg-muted">
              Average number of objects of each type involved per activity execution
            </p>
          </div>
        </div>
        {activityTypes ? (
          <ActivityObjectTypesPanel data={activityTypes} objectTypes={objectTypes} />
        ) : (
          <p className="text-[12px] text-fg-muted">Not available.</p>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OCPMPage() {
  const { eventLogId } = useParams<{ eventLogId?: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);

  // State
  const [uploadLoading, setUploadLoading] = useState(false);
  const [convertLoading, setConvertLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);

  const [summary, setSummary] = useState<OCELSummary | null>(null);
  const [dfg, setDfg] = useState<OCDFGResponse | null>(null);

  // Top-level page tab: 'overview' | 'analysis' | 'improvements'
  const [pageTab, setPageTab] = useState<'overview' | 'analysis' | 'improvements'>('overview');

  // Convert from existing event log
  const [allEventLogs, setAllEventLogs] = useState<EventLog[]>([]);
  const [eventLogsLoading, setEventLogsLoading] = useState(false);
  const [selectedEventLogId, setSelectedEventLogId] = useState('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [eventLogDropdownOpen, setEventLogDropdownOpen] = useState(false);
  const eventLogDropdownRef = useRef<HTMLDivElement>(null);

  // Load all event logs for the convert panel
  useEffect(() => {
    setEventLogsLoading(true);
    projectsApi.list().then(async (projs) => {
      const results = await Promise.allSettled(
        projs.map((p) => logsApi.list(p.id)),
      );
      const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      setAllEventLogs(all);
      setEventLogsLoading(false);
    }).catch(() => setEventLogsLoading(false));
  }, []);

  // Close event log dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (eventLogDropdownRef.current && !eventLogDropdownRef.current.contains(e.target as Node)) {
        setEventLogDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedLog = allEventLogs.find((l) => l.id === selectedEventLogId);
  const columnOptions = selectedLog
    ? [
        selectedLog.case_id_column,
        selectedLog.activity_column,
        selectedLog.timestamp_column,
        selectedLog.resource_column,
        ...(selectedLog.additional_columns ?? []),
      ].filter((c): c is string => Boolean(c))
    : [];

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSummaryLoaded = useCallback(async (s: OCELSummary) => {
    setSummary(s);
    setDfg(null);

    setDiscoverLoading(true);
    try {
      const g = await ocel.discover(s.ocel_id);
      setDfg(g);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Discovery failed',
        message: e instanceof Error ? e.message : 'Could not discover OC-DFG',
      });
    } finally {
      setDiscoverLoading(false);
    }
  }, [addNotification]);

  // Auto-load when navigated from project with an event log ID
  useEffect(() => {
    if (!eventLogId || summary) return;
    setDiscoverLoading(true);
    ocel
      .getSummary(eventLogId)
      .then((s) => handleSummaryLoaded(s))
      .catch(() => {
        addNotification({
          type: 'error',
          title: 'OCEL not found',
          message: 'The OCEL data may have been cleared. Please re-upload the file.',
        });
        setDiscoverLoading(false);
      });
  }, [eventLogId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = useCallback(async (file: File) => {
    setUploadLoading(true);
    try {
      const uploadResult = await ocel.upload(file);
      const ocelId = (uploadResult as any).id ?? (uploadResult as any).ocel_id;
      addNotification({ type: 'success', title: 'OCEL uploaded', message: `${uploadResult.event_count} events loaded` });
      const fullSummary = await ocel.getSummary(ocelId);
      await handleSummaryLoaded(fullSummary);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Upload failed',
        message: e instanceof Error ? e.message : 'Could not upload OCEL file',
      });
    } finally {
      setUploadLoading(false);
    }
  }, [addNotification, handleSummaryLoaded]);

  const handleConvert = useCallback(async () => {
    if (!selectedEventLogId || selectedColumns.length === 0) return;
    setConvertLoading(true);
    try {
      const convertResult = await ocel.convert(selectedEventLogId, selectedColumns);
      const ocelId = (convertResult as any).id ?? (convertResult as any).ocel_id;
      addNotification({ type: 'success', title: 'Converted to OCEL', message: `${convertResult.object_types.length} object types` });
      const fullSummary = await ocel.getSummary(ocelId);
      await handleSummaryLoaded(fullSummary);
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Conversion failed',
        message: e instanceof Error ? e.message : 'Could not convert event log',
      });
    } finally {
      setConvertLoading(false);
    }
  }, [selectedEventLogId, selectedColumns, addNotification, handleSummaryLoaded]);

  const handleFlatten = useCallback(async (objectType: string) => {
    if (!summary) return;
    try {
      const result = await ocel.flatten(summary.ocel_id, objectType);
      if (result?.event_log_id) {
        navigate(`/process/${result.event_log_id}`);
      } else {
        addNotification({ type: 'info', title: 'Flatten complete', message: `Flattened for "${objectType}"` });
      }
    } catch (e) {
      addNotification({
        type: 'error',
        title: 'Flatten failed',
        message: e instanceof Error ? e.message : 'Could not flatten OCEL',
      });
    }
  }, [summary, navigate, addNotification]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <PageHeader
        title="Object-Centric Process Mining"
        icon={Boxes}
        description="Discover object-centric directly-follows graphs from OCEL 2.0 data or convert existing event logs."
      />

      {/* Loading state when auto-loading from event log */}
      {!summary && eventLogId && (
        <div className="mt-8">
          <LoadingSpinner size="lg" text="Loading OCEL data..." fullPage />
        </div>
      )}

      {/* Entry panels */}
      {!summary && !eventLogId && !discoverLoading && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Upload OCEL */}
          <div className="card p-4">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Upload OCEL File</h2>
            <OcelDropZone onFile={handleUpload} loading={uploadLoading} />
          </div>

          {/* Convert from event log */}
          <div className="card p-4">
            <h2 className="mb-3 text-[13px] font-semibold text-fg">Convert from Event Log</h2>

            {/* Event log selector */}
            <div className="mb-3">
              <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">Event Log</label>
              <div className="relative" ref={eventLogDropdownRef}>
                <button
                  type="button"
                  onClick={() => setEventLogDropdownOpen((o) => !o)}
                  disabled={eventLogsLoading}
                  className="flex w-full items-center justify-between rounded-md border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-fg-secondary transition-colors hover:border-accent/50 focus:outline-none disabled:opacity-50"
                >
                  <span className={clsx('truncate', !selectedLog && 'text-fg-muted')}>
                    {eventLogsLoading
                      ? 'Loading event logs…'
                      : selectedLog
                        ? selectedLog.name
                        : 'Select an event log'}
                  </span>
                  <ChevronDown
                    size={12}
                    className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', eventLogDropdownOpen && 'rotate-180')}
                  />
                </button>
                {eventLogDropdownOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full animate-fade-in overflow-y-auto rounded-md border border-line bg-surface-2 py-1 shadow-xl">
                    {allEventLogs.length === 0 ? (
                      <p className="px-3 py-2 text-[11px] text-fg-faint">No event logs found</p>
                    ) : (
                      allEventLogs.map((log) => (
                        <button
                          key={log.id}
                          type="button"
                          onClick={() => {
                            setSelectedEventLogId(log.id);
                            setSelectedColumns([]);
                            setEventLogDropdownOpen(false);
                          }}
                          className={clsx(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-tint',
                            log.id === selectedEventLogId ? 'text-accent' : 'text-fg-secondary',
                          )}
                        >
                          {log.id === selectedEventLogId && <Check size={11} className="shrink-0" />}
                          <span className="truncate">{log.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Column multi-select */}
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-medium text-fg-muted">
                Object Type Columns
              </label>
              <MultiSelect
                options={columnOptions}
                selected={selectedColumns}
                onChange={setSelectedColumns}
                placeholder={selectedLog ? 'Select columns…' : 'Select an event log first'}
              />
              <p className="mt-1 text-[10px] text-fg-faint">
                Each selected column becomes an object type in the OCEL.
              </p>
            </div>

            <button
              onClick={handleConvert}
              disabled={!selectedEventLogId || selectedColumns.length === 0 || convertLoading}
              className="btn-primary w-full"
            >
              {convertLoading ? (
                <span className="flex items-center gap-2">
                  <RefreshCw size={13} className="animate-spin" />
                  Converting…
                </span>
              ) : (
                'Convert to OCEL'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {summary && (
        <div className="flex flex-col gap-4">
          {/* Summary + actions */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <SummaryCards summary={summary} />
            </div>
            <button
              onClick={() => { setSummary(null); setDfg(null); setPageTab('overview'); }}
              className="btn-ghost mt-1 shrink-0 text-[11px]"
            >
              <X size={13} />
              Reset
            </button>
          </div>

          {/* ── OCEL Insights ─────────────────────────────────────────────── */}
          <OCELInsightsPanel ocelId={summary.ocel_id} />

          {/* ── Page tab bar + Ask AI ───────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-1 p-1 w-fit">
              {([
                { id: 'overview', label: 'Overview', icon: Boxes },
                { id: 'analysis', label: 'Analysis', icon: BarChart3 },
                { id: 'improvements', label: 'Improvements', icon: Sparkles },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPageTab(t.id)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium transition-colors',
                    pageTab === t.id
                      ? 'bg-accent text-white'
                      : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                  )}
                >
                  <t.icon size={12} />
                  {t.label}
                </button>
              ))}
            </div>

            {/* Ask AI lives next to the page tabs because, like the
                tabs, it is scoped to the current OCEL. The floating
                chat panel opens with a prefilled question about the
                log the operator is looking at. */}
            <button
              onClick={() =>
                useUIStore.getState().askAI(
                  `What are the most important findings for this OCEL log across its ${summary.object_types.length} object types?`,
                )
              }
              className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent px-3 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent/90"
              title="Ask AI about this OCEL log"
              data-tour="ask-ai"
            >
              <Sparkles size={12} />
              Ask AI
            </button>
          </div>

          {/* ── Overview tab ──────────────────────────────────────────────── */}
          {pageTab === 'overview' && (
            <>
              {/* Per-Object-Type Analysis (flatten) — clicking a type
                  flattens the OCEL into a standard log for that type and
                  opens its full process view. */}
              <div className="card p-4">
                <h3 className="mb-1 text-[13px] font-semibold text-fg">
                  Analyze by Object Type
                </h3>
                <p className="mb-3 text-[11px] text-fg-muted">
                  Select an object type to open its process view with full analysis — process map,
                  variants, bottlenecks, conformance, 13+ analysis algorithms, and more.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {summary.object_types.map((type) => {
                    const color = getTypeColor(summary.object_types, type);
                    const count = summary.objects_per_type?.[type] ?? 0;
                    return (
                      <button
                        key={type}
                        onClick={() => handleFlatten(type)}
                        className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-fg">{type}</p>
                          <p className="text-[10px] text-fg-muted">{count.toLocaleString()} objects</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* OC-DFG Graph */}
              <div className="card overflow-hidden" style={{ height: '480px' }}>
                {discoverLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <LoadingSpinner size="lg" text="Discovering OC-DFG…" />
                  </div>
                ) : dfg ? (
                  <OCDFGGraph data={dfg} summary={summary} />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="text-center">
                      <Boxes size={36} className="mx-auto mb-2 text-fg-ghost" />
                      <p className="text-[12px] text-fg-muted">OC-DFG not available</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── OCEL-Native Analysis Panels (existing 3) ──────────────── */}
              <AnalysisSection
                ocelId={summary.ocel_id}
                objectTypes={summary.object_types}
              />
            </>
          )}

          {/* ── Analysis tab ──────────────────────────────────────────────── */}
          {pageTab === 'analysis' && (
            <NativeAnalysisHub
              ocelId={summary.ocel_id}
              objectTypes={summary.object_types}
            />
          )}

          {/* ── Improvements tab ──────────────────────────────────────────── */}
          {pageTab === 'improvements' && (
            <ImprovementReport ocelId={summary.ocel_id} />
          )}
        </div>
      )}
    </div>
  );
}
