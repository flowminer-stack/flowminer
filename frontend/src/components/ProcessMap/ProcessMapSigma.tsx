import React, { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { FlaskConical } from 'lucide-react';
import type { ProcessNode, ProcessEdge } from '@/types';
import { useUIStore } from '@/store';
import { formatNumber } from '@/utils/format';

/**
 * Opt-in WebGL DFG renderer (Sigma.js + graphology) — a TRIAL alternative to
 * the cytoscape ProcessMap for very large directed-follows graphs, where
 * cytoscape's canvas renderer starts to struggle. This is intentionally
 * additive and self-contained: it accepts the same core props the cytoscape
 * map uses and renders them with a force-directed layout.
 *
 * Trial scope: minimap, replay animation and image export are NOT supported
 * here — those controls remain wired to the cytoscape path. Selection,
 * hover-dimming, hidden activities, label mode and click-to-inspect all work.
 */

export interface ProcessMapSigmaProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  onNodeClick?: (node: ProcessNode) => void;
  selectedNode?: string;
  hiddenActivities?: Set<string>;
  labelMode?: 'absolute' | 'relative';
}

/* ── Theme palette ────────────────────────────────────────────────────── */

function getPalette(isDark: boolean) {
  return {
    // Neutral accent for ordinary activities.
    node: isDark ? '#6ea8d8' : '#4f63b2',
    nodeStart: isDark ? '#34d399' : '#059669',
    nodeEnd: isDark ? '#f87171' : '#dc2626',
    edge: isDark ? '#3a3a40' : '#cdd1d8',
    label: isDark ? '#e0e0e4' : '#1a1d24',
    select: isDark ? '#06b6d4' : '#4f63b2',
    // Dim alpha applied to nodes/edges outside the highlighted neighbourhood.
    dimNode: isDark ? '#2f2f35' : '#e6e8ec',
    dimEdge: isDark ? '#26262b' : '#eef0f3',
    dimLabel: isDark ? '#52525b' : '#b4b8c0',
  };
}

/* ── Backend performance-color softening (mirrors ProcessMap) ─────────── */

function softenEdgeColor(hex: string | null, isDark: boolean, fallback: string): string {
  if (!hex) return fallback;
  const map: Record<string, [string, string]> = {
    '#22c55e': ['#4ade80', '#34d399'],
    '#eab308': ['#d4a017', '#fbbf24'],
    '#ef4444': ['#e57373', '#f87171'],
  };
  const pair = map[hex.toLowerCase()];
  if (pair) return isDark ? pair[1] : pair[0];
  if (hex === '#3f3f46' || hex === '#94a3b8') return fallback;
  return hex;
}

function scale(value: number, min: number, max: number, outMin: number, outMax: number): number {
  if (max === min) return (outMin + outMax) / 2;
  return outMin + ((value - min) / (max - min)) * (outMax - outMin);
}

/* ── Component ────────────────────────────────────────────────────────── */

