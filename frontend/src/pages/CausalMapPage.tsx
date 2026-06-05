import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import cytoscape, { Core, EventObject, NodeSingular } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { Workflow, Maximize2, Info } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import { mining } from '@/api/client';
import { useEventLogData } from '@/hooks/useProcessMining';
import { useUIStore } from '@/store';
import type { CausalDagResponse } from '@/types';

try { cytoscape.use(dagre); } catch { /* already registered */ }

/* ── Causal Influence Map ─────────────────────────────────────────────────
 *
 * Not "what follows what" (the DFG) but "what CAUSES what". DirectLiNGAM over
 * per-case activity dwell times yields a DAG: a red arrow A → B means making
 * A slower systematically slows B; a green ⊣ means A speeds B up. Edge
 * thickness is the strength of the effect. Click an activity to see what is
 * dragging it. No competitor ships a causal process map.
 *
 * Sign convention (from the backend): weight > 0 ⇒ source SLOWS target;
 * weight < 0 ⇒ source SPEEDS UP target.
 */

const SLOW_COLOR = '#f43f5e'; // rose — source slows target
const FAST_COLOR = '#10b981'; // emerald — source speeds target

function styles(isDark: boolean): any[] {
  const nodeBg = isDark ? '#242428' : '#ffffff';
  const nodeBorder = isDark ? '#3a3a40' : '#d4d7dc';
  const nodeText = isDark ? '#e0e0e4' : '#1a1d24';
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        'font-size': '10px',
        'font-family': 'Manrope, system-ui, sans-serif',
        'font-weight': 500,
        'background-color': nodeBg,
        'border-width': 1,
        'border-color': nodeBorder,
        shape: 'roundrectangle',
        width: 'label',
        height: 'label',
        padding: '10px',
        'text-valign': 'center',
        'text-halign': 'center',
        color: nodeText,
        'min-zoomed-font-size': 8,
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-color': '#06b6d4', 'border-width': 2.5 },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'data(width)',
        'line-style': 'dashed',
        'line-dash-pattern': [6, 3],
        'arrow-scale': 1,
        opacity: 0.9,
      },
    },
    {
      selector: 'edge.slows',
      style: {
        'line-color': SLOW_COLOR,
        'target-arrow-color': SLOW_COLOR,
        'target-arrow-shape': 'triangle',
      },
    },
    {
      selector: 'edge.speeds',
      style: {
        'line-color': FAST_COLOR,
        'target-arrow-color': FAST_COLOR,
        'target-arrow-shape': 'tee',
      },
    },
    { selector: '.dimmed', style: { opacity: 0.08 } },
    { selector: 'edge.highlight', style: { opacity: 1, width: 'data(hwidth)' } },
  ];
}

const METHOD_LABEL: Record<string, string> = {
  direct_lingam: 'DirectLiNGAM',
  correlation_fallback: 'Correlation (LiNGAM unavailable)',
  empty: 'No data',
  insufficient_variance: 'Insufficient variance',
};

