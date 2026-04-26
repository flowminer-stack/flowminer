import { useState, useRef, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { type Core } from 'cytoscape';
import {
  ArrowLeft,
  Activity,
  Clock,
  BarChart3,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Search,
  Play,
  X,
  ChevronDown,
  FileCode2,
  ScatterChart,
  Network,
  Repeat,
  GitCompareArrows,
  Map,
  Table2,
  FlaskConical,
  Leaf,
  Film,
  Filter,
  Wand2,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';
import { useEventLogData, useProcessMap } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ProcessMap from '@/components/ProcessMap/ProcessMap';
import MapToolbar from '@/components/ProcessMap/MapToolbar';
import NodeContextMenu from '@/components/ProcessMap/NodeContextMenu';
import CommentThread from '@/components/ProcessMap/CommentThread';
import ActivityTreemapDrawer from '@/components/ProcessMap/ActivityTreemapDrawer';
import LogVersionTree from '@/components/EventLog/LogVersionTree';
import FilterChipBar from '@/components/Filters/FilterChipBar';
import FilterExpressionBar from '@/components/Filters/FilterExpressionBar';
import { useFilterStore } from '@/store/filterStore';
import { useFilterUrlSync } from '@/hooks/useFilterUrlSync';
import type { ProcessNode } from '@/types';
import CaseExplorer from '@/components/CaseExplorer/CaseExplorer';
import AnimationController from '@/components/ProcessMap/AnimationController';
import BPMNViewer from '@/components/BPMNViewer/BPMNViewer';
import ActivityDetailModal from '@/components/ActivityDetail/ActivityDetailModal';
import EdgeDetailModal from '@/components/ProcessMap/EdgeDetailModal';
import HappyPathView from '@/components/ProcessMap/HappyPathView';
import DataQualityCard from '@/components/DataQuality/DataQualityCard';
import AnalysisHub, { ANALYSIS_ITEMS } from '@/components/AnalysisHub/AnalysisHub';
import InsightsPanel from '@/components/InsightsPanel/InsightsPanel';
import FilterPanel from '@/components/ProcessMap/FilterPanel';
import ComplexityScoreBadge from '@/components/ProcessMap/ComplexityScoreBadge';
import { mining as miningApi } from '@/api/client';
import { useUIStore } from '@/store';
import type { ProcessFilter } from '@/types';

type Tab = 'map' | 'happy_path' | 'bpmn' | 'cases' | 'analysis';
type Algorithm = 'dfg' | 'alpha' | 'heuristic' | 'inductive' | 'split_miner';

const algorithmOptions: { value: Algorithm; label: string; short: string }[] = [
  { value: 'dfg', label: 'Directly-Follows Graph', short: 'DFG' },
  { value: 'alpha', label: 'Alpha Miner', short: 'Alpha' },
  { value: 'heuristic', label: 'Heuristic Miner', short: 'Heuristic' },
  { value: 'inductive', label: 'Inductive Miner', short: 'Inductive' },
  { value: 'split_miner', label: 'Split Miner', short: 'Split' },
];

const detailLevels = [
  { label: 'Simple', value: 20 },
  { label: 'Low', value: 40 },
  { label: 'Medium', value: 60 },
  { label: 'High', value: 80 },
  { label: 'Full', value: 100 },
];

// Use LucideIcon type directly from the imports
import type { LucideIcon } from 'lucide-react';

type AnalysisItem = {
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
};

type AnalysisGroup = {
  label: string;
  items: AnalysisItem[];
};

const analysisGroups: AnalysisGroup[] = [
  {
    label: 'Performance',
    items: [
      { label: 'Bottlenecks', description: 'Slowest activities & queues', icon: AlertTriangle, path: 'bottlenecks' },
      { label: 'Rework', description: 'Repeated activities per case', icon: Repeat, path: 'rework' },
      { label: 'Root Cause', description: 'Attributes driving slow cases', icon: Search, path: 'root-cause' },
    ],
  },
  {
    label: 'Behavior',
    items: [
      { label: 'Variants', description: 'Unique process paths', icon: GitBranch, path: 'variants' },
      { label: 'Conformance', description: 'Fitness & precision checks', icon: CheckCircle2, path: 'conformance' },
      { label: 'Dotted Chart', description: 'Events plotted over time', icon: ScatterChart, path: 'dotted-chart' },
    ],
  },
  {
    label: 'Organization',
    items: [
      { label: 'Social Network', description: 'Resource handover graph', icon: Network, path: 'social-network' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Simulate', description: 'What-if modifications', icon: FlaskConical, path: 'simulate' },
      { label: 'Animation', description: 'Replay cases on the map', icon: Film, path: 'animation' },
      { label: 'Compare', description: 'Diff two time periods', icon: GitCompareArrows, path: 'comparison' },
      { label: 'Sustainability', description: 'CO₂ & ESG footprint', icon: Leaf, path: 'sustainability' },
    ],
  },
];

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '--';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/* ── Deep Analyses dropdown ───────────────────────────────────────────── */

interface AnalysisDropdownProps {
  eventLogId: string;
}

function AnalysisDropdown({ eventLogId }: AnalysisDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all duration-100',
          open
            ? 'bg-accent/10 text-accent'
            : 'btn-secondary',
        )}
      >
        <BarChart3 size={13} />
        Deep analyses
        <ChevronDown size={11} className={clsx('transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[780px] max-w-[calc(100vw-2rem)] animate-fade-in rounded-xl border border-line bg-surface-2 p-3 z-50"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="grid grid-cols-3 gap-3">
            {/* Left two-thirds: standalone analyses */}
            <div className="col-span-2">
              <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                Standalone analyses
              </p>
              <div className="grid grid-cols-2 gap-3">
                {analysisGroups.map((group) => (
                  <div key={group.label}>
                    <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                      {group.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((item) => (
                        <Link
                          key={item.path}
                          to={`/${item.path}/${eventLogId}`}
                          onClick={() => setOpen(false)}
                          className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-tint"
                        >
                          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10">
                            <item.icon size={12} className="text-accent" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-semibold text-fg leading-tight">{item.label}</p>
                            <p className="mt-0.5 text-[11px] text-fg-muted leading-tight">{item.description}</p>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right third: AnalysisHub subviews */}
            <div className="border-l border-line pl-3">
              <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                In Analysis Hub
              </p>
              <div className="max-h-[420px] overflow-y-auto space-y-0.5">
                {ANALYSIS_ITEMS.map((item) => (
                  <Link
                    key={item.id}
                    to={`/process/${eventLogId}?tab=analysis&analysis=${item.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-tint"
                  >
                    <item.icon size={12} className="mt-0.5 shrink-0 text-fg-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-fg leading-tight">{item.label}</p>
                      <p className="mt-0.5 text-[10px] text-fg-faint leading-tight line-clamp-1">
                        {item.description}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function ProcessViewPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const navigate = useNavigate();
  const addNotification = useUIStore((s) => s.addNotification);

  const { eventLog, loading: eventLogLoading } = useEventLogData(eventLogId);
  const [algorithm, setAlgorithm] = useState<Algorithm>('dfg');
  const [filters, setFilters] = useState<ProcessFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [noiseThreshold, setNoiseThreshold] = useState(0.0);
  const stableFilters = useMemo(() => filters, [JSON.stringify(filters)]);
  const hasFilters = Object.keys(filters).length > 0;
  // Only send threshold param when it's non-zero and algorithm supports it
  const supportsNoise = algorithm === 'inductive' || algorithm === 'heuristic';
  const stableParams = useMemo(
    () => (supportsNoise && noiseThreshold > 0 ? { threshold: noiseThreshold } : undefined),
    [supportsNoise, noiseThreshold],
  );
  const { discovery, loading: mapLoading, refetch } = useProcessMap(eventLogId, algorithm, hasFilters ? stableFilters : undefined, stableParams);

  const gatewayCount = useMemo(() => {
    if (!discovery?.nodes || !discovery?.edges) return 0;
    const inDeg: Record<string, number> = {};
    const outDeg: Record<string, number> = {};
    discovery.edges.forEach((e) => {
      outDeg[e.source] = (outDeg[e.source] ?? 0) + 1;
      inDeg[e.target] = (inDeg[e.target] ?? 0) + 1;
    });
    return discovery.nodes.filter((n) => (inDeg[n.id] ?? 0) > 1 || (outDeg[n.id] ?? 0) > 1).length;
  }, [discovery]);

  const [searchParams] = useSearchParams();
  const urlTab = (searchParams.get('tab') as Tab) || 'map';
  const initialAnalysisId = searchParams.get('analysis') ?? undefined;
  const [tab, setTab] = useState<Tab>(urlTab);

  // Sync tab + analysis selection when URL search params change.
  useEffect(() => {
    setTab(urlTab);
  }, [urlTab]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [complexity, setComplexity] = useState(80);
  const [cleanView, setCleanView] = useState(false);
  const [autoSimplifiedForLogId, setAutoSimplifiedForLogId] = useState<string | null>(null);
  const [mapLayout, setMapLayout] = useState<'dagre' | 'breadthfirst' | 'circle' | 'concentric' | 'grid'>('dagre');
  const [animationOpen, setAnimationOpen] = useState(false);
  const [activityDetailOpen, setActivityDetailOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<{ source: string; target: string } | null>(null);

  // ── Competitive UX state ─────────────────────────────────────────
  const [labelMode, setLabelMode] = useState<'absolute' | 'relative'>('absolute');
  const [highlightSlow, setHighlightSlow] = useState(false);
  const [hiddenActivities, setHiddenActivities] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ node: ProcessNode; x: number; y: number } | null>(null);
  const [treemapActivity, setTreemapActivity] = useState<string | null>(null);
  const addChip = useFilterStore((s) => s.addChip);
  useFilterUrlSync(eventLogId);

  const cyRef = useRef<Core | null>(null);

  const handleAlgorithmChange = (algo: Algorithm) => {
    setAlgorithm(algo);
    setNoiseThreshold(0.0);
    refetch(algo);
  };

  const handleExportReport = async () => {
    if (!eventLogId) return;
    setExportingReport(true);
    try {
      const result = await miningApi.getReport(eventLogId);
      // Render via blob URL + noopener window so any HTML the server
      // built from user-supplied activity names / log names cannot
      // reach back into the main app origin (which holds the JWT in
      // localStorage). Previously we used `document.write` on a
      // same-origin new window, which let crafted event-log data XSS
      // the report viewer and exfiltrate the token.
      const blob = new Blob([result.html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
      if (!win) {
        URL.revokeObjectURL(blobUrl);
        addNotification({
          type: 'error',
          title: 'Pop-up blocked — enable pop-ups to export the report',
        });
      } else {
        // Clean up the blob URL after a grace period so it doesn't
        // linger indefinitely. 60 s is long enough for the window
        // to finish loading and trigger print.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      }
    } catch {
      addNotification({ type: 'error', title: 'Failed to generate report' });
    } finally {
      setExportingReport(false);
    }
  };

  // Compute an optimal complexity level for Clean View based on edge count.
  // Spaghetti-map intensity grows fast — a log with 200 edges is unreadable
  // even at 50% detail. The curve below keeps visible edges ≤ ~40.
  const computeCleanComplexity = (edgeCount: number): number => {
    if (edgeCount <= 30) return 100;
    if (edgeCount <= 60) return 70;
    if (edgeCount <= 120) return 40;
    if (edgeCount <= 250) return 25;
    return Math.max(10, Math.round((40 / edgeCount) * 100));
  };

  // Auto-enable Clean View on first load for large graphs so users don't
  // stare at a spaghetti ball. Only fires once per event log.
  useEffect(() => {
    if (!discovery || !eventLogId) return;
    if (autoSimplifiedForLogId === eventLogId) return;
    if (discovery.edges.length > 80) {
      const c = computeCleanComplexity(discovery.edges.length);
      setComplexity(c);
      setCleanView(true);
    }
    setAutoSimplifiedForLogId(eventLogId);
  }, [discovery, eventLogId, autoSimplifiedForLogId]);

  const applyCleanView = () => {
    if (!discovery) return;
    const c = computeCleanComplexity(discovery.edges.length);
    setComplexity(c);
    setCleanView(true);
  };

  const exitCleanView = () => {
    setCleanView(false);
    setComplexity(100);
  };

  // Visible node/edge counts
  const visibleCounts = (() => {
    if (!discovery) return { nodes: 0, edges: 0 };
    const { nodes: n, edges: e } = discovery;
    const startIds = new Set(n.filter((x) => x.is_start).map((x) => x.id));
    const endIds = new Set(n.filter((x) => x.is_end).map((x) => x.id));
    const backbone: typeof e = [];
    const other: typeof e = [];
    for (const edge of e) {
      if (startIds.has(edge.source) || startIds.has(edge.target) ||
          endIds.has(edge.source) || endIds.has(edge.target)) {
        backbone.push(edge);
      } else {
        other.push(edge);
      }
    }
    const sorted = [...other].sort((a, b) => b.frequency - a.frequency);
    const count = Math.max(0, Math.ceil((complexity / 100) * sorted.length));
    const all = [...backbone, ...sorted.slice(0, count)];
    const nodeIds = new Set<string>();
    for (const edge of all) { nodeIds.add(edge.source); nodeIds.add(edge.target); }
    for (const id of startIds) nodeIds.add(id);
    for (const id of endIds) nodeIds.add(id);
    return { nodes: nodeIds.size, edges: all.length };
  })();

  if (eventLogLoading) {
    return <LoadingSpinner size="lg" text="Loading event log..." fullPage />;
  }

  if (!eventLog) {
    return (
      <div className="rounded-xl border border-dashed border-line p-12 text-center">
        <FileCode2 size={28} className="mx-auto text-fg-ghost" />
        <p className="mt-3 text-[13px] font-medium text-fg">Event log not found</p>
        <p className="mt-1 text-[12px] text-fg-muted">It may have been deleted or you may not have access.</p>
        <button onClick={() => navigate('/projects')} className="btn-secondary mt-4 text-[12px]">
          Back to projects
        </button>
      </div>
    );
  }

  const selectedNodeData = discovery?.nodes.find((n) => n.id === selectedNode);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      {/* ── Top bar: back + title + tabs + analysis ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        <button
          onClick={() => navigate(-1)}
          className="btn-ghost p-1.5 shrink-0"
        >
          <ArrowLeft size={15} />
        </button>

        {/* Title + stats */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-bold tracking-tight text-fg">
            {eventLog.name}
          </h1>
          <div className="flex items-center gap-1.5 text-[11px] text-fg-muted mt-0.5">
            <span>{eventLog.total_cases.toLocaleString()} cases</span>
            <span className="text-fg-ghost">·</span>
            <span>{eventLog.total_events.toLocaleString()} events</span>
            <span className="text-fg-ghost">·</span>
            <span>{eventLog.total_activities} activities</span>
          </div>
        </div>

        {/* View tabs */}
        <div className="flex rounded-lg border border-line bg-surface-1 p-0.5 gap-0.5" style={{ boxShadow: 'var(--shadow-xs)' }}>
          {[
            { id: 'map' as Tab, label: 'Map', icon: Map },
            { id: 'happy_path' as Tab, label: 'Happy Path', icon: GitBranch },
            { id: 'bpmn' as Tab, label: 'BPMN', icon: FileCode2 },
            { id: 'cases' as Tab, label: 'Cases', icon: Table2 },
            { id: 'analysis' as Tab, label: 'Analysis', icon: BarChart3 },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-all duration-100',
                tab === t.id
                  ? 'bg-surface-2 text-fg shadow-sm'
                  : 'text-fg-muted hover:bg-surface-3/60 hover:text-fg',
              )}
              style={tab === t.id ? { boxShadow: 'var(--shadow-xs)' } : undefined}
            >
              <t.icon size={12} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Quality panel toggle */}
        <button
          onClick={() => setQualityOpen((o) => !o)}
          className={clsx(
            'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors',
            qualityOpen ? 'bg-accent/10 text-accent' : 'btn-secondary',
          )}
          title="Data quality report"
        >
          <CheckCircle2 size={13} />
          Quality
        </button>

        {/* Report */}
        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="btn-secondary text-[12px]"
          title="Generate PDF report"
        >
          {exportingReport ? (
            <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg-secondary" />
          ) : (
            <FileCode2 size={13} />
          )}
          Report
        </button>

        {/* Ask AI — scoped to the current event log. Placed next to
            Quality and Report because all three are per-log actions. */}
        <button
          onClick={() => useUIStore.getState().toggleAiChat()}
          className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent/90"
          title="Ask AI about this event log"
          data-tour="ask-ai"
        >
          <Sparkles size={13} />
          Ask AI
        </button>

        {/* Analysis dropdown */}
        <AnalysisDropdown eventLogId={eventLogId!} />
      </div>

      {/* ── Data Quality panel ──────────────────────────────────────────── */}
      {qualityOpen && eventLogId && (
        <div className="mt-3 overflow-y-auto rounded-lg border border-line bg-surface-2 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-fg">Data Quality</span>
            <button
              onClick={() => setQualityOpen(false)}
              className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
            >
              <X size={13} />
            </button>
          </div>
          <DataQualityCard eventLogId={eventLogId} />
        </div>
      )}

      {/* ── Insights panel (map tab only) ───────────────────────────────── */}
      {tab === 'map' && eventLogId && discovery && (
        <InsightsPanel eventLogId={eventLogId} />
      )}

      {/* ── Cases tab ───────────────────────────────────────────────────── */}
      {tab === 'cases' && eventLogId && (
        <div className="mt-3 flex-1 overflow-hidden">
          <CaseExplorer
            eventLogId={eventLogId}
            isOpen={true}
            onClose={() => setTab('map')}
            embedded
          />
        </div>
      )}

      {/* ── Happy Path tab ─────────────────────────────────────────────── */}
      {tab === 'happy_path' && eventLogId && (
        <div className="mt-3 flex-1 overflow-hidden rounded-lg border border-line bg-surface-2">
          <HappyPathView eventLogId={eventLogId} />
        </div>
      )}

      {/* ── BPMN tab ────────────────────────────────────────────────────── */}
      {tab === 'bpmn' && eventLogId && (
        <div className="mt-3 flex-1 overflow-hidden rounded-lg border border-line bg-surface-2">
          <BPMNViewer eventLogId={eventLogId} />
        </div>
      )}

      {/* ── Analysis Hub tab ────────────────────────────────────────────── */}
      {tab === 'analysis' && eventLogId && (
        <AnalysisHub eventLogId={eventLogId} initialAnalysisId={initialAnalysisId} />
      )}

      {/* ── Process Map tab ─────────────────────────────────────────────── */}
      {tab === 'map' && (
        <>
          {/* Control strip */}
          <div className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2" style={{ boxShadow: 'var(--shadow-xs)' }}>
            <div className="flex flex-wrap items-center gap-2 md:gap-3">

              {/* Algorithm group */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-fg-faint w-8 shrink-0">Algo</span>
                <div className="segment-group">
                  {algorithmOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleAlgorithmChange(opt.value)}
                      title={opt.label}
                      className={clsx('segment-btn', algorithm === opt.value && 'segment-btn-active')}
                    >
                      {opt.short}
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-4 w-px bg-line hidden sm:block" />

              {/* Detail group */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-fg-faint w-10 shrink-0">Detail</span>
                <div className="segment-group">
                  {detailLevels.map((step) => (
                    <button
                      key={step.value}
                      onClick={() => { setComplexity(step.value); setCleanView(false); }}
                      className={clsx('segment-btn', !cleanView && complexity === step.value && 'segment-btn-active')}
                    >
                      {step.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={cleanView ? exitCleanView : applyCleanView}
                  className={clsx(
                    'flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all duration-100',
                    cleanView
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-line bg-surface-1 text-fg-muted hover:border-line-strong hover:text-fg',
                  )}
                  title={cleanView ? 'Exit Clean view' : 'Auto-simplify the map'}
                >
                  <Wand2 size={11} />
                  Clean
                </button>
                <span className="text-[10px] tabular-nums text-fg-faint hidden sm:inline">
                  {visibleCounts.nodes}N · {visibleCounts.edges}E
                </span>
                {discovery && (
                  <ComplexityScoreBadge
                    activityCount={discovery.nodes.length}
                    edgeCount={discovery.edges.length}
                    gatewayCount={gatewayCount}
                  />
                )}
              </div>

              {/* Noise filter — inductive / heuristic only */}
              {supportsNoise && (
                <>
                  <div className="h-4 w-px bg-line hidden sm:block" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-fg-faint w-10 shrink-0">Noise</span>
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.05}
                      value={noiseThreshold}
                      onChange={(e) => setNoiseThreshold(parseFloat(e.target.value))}
                      className="w-24 accent-accent cursor-pointer"
                      title={`Noise filter threshold: ${(noiseThreshold * 100).toFixed(0)}% — filters infrequent edges from the model`}
                    />
                    <span className="text-[10px] tabular-nums text-fg-faint w-6">{(noiseThreshold * 100).toFixed(0)}%</span>
                  </div>
                </>
              )}

              <div className="h-4 w-px bg-line hidden md:block" />

              {/* Layout group */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-fg-faint w-12 shrink-0 hidden md:inline">Layout</span>
                <div className="segment-group">
                  {(['dagre', 'breadthfirst', 'circle', 'concentric', 'grid'] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => setMapLayout(l)}
                      className={clsx('segment-btn', mapLayout === l && 'segment-btn-active')}
                    >
                      {l === 'dagre' ? 'Hierarchy' : l === 'breadthfirst' ? 'Tree' : l.charAt(0).toUpperCase() + l.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Actions */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setFilterOpen((o) => !o)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-all duration-100',
                    filterOpen || hasFilters
                      ? 'bg-accent/10 text-accent'
                      : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  <Filter size={12} />
                  Filter
                  {hasFilters && (
                    <span className="rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-bold text-accent">
                      {Object.keys(filters).length}
                    </span>
                  )}
                </button>

                {discovery && (
                  <button
                    onClick={() => setAnimationOpen((o) => !o)}
                    className={clsx(
                      'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-all duration-100',
                      animationOpen
                        ? 'bg-accent/10 text-accent'
                        : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                    )}
                  >
                    <Play size={12} />
                    Replay
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Map + side panel */}
          <div className="mt-2 flex flex-1 flex-col md:flex-row gap-3 overflow-hidden min-h-[400px]">
            {/* Filter panel (left sidebar) */}
            {filterOpen && eventLogId && (
              <div className="w-full md:w-56 shrink-0 max-h-64 md:max-h-none overflow-hidden rounded-xl border border-line bg-surface-1" style={{ boxShadow: 'var(--shadow-sm)' }}>
                <FilterPanel eventLogId={eventLogId} filters={filters} onChange={setFilters} />
              </div>
            )}

            {/* Process map */}
            <div className="flex flex-col flex-1 overflow-hidden rounded-xl border border-line bg-surface-2" style={{ boxShadow: 'var(--shadow-sm)' }}>
              <div className="relative flex-1 overflow-hidden">
                {mapLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <LoadingSpinner size="lg" text="Discovering process model..." />
                  </div>
                ) : discovery ? (
                  <div className="flex h-full flex-col">
                    {/* Map toolbar: abs/rel toggle, highlight-slow,
                        hide-events panel. Renders above the map so
                        users can flip display modes without losing
                        the current viewport. */}
                    <div className="flex items-center gap-2 border-b border-line bg-surface-1/50 px-2 py-1.5">
                      <MapToolbar
                        nodes={discovery.nodes}
                        labelMode={labelMode}
                        setLabelMode={setLabelMode}
                        highlightSlow={highlightSlow}
                        setHighlightSlow={setHighlightSlow}
                        hiddenActivities={hiddenActivities}
                        setHiddenActivities={setHiddenActivities}
                      />
                    </div>
                    {/* Apromore-style filter expression bar + chip
                        breadcrumb. The expression bar parses a small
                        DSL on the backend and pushes matching cases
                        into the shared filter store as a chip. */}
                    {eventLogId && (
                      <div className="mx-2 mt-1.5">
                        <FilterExpressionBar eventLogId={eventLogId} />
                      </div>
                    )}
                    <FilterChipBar
                      className="mx-2 mt-1.5"
                      eventLogId={eventLogId ?? undefined}
                      attributeColumns={eventLog?.additional_columns ?? []}
                    />
                    <div className="flex-1">
                      <ProcessMap
                        nodes={discovery.nodes}
                        edges={discovery.edges}
                        complexity={complexity}
                        layoutName={mapLayout}
                        labelMode={labelMode}
                        highlightSlow={highlightSlow}
                        hiddenActivities={hiddenActivities}
                        onNodeClick={(node) => {
                          setSelectedNode(node.id);
                          setActivityDetailOpen(true);
                        }}
                        onAddActivityFilter={(activity) =>
                          addChip({
                            type: 'activity',
                            label: `activity: ${activity}`,
                            payload: { activity },
                          })
                        }
                        onContextMenu={(node, pos) =>
                          setContextMenu({ node, x: pos.x, y: pos.y })
                        }
                        onEdgeClick={(edge) =>
                          setSelectedEdge({ source: edge.source, target: edge.target })
                        }
                        selectedNode={selectedNode ?? undefined}
                        cyRef={cyRef}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center">
                    <Activity size={36} className="mb-2 text-fg-ghost" />
                    <p className="text-[12px] text-fg-muted">Select an algorithm to discover the process</p>
                  </div>
                )}
              </div>

              {/* Animation bar */}
              {animationOpen && discovery && eventLogId && (
                <div className="relative">
                  <button
                    onClick={() => setAnimationOpen(false)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded p-1 text-fg-muted hover:bg-tint hover:text-fg transition-colors"
                  >
                    <X size={11} />
                  </button>
                  <AnimationController
                    eventLogId={eventLogId}
                    cyRef={cyRef}
                    isReady={!!cyRef.current}
                  />
                </div>
              )}
            </div>

            {/* Right panel: node details */}
            <div className="card w-full md:w-64 shrink-0 overflow-y-auto" style={{ boxShadow: 'var(--shadow-sm)' }}>
              {selectedNodeData ? (
                <div className="p-3.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-fg">{selectedNodeData.label}</h3>
                    <div className="flex gap-1">
                      {selectedNodeData.is_start && <span className="badge badge-emerald">Start</span>}
                      {selectedNodeData.is_end && <span className="badge badge-rose">End</span>}
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    {[
                      { icon: BarChart3, label: 'Frequency', value: selectedNodeData.frequency.toLocaleString() },
                      { icon: Clock, label: 'Avg Duration', value: formatDuration(selectedNodeData.avg_duration) },
                      { icon: Clock, label: 'Med Duration', value: formatDuration(selectedNodeData.median_duration) },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                          <row.icon size={12} />
                          {row.label}
                        </span>
                        <span className="text-[11px] font-medium tabular-nums text-fg">{row.value}</span>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => setActivityDetailOpen(true)}
                    className="btn-secondary mt-3 w-full text-[11px]"
                  >
                    Reopen details
                  </button>
                  <button
                    onClick={() => setSelectedNode(null)}
                    className="mt-1.5 w-full text-center text-[11px] text-fg-faint hover:text-fg-muted transition-colors"
                  >
                    Clear selection
                  </button>
                  {/* Signavio-style threaded comments anchored to the
                      selected activity. Uses the existing annotations
                      API; empty by default, any team member with
                      access can post. */}
                  {eventLogId && eventLog?.project_id && (
                    <CommentThread
                      eventLogId={eventLogId}
                      projectId={eventLog.project_id}
                      activityName={selectedNodeData.label}
                    />
                  )}
                </div>
              ) : (
                <div className="p-3.5">
                  {/* Apromore-style log version tree — snapshot and
                      branch filter sets. Shown whenever no node is
                      selected so it doesn't clutter the activity view. */}
                  {eventLogId && (
                    <div className="mb-3">
                      <LogVersionTree eventLogId={eventLogId} />
                    </div>
                  )}
                  <h3 className="text-[12px] font-semibold text-fg-secondary mb-3">Process Summary</h3>
                  {discovery ? (
                    <div className="space-y-2">
                      {[
                        { label: 'Activities', value: discovery.nodes.length },
                        { label: 'Transitions', value: discovery.edges.length },
                        { label: 'Algorithm', value: algorithm.toUpperCase(), isBadge: true },
                        ...(Array.isArray((discovery.statistics as Record<string, unknown>)?.concurrent_pairs) && ((discovery.statistics as Record<string, unknown>).concurrent_pairs as unknown[]).length > 0
                          ? [{ label: 'Parallel pairs', value: `${((discovery.statistics as Record<string, unknown>).concurrent_pairs as unknown[]).length} detected` }]
                          : []),
                      ].map((row) => (
                        <div key={row.label} className="flex items-center justify-between">
                          <span className="text-[11px] text-fg-muted">{row.label}</span>
                          {'isBadge' in row ? (
                            <span className="badge badge-accent">{row.value}</span>
                          ) : (
                            <span className="text-[11px] font-medium tabular-nums text-fg">{String(row.value)}</span>
                          )}
                        </div>
                      ))}
                      <div className="border-t border-line pt-2 mt-2">
                        <p className="text-[11px] text-fg-faint">Click a node to inspect it.</p>
                      </div>
                    </div>
                  ) : !mapLoading ? (
                    <p className="text-[11px] text-fg-faint">Run a discovery algorithm to see details.</p>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Activity detail modal */}
      {eventLogId && selectedNode && (
        <ActivityDetailModal
          eventLogId={eventLogId}
          activityName={selectedNode}
          isOpen={activityDetailOpen}
          onClose={() => setActivityDetailOpen(false)}
        />
      )}

      {/* Edge detail modal */}
      {eventLogId && selectedEdge && (
        <EdgeDetailModal
          eventLogId={eventLogId}
          source={selectedEdge.source}
          target={selectedEdge.target}
          open={!!selectedEdge}
          onClose={() => setSelectedEdge(null)}
          onFilterWith={() =>
            setFilters((prev) => ({
              ...prev,
              required_edges: [
                ...(prev.required_edges ?? []),
                [selectedEdge.source, selectedEdge.target],
              ],
            }))
          }
          onFilterWithout={() =>
            setFilters((prev) => ({
              ...prev,
              forbidden_edges: [
                ...(prev.forbidden_edges ?? []),
                [selectedEdge.source, selectedEdge.target],
              ],
            }))
          }
        />
      )}
      {contextMenu && (
        <NodeContextMenu
          node={contextMenu.node}
          pos={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onIncludeActivity={(activity) =>
            addChip({
              type: 'activity',
              label: `activity: ${activity}`,
              payload: { activity },
            })
          }
          onExcludeActivity={(activity) =>
            addChip({
              type: 'activity_exclude',
              label: `exclude: ${activity}`,
              payload: { activity },
            })
          }
          onFocusActivity={(activity) => {
            addChip({
              type: 'activity',
              label: `focus: ${activity}`,
              payload: { activity },
            });
          }}
          onShowDetails={(node) => {
            setSelectedNode(node.id);
            setActivityDetailOpen(true);
          }}
          onShowTreemap={(activity) => setTreemapActivity(activity)}
        />
      )}
      {treemapActivity && eventLogId && (
        <ActivityTreemapDrawer
          eventLogId={eventLogId}
          activity={treemapActivity}
          onClose={() => setTreemapActivity(null)}
        />
      )}
    </div>
  );
}