const ProcessMapSigma: React.FC<ProcessMapSigmaProps> = ({
  nodes,
  edges,
  onNodeClick,
  selectedNode,
  hiddenActivities,
  labelMode = 'absolute',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  // Hovered node id — drives neighbourhood dimming alongside `selectedNode`.
  const [hovered, setHovered] = useState<string | null>(null);

  // Map of node id → original ProcessNode so the click handler can hand the
  // parent the same object shape the cytoscape map does.
  const nodeIndex = useMemo(() => {
    const m = new Map<string, ProcessNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Keep the latest onNodeClick callable without re-running the (expensive)
  // graph-build effect — the parent passes a fresh inline fn each render.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  // Build the graphology graph (filtered + laid out) whenever the inputs or
  // theme change. Theme is included because node/edge colours are baked into
  // the graph attributes at build time.
  const builtGraph = useMemo(() => {
    const pal = getPalette(isDark);
    const g = new Graph({ type: 'directed', multi: false, allowSelfLoops: true });

    const hidden = hiddenActivities;
    const visibleNodes = hidden && hidden.size > 0
      ? nodes.filter((n) => !hidden.has(n.id) && !hidden.has(n.label))
      : nodes;

    if (visibleNodes.length === 0) return g;

    const freqs = visibleNodes.map((n) => n.frequency);
    const minFreq = Math.min(...freqs);
    const maxFreq = Math.max(...freqs);
    const totalFreq = visibleNodes.reduce((s, n) => s + n.frequency, 0) || 1;

    // Seed positions on a circle so force-atlas2 has a non-degenerate start
    // (all-at-origin makes the layout collapse).
    const N = visibleNodes.length;
    visibleNodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / N;
      const color = node.is_start ? pal.nodeStart : node.is_end ? pal.nodeEnd : pal.node;
      const freqLabel =
        labelMode === 'relative'
          ? `${((node.frequency / totalFreq) * 100).toFixed(1)}%`
          : formatNumber(node.frequency);
      if (!g.hasNode(node.id)) {
        g.addNode(node.id, {
          x: Math.cos(angle),
          y: Math.sin(angle),
          size: scale(node.frequency, minFreq, maxFreq, 6, 24),
          label: `${node.label} · ${freqLabel}`,
          color,
          // Stash originals so reducers can re-derive base colours on dim.
          baseColor: color,
        });
      }
    });

    const visibleEdges = edges.filter(
      (e) => g.hasNode(e.source) && g.hasNode(e.target),
    );
    if (visibleEdges.length > 0) {
      const eFreqs = visibleEdges.map((e) => e.frequency);
      const minE = Math.min(...eFreqs);
      const maxE = Math.max(...eFreqs);
      for (const edge of visibleEdges) {
        const key = `${edge.source}->${edge.target}`;
        if (g.hasEdge(key)) continue;
        const color = softenEdgeColor(edge.performance_color, isDark, pal.edge);
        g.addEdgeWithKey(key, edge.source, edge.target, {
          size: scale(edge.frequency, minE, maxE, 1, 4),
          color,
          baseColor: color,
        });
      }
    }

    // Synchronous force-directed layout (mutates x/y in place).
    try {
      forceAtlas2.assign(g, {
        iterations: 300,
        settings: {
          scalingRatio: 10,
          gravity: 1,
          adjustSizes: true,
          barnesHutOptimize: g.order > 500,
        },
      });
    } catch {
      /* layout failure must not blank the map — keep the circle seed */
    }

    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, hiddenActivities, labelMode, isDark]);

  graphRef.current = builtGraph;

  // Refs so the reducers (installed once per sigma instance) read the latest
  // selection / hover without re-creating the renderer.
  const selectedRef = useRef<string | undefined>(selectedNode);
  selectedRef.current = selectedNode;
  const hoveredRef = useRef<string | null>(hovered);
  hoveredRef.current = hovered;

  // (Re)create the sigma renderer when the graph or theme changes. The graph
  // object identity changes on every rebuild, so this cleanly disposes the
  // previous instance and graph.
  useEffect(() => {
    if (!containerRef.current) return;
    const pal = getPalette(isDark);
    const graph = builtGraph;

    const renderer = new Sigma(graph, containerRef.current, {
      // Transparent background so the surrounding surface shows through.
      allowInvalidContainer: true,
      renderLabels: true,
      labelColor: { color: pal.label },
      labelFont: 'Manrope, system-ui, sans-serif',
      labelSize: 12,
      labelWeight: '500',
      defaultNodeColor: pal.node,
      defaultEdgeColor: pal.edge,
      labelRenderedSizeThreshold: 6,
      nodeReducer: (key, data) => {
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = hov ?? sel;
        const res = { ...data };
        if (!focus) return res;
        const g = graphRef.current;
        const inFocus =
          key === focus ||
          (g ? g.neighbors(focus).includes(key) : false);
        if (inFocus) {
          if (key === focus) {
            res.color = pal.select;
            res.highlighted = true;
            res.zIndex = 1;
          }
          return res;
        }
        // Outside the focused neighbourhood → dim.
        res.color = pal.dimNode;
        res.label = '';
        res.zIndex = 0;
        return res;
      },
      edgeReducer: (key, data) => {
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = hov ?? sel;
        const res = { ...data };
        if (!focus) return res;
        const g = graphRef.current;
        // hasEdge guard: during a rapid rebuild sigma may reduce an edge that
        // no longer exists in the current graph — extremities() throws on that.
        if (!g || !g.hasEdge(key)) return res;
        const [s, t] = g.extremities(key);
        const touches = s === focus || t === focus;
        if (touches) {
          res.color = pal.select;
          res.zIndex = 1;
        } else {
          res.color = pal.dimEdge;
          res.zIndex = 0;
        }
        return res;
      },
    });

    sigmaRef.current = renderer;

    const handleClickNode = (e: { node: string }) => {
      const data = nodeIndex.get(e.node);
      if (data) onNodeClickRef.current?.(data);
    };
    const handleEnterNode = (e: { node: string }) => setHovered(e.node);
    const handleLeaveNode = () => setHovered(null);

    renderer.on('clickNode', handleClickNode);
    renderer.on('enterNode', handleEnterNode);
    renderer.on('leaveNode', handleLeaveNode);

    return () => {
      renderer.off('clickNode', handleClickNode);
      renderer.off('enterNode', handleEnterNode);
      renderer.off('leaveNode', handleLeaveNode);
      renderer.kill();
      sigmaRef.current = null;
      graph.clear();
    };
    // onNodeClick / nodeIndex are read fresh via closure; re-create only on
    // graph/theme change to avoid tearing down the renderer on every parent
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtGraph, isDark]);

  // Selection / hover changed → ask sigma to re-run the reducers without a
  // full rebuild.
  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [selectedNode, hovered]);

  const visibleCount = builtGraph.order;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-surface-2">
      {/* Trial badge */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-line bg-surface-2/95 px-2 py-1 text-[10px] font-medium text-fg-muted backdrop-blur-md">
        <FlaskConical size={11} className="text-accent" />
        WebGL renderer (trial)
      </div>

      {/* Empty state */}
      {visibleCount === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <FlaskConical className="mx-auto mb-2 h-7 w-7 text-fg-ghost" />
            <p className="text-[12px] font-medium text-fg-muted">No process data</p>
            <p className="mt-0.5 text-[10px] text-fg-faint">
              Upload an event log to discover the process map
            </p>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        role="img"
        aria-label={`WebGL process map showing ${visibleCount} ${
          visibleCount === 1 ? 'activity' : 'activities'
        }. Drag to pan, scroll to zoom; click a node to inspect it.`}
        className="h-full w-full"
        style={{ touchAction: 'none' }}
      />
    </div>
  );
};

export default ProcessMapSigma;