export default function CausalMapPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const [data, setData] = useState<CausalDagResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topK, setTopK] = useState(20);
  const [threshold, setThreshold] = useState(0.1);

  // Debounced fetch — DirectLiNGAM is expensive; don't refire mid-drag.
  useEffect(() => {
    if (!eventLogId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      mining
        .getCausalDag(eventLogId, topK, threshold)
        .then((res) => {
          if (!cancelled) setData(res);
        })
        .catch((e) => {
          if (!cancelled) setError(e?.response?.data?.detail ?? e?.message ?? 'Causal discovery failed');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [eventLogId, topK, threshold]);

  // Build / rebuild the cytoscape graph when data or theme changes.
  useEffect(() => {
    if (!containerRef.current || !data) return;
    const nodeSet = new Set(data.nodes);
    const validEdges = data.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
    if (validEdges.length === 0) return;
    const absMax = Math.max(...validEdges.map((e) => Math.abs(e.weight)), 0.001);

    const elements = [
      ...data.nodes.map((n) => ({ data: { id: n, label: n } })),
      ...validEdges.map((e, i) => {
        const a = Math.abs(e.weight) / absMax;
        const width = 1.5 + a * 5;
        return {
          data: {
            id: `c${i}`,
            source: e.source,
            target: e.target,
            width,
            hwidth: width + 2,
            weight: e.weight,
          },
          classes: e.weight >= 0 ? 'slows' : 'speeds',
        };
      }),
    ];

    // Preserve zoom/pan across a rebuild (slider nudge / theme toggle) so
    // the camera doesn't snap back to the whole graph every time.
    const prevView = cyRef.current
      ? { zoom: cyRef.current.zoom(), pan: { ...cyRef.current.pan() } }
      : null;
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }
    const cy = cytoscape({
      container: containerRef.current,
      elements: elements as any,
      style: styles(isDark),
      layout: { name: 'dagre', rankDir: 'LR', nodeSep: 50, rankSep: 90, edgeSep: 20, fit: !prevView, padding: 40, animate: false } as any,
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 1.0,
      pixelRatio: 1,
      textureOnViewport: true,
      boxSelectionEnabled: false,
    });
    if (prevView) cy.viewport({ zoom: prevView.zoom, pan: prevView.pan });
    cyRef.current = cy;

    // Click an activity → highlight what causes it + what it causes; dim rest.
    cy.on('tap', 'node', (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      const edges = node.connectedEdges();
      const nb = edges.add(node).add(edges.connectedNodes());
      cy.batch(() => {
        cy.elements().addClass('dimmed').removeClass('highlight');
        nb.removeClass('dimmed');
        edges.addClass('highlight');
        node.select();
      });
    });
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        cy.batch(() => {
          cy.elements().removeClass('dimmed').removeClass('highlight');
          cy.nodes().unselect();
        });
      }
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, isDark]);

  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 40 } } as any, { duration: 300 });
  }, []);

  if (loading && !data) {
    return <LoadingSpinner size="lg" text="Inferring causal dependencies…" fullPage />;
  }
  if (error) {
    return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  }

  const validEdgeCount = data
    ? data.edges.filter((e) => data.nodes.includes(e.source) && data.nodes.includes(e.target)).length
    : 0;
  const empty = !data || validEdgeCount === 0;

  return (
    <div>
      <PageHeader
        title="Causal Influence Map"
        icon={Workflow}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="What actually causes slowdowns — not just what follows what. A red arrow means the source activity makes the target slower; a green ⊣ means it speeds it up. Thicker = stronger effect. Click an activity to see what's dragging it."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      {/* Controls + legend */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Activities</span>
          <input type="range" min={5} max={40} step={1} value={topK} onChange={(e) => setTopK(Number(e.target.value))} className="w-32 accent-accent" />
          <span className="w-6 font-semibold tabular-nums text-fg">{topK}</span>
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Min strength</span>
          <input type="range" min={0} max={50} step={1} value={Math.round(threshold * 100)} onChange={(e) => setThreshold(Number(e.target.value) / 100)} className="w-32 accent-accent" />
          <span className="w-8 font-semibold tabular-nums text-fg">{threshold.toFixed(2)}</span>
        </label>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ backgroundColor: SLOW_COLOR }} />slows down →</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ backgroundColor: FAST_COLOR }} />speeds up ⊣</span>
        </div>
        {data && (
          <span className="ml-auto flex items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 py-1 text-[10px] text-fg-muted">
            <Info size={11} />
            {METHOD_LABEL[data.method] ?? data.method}
            {data.sample_size != null && <> · {data.sample_size} cases</>}
          </span>
        )}
      </div>

      {/* Graph */}
      <div className="relative mt-4 h-[600px] w-full overflow-hidden rounded-lg border border-line bg-surface-2">
        {empty ? (
          <EmptyState
            icon={Workflow}
            title="No causal links found"
            description={
              data?.method === 'insufficient_variance'
                ? 'Activity durations are too uniform to infer causal structure. Try a log with more timing variation.'
                : 'No dependencies passed the strength threshold. Lower the “Min strength” slider to reveal weaker links.'
            }
          />
        ) : (
          <>
            <div ref={containerRef} className="h-full w-full" style={{ touchAction: 'none' }} />
            <button
              onClick={handleFit}
              className="absolute bottom-3 right-3 z-10 rounded-md border border-line bg-surface-2/95 p-2 text-fg-muted backdrop-blur-md transition-colors hover:text-fg"
              title="Fit to screen"
            >
              <Maximize2 size={14} />
            </button>
            {loading && (
              <div className="absolute left-3 top-3 z-10 rounded-md bg-surface-0/90 px-2 py-1 text-[11px] text-fg-muted">
                Recomputing…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
