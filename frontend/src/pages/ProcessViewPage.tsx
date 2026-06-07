import { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { type Core } from 'cytoscape';
import {
  ArrowLeft,
  Activity,
  Clock,
  BarChart3,
  GitBranch,
  CheckCircle2,
  Play,
  X,
  FileCode2,
  Map,
  Table2,
  Filter,
  Wand2,
  Sparkles,
  HelpCircle,
  Building2,
  Code2,
  FileDown,
  Search,
  Layers,
} from 'lucide-react';
import clsx from 'clsx';
import { useEventLogData, useProcessMap } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Markdown from '@/components/common/Markdown';
import ProcessMap from '@/components/ProcessMap/ProcessMap';
// Lazy so three.js (the WebGL chunk) only loads when the City tab is shown —
// small logs that open on the 2D map never pay for it.
const ProcessCityCanvas = lazy(() => import('@/components/ProcessMap/ProcessCityCanvas'));
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
import AnalysisHub from '@/components/AnalysisHub/AnalysisHub';
import InsightsPanel from '@/components/InsightsPanel/InsightsPanel';
import FilterPanel from '@/components/ProcessMap/FilterPanel';
import ComplexityScoreBadge from '@/components/ProcessMap/ComplexityScoreBadge';
import AnalysisPalette from '@/components/ProcessMap/AnalysisPalette';
import ExportWorkflowModal from '@/components/Scorecards/ExportWorkflowModal';
import { algorithmOptions, detailLevels, type Algorithm } from '@/components/ProcessMap/mapControlsConfig';
import { useProcessFilters } from '@/hooks/useProcessFilters';
import { mining as miningApi, ai as aiApi, competitive as competitiveApi } from '@/api/client';
import type { BpmnQResponse, HierarchyResponse } from '@/api/competitive';
import { useUIStore } from '@/store';
import { formatDuration } from '@/utils/format';
import { simplifyGraph } from '@/utils/simplifyGraph';
import { isWebGLAvailable } from '@/utils/webgl';
import type { ProcessFilter } from '@/types';

type Tab = 'map' | 'city' | 'happy_path' | 'bpmn' | 'cases' | 'analysis';

// Logs at or above this edge count land on the 3D City by default (when WebGL
// is available) instead of a 2D hairball; smaller logs open on the flat map.
const LARGE_EDGE_THRESHOLD = 80;

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

  // Finding #13 — unify the filter systems. The chip bar / DSL bar
  // write to the shared filterStore (which drives the analysis tabs),
  // while the sidebar FilterPanel drives the map via local ``filters``.
  // ``useProcessFilters`` projects the active chips into a ProcessFilter,
  // merges them with the sidebar state (so the universal chips now scope
  // the *map* too), and reflects panel-originated facets back into the
  // shared store so the analysis tabs stay in sync.
  const { stableFilters, hasFilters } = useProcessFilters(filters);
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
  const tabParam = searchParams.get('tab') as Tab | null;
  const initialAnalysisId = searchParams.get('analysis') ?? undefined;
  const [tab, setTab] = useState<Tab>(tabParam ?? 'map');

  // Only force the tab from the URL when a `?tab=` param is actually present.
  // A no-param landing is left free to default to the City view (below).
  useEffect(() => {
    if (tabParam) setTab(tabParam);
  }, [tabParam]);

  // Default large logs to the 3D City instead of a 2D hairball, once per log,
  // when WebGL is available and the user didn't request a specific tab. Decided
  // during render (guarded by a ref) so React re-renders before paint — no flash
  // of the dense flat map. Manual tab clicks afterwards are never overridden.
  const landedLogIdRef = useRef<string | null>(null);
  if (discovery && eventLogId && landedLogIdRef.current !== eventLogId) {
    landedLogIdRef.current = eventLogId;
    if (
      !tabParam &&
      tab !== 'city' &&
      discovery.edges.length >= LARGE_EDGE_THRESHOLD &&
      isWebGLAvailable()
    ) {
      setTab('city');
    }
  }
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

  // ── Export as Code (workflow engine codegen) ─────────────────────
  const [exportCodeOpen, setExportCodeOpen] = useState(false);

  // ── Download DMN (decision rules) ────────────────────────────────
  const [downloadingDmn, setDownloadingDmn] = useState(false);

  // ── Path search (bpmn-q structural query) ────────────────────────
  const [pathQuery, setPathQuery] = useState('');
  const [pathResults, setPathResults] = useState<BpmnQResponse | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);

  // ── Activity grouping (hierarchy buckets) ────────────────────────
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupPattern, setGroupPattern] = useState('');
  const [groupLabel, setGroupLabel] = useState('');
  const [groupRules, setGroupRules] = useState<{ pattern: string; bucket: string }[]>([]);
  const [groupResults, setGroupResults] = useState<HierarchyResponse | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  // ── "What does this map mean?" narration (finding #15) ────────────
  // On demand, ask the AI to read the *current* map config — algorithm,
  // noise threshold, complexity, and how many nodes/edges are actually
  // on screen — and explain in plain language what the user is looking
  // at. Rendered inline in the Process Summary panel area.
  const [narration, setNarration] = useState<string | null>(null);
  const [narrationLoading, setNarrationLoading] = useState(false);
  const [narrationError, setNarrationError] = useState<string | null>(null);
  const [narrationLlmConfigured, setNarrationLlmConfigured] = useState(true);

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

  const handleDownloadDmn = async () => {
    if (!eventLogId) return;
    setDownloadingDmn(true);
    try {
      await miningApi.downloadDecisionRulesDmn(eventLogId);
    } catch {
      addNotification({ type: 'error', title: 'Failed to export DMN' });
    } finally {
      setDownloadingDmn(false);
    }
  };

  const runPathSearch = async () => {
    if (!eventLogId) return;
    const pattern = pathQuery.trim();
    if (!pattern) return;
    setPathLoading(true);
    setPathError(null);
    try {
      const r = await competitiveApi.bpmnQ(eventLogId, pattern);
      setPathResults(r);
    } catch (e) {
      const ax = e as { response?: { data?: { detail?: string } } };
      setPathError(ax?.response?.data?.detail ?? "Pattern must be 'A -> B' (or 'A -> ?' / 'A -> <end>').");
      setPathResults(null);
    } finally {
      setPathLoading(false);
    }
  };

  const addGroupRule = () => {
    const pattern = groupPattern.trim();
    const bucket = groupLabel.trim();
    if (!pattern || !bucket) return;
    setGroupRules((prev) => [...prev, { pattern, bucket }]);
    setGroupPattern('');
    setGroupLabel('');
  };

  const runGrouping = async (rules: { pattern: string; bucket: string }[]) => {
    if (!eventLogId || rules.length === 0) return;
    setGroupLoading(true);
    setGroupError(null);
    try {
      const r = await competitiveApi.hierarchy(eventLogId, rules);
      setGroupResults(r);
    } catch (e) {
      const ax = e as { response?: { data?: { detail?: string } } };
      setGroupError(ax?.response?.data?.detail ?? 'Failed to group activities. Check your regex rules.');
      setGroupResults(null);
    } finally {
      setGroupLoading(false);
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

  // Visible node/edge counts — mirror exactly what the map renders by reusing
  // the same top-paths simplification (so the "N · E" badge is accurate).
  const visibleCounts = (() => {
    if (!discovery) return { nodes: 0, edges: 0 };
    const { nodes, edges } = simplifyGraph(discovery.nodes, discovery.edges, { complexity });
    return { nodes: nodes.length, edges: edges.length };
  })();

  const explainMap = async () => {
    if (!eventLogId) return;
    setNarrationLoading(true);
    setNarrationError(null);
    try {
      // Pass the live map context so the narration describes exactly
      // what's on screen (algorithm + noise + how aggressively the
      // complexity slider trimmed the graph), not just the raw log.
      const r = await aiApi.narrate(eventLogId, {
        algorithm,
        noise_threshold: supportsNoise ? noiseThreshold : 0,
        complexity,
        visible_nodes: visibleCounts.nodes,
        visible_edges: visibleCounts.edges,
      });
      setNarration(r.markdown);
      setNarrationLlmConfigured(r.llm_configured);
    } catch {
      setNarrationError('Could not generate an explanation. Try again.');
    } finally {
      setNarrationLoading(false);
    }
  };

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
            { id: 'city' as Tab, label: 'City', icon: Building2 },
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

        {/* Export as Code — turn the mined happy path into runnable
            orchestration code (Temporal / n8n / Airflow). Opens the
            self-contained ExportWorkflowModal. */}
        <button
          onClick={() => setExportCodeOpen(true)}
          className="btn-secondary text-[12px]"
          title="Export the mined process as runnable workflow code"
        >
          <Code2 size={13} />
          Export as Code
        </button>

        {/* Download DMN — export discovered decision rules as a DMN 1.4
            XML file for Camunda / Trisotech. Triggers a blob download. */}
        <button
          onClick={handleDownloadDmn}
          disabled={downloadingDmn}
          className="btn-secondary text-[12px]"
          title="Download discovered decision rules as a DMN 1.4 file"
        >
          {downloadingDmn ? (
            <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg-secondary" />
          ) : (
            <FileDown size={13} />
          )}
          Download DMN
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

        {/* Unified, searchable analysis palette (⌘K / Ctrl-K) */}
        {eventLogId && <AnalysisPalette eventLogId={eventLogId} />}
      </div>

      {/* Scrollable stage. The active view keeps its full viewport height; the
          Data Quality panel stacks ABOVE it, so opening Quality makes the whole
          area scroll — the view slides off-screen and reappears as you scroll
          past Quality — instead of the view being compressed. */}
      <div className="flex-1 min-h-0 overflow-y-auto">

      {/* ── Data Quality panel ──────────────────────────────────────────── */}
      {qualityOpen && eventLogId && (
        <div className="mt-3 rounded-lg border border-line bg-surface-2 p-4">
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

      {/* Fixed-height stage — keeps the active view at full viewport height so
          it never shrinks when the Quality panel is open above it. */}
      <div className="flex h-full min-h-0 flex-col">

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

      {/* ── City tab (3D Process City) ──────────────────────────────────── */}
      {tab === 'city' && eventLogId && discovery && (
        <div className="mt-3 flex-1 overflow-auto rounded-lg border border-line bg-surface-2 p-4">
          {isWebGLAvailable() ? (
            <Suspense fallback={<LoadingSpinner size="lg" text="Constructing the city…" />}>
              <ProcessCityCanvas
                nodes={discovery.nodes}
                edges={discovery.edges}
                heightClass="h-[calc(100vh-19rem)]"
              />
              <p className="mt-2 text-[11px] text-fg-faint">
                Skyline shows every activity; streets are simplified to the busiest paths. Prefer the classic flow diagram?{' '}
                <button onClick={() => setTab('map')} className="font-medium text-accent hover:underline">
                  Open the Map
                </button>
                .
              </p>
            </Suspense>
          ) : (
            <div className="flex h-[400px] flex-col items-center justify-center gap-3 text-center">
              <Building2 size={28} className="text-fg-faint" />
              <p className="max-w-sm text-[13px] text-fg-muted">
                Process City needs WebGL, which isn’t available in this browser or environment.{' '}
                <button onClick={() => setTab('map')} className="font-medium text-accent hover:underline">
                  Open the Map instead.
                </button>
              </p>
            </div>
          )}
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
                      title={opt.help}
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
                {/* Plain-language "what am I looking at?" guide for the
                    current map (finding #15). Reads the live algorithm /
                    noise / complexity context and renders the answer in
                    the Process Summary panel on the right. */}
                {discovery && (
                  <button
                    onClick={explainMap}
                    disabled={narrationLoading}
                    className={clsx(
                      'flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-all duration-100 disabled:opacity-50',
                      narration
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-line bg-surface-1 text-fg-muted hover:border-line-strong hover:text-fg',
                    )}
                    title="Ask AI to explain what this map shows, given the current algorithm, noise filter, and detail level"
                  >
                    {narrationLoading ? (
                      <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
                    ) : (
                      <HelpCircle size={11} />
                    )}
                    What does this map mean?
                  </button>
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
                {/* Path search (bpmn-q) — structural query on the DFG.
                    e.g. "Approve -> Pay", "Approve -> ?", "Pay -> <end>".
                    Results render in the right side panel. */}
                <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-1 pl-2 pr-1 py-0.5">
                  <Search size={11} className="shrink-0 text-fg-faint" />
                  <input
                    value={pathQuery}
                    onChange={(e) => setPathQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runPathSearch(); }}
                    placeholder="A -> B"
                    title="Find paths: A -> B, A -> ? (any next), A -> <end>"
                    className="w-24 bg-transparent text-[11px] text-fg placeholder:text-fg-faint focus:outline-none"
                  />
                  <button
                    onClick={runPathSearch}
                    disabled={pathLoading || !pathQuery.trim()}
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/10 disabled:opacity-40"
                  >
                    {pathLoading ? '…' : 'Find'}
                  </button>
                </div>

                {/* Group activities (hierarchy) — collapse activities into
                    higher-level buckets via regex rules. Opens an inline
                    editor; results render in the right side panel. */}
                <button
                  onClick={() => setGroupOpen((o) => !o)}
                  title="Group activities into higher-level buckets with regex rules"
                  className={clsx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-all duration-100',
                    groupOpen || groupResults
                      ? 'bg-accent/10 text-accent'
                      : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  <Layers size={12} />
                  Group activities
                  {groupRules.length > 0 && (
                    <span className="rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-bold text-accent">
                      {groupRules.length}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setFilterOpen((o) => !o)}
                  title="Detailed filter panel. Changes here scope the map and are mirrored into the universal filter chips, so the analysis tabs stay in sync."
                  className={clsx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-all duration-100',
                    filterOpen || hasFilters
                      ? 'bg-accent/10 text-accent'
                      : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  <Filter size={12} />
                  Filter
                  {Object.keys(filters).length > 0 && (
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

          {/* ── Group activities editor (hierarchy) ───────────────────── */}
          {groupOpen && (
            <div className="mt-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5" style={{ boxShadow: 'var(--shadow-xs)' }}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                  <Layers size={13} className="text-accent" />
                  Group activities
                </span>
                <button
                  onClick={() => setGroupOpen(false)}
                  className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
                >
                  <X size={12} />
                </button>
              </div>
              <p className="mt-1 text-[11px] text-fg-faint">
                Add regex rules that map activity names to a bucket label. The first matching rule wins; unmatched activities fall into <span className="font-mono">other</span>.
              </p>

              {/* Rule editor row */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <input
                  value={groupPattern}
                  onChange={(e) => setGroupPattern(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addGroupRule(); }}
                  placeholder="regex e.g. ^(Create|Submit)"
                  className="w-48 rounded-lg border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                />
                <span className="text-[11px] text-fg-faint">→</span>
                <input
                  value={groupLabel}
                  onChange={(e) => setGroupLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addGroupRule(); }}
                  placeholder="bucket label"
                  className="w-36 rounded-lg border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                />
                <button
                  onClick={addGroupRule}
                  disabled={!groupPattern.trim() || !groupLabel.trim()}
                  className="btn-secondary text-[11px] disabled:opacity-40"
                >
                  Add rule
                </button>
                <button
                  onClick={() => runGrouping(groupRules)}
                  disabled={groupLoading || groupRules.length === 0}
                  className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
                >
                  {groupLoading ? 'Grouping…' : 'Apply grouping'}
                </button>
                {(groupRules.length > 0 || groupResults) && (
                  <button
                    onClick={() => { setGroupRules([]); setGroupResults(null); setGroupError(null); }}
                    className="text-[11px] text-fg-faint hover:text-fg-muted"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Active rules */}
              {groupRules.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {groupRules.map((r, i) => (
                    <span
                      key={`${r.pattern}-${i}`}
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-1 px-2 py-0.5 text-[10px] text-fg-muted"
                    >
                      <span className="font-mono">{r.pattern}</span>
                      <span className="text-fg-faint">→</span>
                      <span className="font-semibold text-fg">{r.bucket}</span>
                      <button
                        onClick={() => setGroupRules((prev) => prev.filter((_, j) => j !== i))}
                        className="ml-0.5 rounded text-fg-faint hover:text-danger"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {groupError && <p className="mt-2 text-[11px] text-danger">{groupError}</p>}

              {/* Grouped result */}
              {groupResults && (
                <div className="mt-3 overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-line bg-surface-1 text-fg-faint">
                        <th className="px-2.5 py-1.5 text-left font-semibold">Bucket</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Activities</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Events</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Avg dwell</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupResults.buckets.map((b) => (
                        <tr key={b.bucket} className="border-b border-line/60 last:border-0">
                          <td className="px-2.5 py-1.5 font-medium text-fg">{b.bucket}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-fg-muted">{b.activity_count}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-fg-muted">{b.total_events.toLocaleString()}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-fg-muted">
                            {b.avg_duration_seconds > 0 ? formatDuration(b.avg_duration_seconds) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Path search results (bpmn-q) ──────────────────────────── */}
          {(pathResults || pathError) && (
            <div className="mt-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5" style={{ boxShadow: 'var(--shadow-xs)' }}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                  <Search size={13} className="text-accent" />
                  Path matches
                  {pathResults && (
                    <span className="font-mono text-[11px] font-normal text-fg-faint">{pathResults.pattern}</span>
                  )}
                </span>
                <button
                  onClick={() => { setPathResults(null); setPathError(null); }}
                  className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
                >
                  <X size={12} />
                </button>
              </div>

              {pathError ? (
                <p className="mt-2 text-[11px] text-danger">{pathError}</p>
              ) : pathResults && pathResults.matches.length === 0 ? (
                <p className="mt-2 text-[11px] text-fg-faint">No edges in the graph match this pattern.</p>
              ) : pathResults ? (
                <>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    {pathResults.matches.length} matching transition{pathResults.matches.length === 1 ? '' : 's'} ·{' '}
                    {pathResults.matches.reduce((s, m) => s + m.count, 0).toLocaleString()} occurrences
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pathResults.matches
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .slice(0, 24)
                      .map((m) => (
                        <span
                          key={`${m.source}->${m.target}`}
                          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-1 px-2 py-0.5 text-[10px]"
                        >
                          <span className="font-medium text-fg">{m.source}</span>
                          <span className="text-fg-faint">→</span>
                          <span className="font-medium text-fg">{m.target}</span>
                          <span className="ml-0.5 rounded-full bg-accent/15 px-1.5 text-[10px] font-bold tabular-nums text-accent">
                            {m.count.toLocaleString()}
                          </span>
                        </span>
                      ))}
                  </div>
                  {pathResults.matches.length > 24 && (
                    <p className="mt-1.5 text-[10px] text-fg-faint">Showing top 24 of {pathResults.matches.length} matches.</p>
                  )}
                </>
              ) : null}
            </div>
          )}

          {/* Map + side panel */}
          <div className="mt-2 flex flex-1 flex-col md:flex-row gap-3 overflow-hidden min-h-0">
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
                    <div
                      className="flex items-center gap-2 border-b border-line bg-surface-1/50 px-2 py-1.5"
                      data-tour="process-map-toolbar"
                    >
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
                      { icon: Clock, label: 'Avg Duration', value: selectedNodeData.avg_duration == null ? '—' : formatDuration(selectedNodeData.avg_duration) },
                      { icon: Clock, label: 'Med Duration', value: selectedNodeData.median_duration == null ? '—' : formatDuration(selectedNodeData.median_duration) },
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

                      {/* "What does this map mean?" output (finding #15).
                          Triggered from the control strip; explains the
                          current algorithm / noise / complexity context
                          in plain language. */}
                      {(narrationLoading || narration || narrationError) && (
                        <div className="border-t border-line pt-3 mt-3">
                          <div className="mb-1.5 flex items-center gap-1.5">
                            <Sparkles size={11} className="text-accent" />
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                              What this map shows
                            </span>
                            {narration && (
                              <button
                                onClick={() => {
                                  setNarration(null);
                                  setNarrationError(null);
                                }}
                                className="ml-auto rounded p-0.5 text-fg-faint hover:bg-tint hover:text-fg-muted transition-colors"
                                title="Dismiss"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                          {narrationLoading ? (
                            <p className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                              <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line border-t-accent" />
                              Reading the current map…
                            </p>
                          ) : narrationError ? (
                            <p className="text-[11px] text-danger">{narrationError}</p>
                          ) : narration ? (
                            <>
                              {narrationLlmConfigured === false && (
                                <p className="mb-1.5 rounded-md bg-warning/10 px-2 py-1 text-[10px] text-warning">
                                  No LLM provider configured — showing a
                                  rule-based summary.
                                </p>
                              )}
                              <Markdown text={narration} variant="compact" />
                            </>
                          ) : null}
                        </div>
                      )}
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

      </div>{/* /stage */}
      </div>{/* /scroll region */}

      {/* Export as Code modal — process-to-workflow codegen */}
      {eventLogId && exportCodeOpen && (
        <ExportWorkflowModal
          eventLogId={eventLogId}
          isOpen={exportCodeOpen}
          onClose={() => setExportCodeOpen(false)}
        />
      )}

      {/* Activity detail modal.
          `selectedNode` holds the DFG node's *sanitized* id (lowercased,
          spaces/slashes → underscores) which is correct for selection
          highlighting + node lookup, but the backend resolves activities by
          their original name. Pass the original label so clicking a node
          never 404s (falling back to the id if the node isn't in `discovery`). */}
      {eventLogId && selectedNode && (
        <ActivityDetailModal
          eventLogId={eventLogId}
          activityName={selectedNodeData?.label ?? selectedNode}
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
