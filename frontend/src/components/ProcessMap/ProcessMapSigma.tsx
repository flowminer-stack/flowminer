import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import dagre from 'dagre';
import { FlaskConical, Download, Image, FileSpreadsheet, ChevronDown, Map as MapIcon, X } from 'lucide-react';
import clsx from 'clsx';
import type { ProcessNode, ProcessEdge } from '@/types';
import { useUIStore } from '@/store';
import { formatNumber } from '@/utils/format';
import { buildNodesCsv, buildEdgesCsv, triggerDownload } from '@/utils/processMapExport';

/**
 * Opt-in WebGL DFG renderer (Sigma.js + graphology) — a TRIAL alternative to
 * the cytoscape ProcessMap for very large directed-follows graphs, where
 * cytoscape's canvas renderer starts to struggle. This is intentionally
 * additive and self-contained: it accepts the same core props the cytoscape
 * map uses and renders them with a hierarchical (dagre) layout.
 *
 * Parity with the cytoscape map: selection, hover-dimming, hidden activities,
 * label mode, click-to-inspect, a bird's-eye minimap, PNG/CSV export and
 * replay-animation flashing (driven by AnimationController via `animationRef`)
 * all work here. Every add-on is best-effort/guarded so a failure can never
 * blank the WebGL renderer.
 */

export interface ProcessMapSigmaProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  onNodeClick?: (node: ProcessNode) => void;
  selectedNode?: string;
  hiddenActivities?: Set<string>;
  labelMode?: 'absolute' | 'relative';
  /**
   * Optional imperative handle the parent populates so AnimationController can
   * flash nodes/edges during replay. `flash(nodeId, edgeKey)` highlights a node
   * (and optionally an edge) cyan for ~500ms; `reset()` clears all flashes.
   */
  animationRef?: React.MutableRefObject<{
    flash: (nodeId: string, edgeKey: string | null) => void;
    reset: () => void;
  } | null>;
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
    // Replay flash — same cyan the cytoscape anim-flash uses, both themes.
    flash: '#06b6d4',
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
  animationRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  // Replay-flash state — sets of currently-flashing node ids / edge keys, plus
  // their per-id removal timers. Read by the reducers; mutated by animationRef.
  const flashNodesRef = useRef<Set<string>>(new Set());
  const flashEdgesRef = useRef<Set<string>>(new Set());
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Minimap + export overlay state.
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

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

    // Seed positions on a circle as a fallback, so the map is never blank if
    // the dagre layout below throws.
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

    // Hierarchical (dagre) layout — process flows read left-to-right far more
    // legibly than a force-directed blob. dagre handles cyclic DFGs (it breaks
    // cycles internally) and is the same engine the cytoscape map uses, so the
    // layout cost matches; Sigma's win is the WebGL *rendering*, not the layout.
    try {
      const dg = new dagre.graphlib.Graph({ directed: true });
      dg.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, edgesep: 14, marginx: 16, marginy: 16 });
      dg.setDefaultEdgeLabel(() => ({}));
      g.forEachNode((id, attr) => {
        const s = (attr.size as number) ?? 10;
        dg.setNode(id, { width: s * 2, height: s * 2 });
      });
      g.forEachEdge((_e, _a, source, target) => {
        if (source !== target) dg.setEdge(source, target); // self-loops add no rank info
      });
      dagre.layout(dg);
      g.forEachNode((id) => {
        const p = dg.node(id);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          g.setNodeAttribute(id, 'x', p.x);
          // dagre LR and sigma share a y-down convention, so no flip is needed;
          // sigma's autoRescale frames the graph to the viewport on render.
          g.setNodeAttribute(id, 'y', p.y);
        }
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
        const res = { ...data };
        // Replay flash takes precedence over selection / dimming so a flashed
        // node always reads, even outside the focused neighbourhood.
        if (flashNodesRef.current.has(key)) {
          res.color = pal.flash;
          res.highlighted = true;
          res.zIndex = 2;
          res.size = ((data.size as number) ?? 8) * 1.6;
          return res;
        }
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = hov ?? sel;
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
        const res = { ...data };
        // Replay flash takes precedence: cyan + thicker.
        if (flashEdgesRef.current.has(key)) {
          res.color = pal.flash;
          res.size = ((data.size as number) ?? 1) * 2.5;
          res.zIndex = 2;
          return res;
        }
        const sel = selectedRef.current;
        const hov = hoveredRef.current;
        const focus = hov ?? sel;
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

  /* ── Replay-animation handle ───────────────────────────────────────────
   * Populate animationRef so AnimationController can flash nodes/edges during
   * replay. Each flash (re-)arms a ~500ms removal timer keyed by id; on expiry
   * the id leaves the set and a refresh re-runs the reducers (which un-flash).
   * Everything is guarded so a stray call can never throw into the render loop.
   */
  useEffect(() => {
    if (!animationRef) return;
    const FLASH_MS = 500;

    const refresh = () => {
      try {
        sigmaRef.current?.refresh();
      } catch {
        /* renderer mid-teardown — ignore */
      }
    };

    const handle = {
      flash: (nodeId: string, edgeKey: string | null) => {
        try {
          const g = graphRef.current;
          // Only flash ids that exist in the current graph, so a stale replay
          // event for a hidden/filtered activity is a silent no-op.
          if (g && g.hasNode(nodeId)) {
            flashNodesRef.current.add(nodeId);
            const k = `node:${nodeId}`;
            const prev = flashTimersRef.current.get(k);
            if (prev) clearTimeout(prev);
            flashTimersRef.current.set(
              k,
              setTimeout(() => {
                flashNodesRef.current.delete(nodeId);
                flashTimersRef.current.delete(k);
                refresh();
              }, FLASH_MS),
            );
          }
          if (edgeKey && g && g.hasEdge(edgeKey)) {
            flashEdgesRef.current.add(edgeKey);
            const k = `edge:${edgeKey}`;
            const prev = flashTimersRef.current.get(k);
            if (prev) clearTimeout(prev);
            flashTimersRef.current.set(
              k,
              setTimeout(() => {
                flashEdgesRef.current.delete(edgeKey);
                flashTimersRef.current.delete(k);
                refresh();
              }, FLASH_MS),
            );
          }
          refresh();
        } catch {
          /* never let a flash break rendering */
        }
      },
      reset: () => {
        try {
          flashTimersRef.current.forEach((t) => clearTimeout(t));
          flashTimersRef.current.clear();
          flashNodesRef.current.clear();
          flashEdgesRef.current.clear();
          refresh();
        } catch {
          /* ignore */
        }
      },
    };

    animationRef.current = handle;
    return () => {
      // Clear any in-flight flashes and detach the handle on unmount/rebuild.
      flashTimersRef.current.forEach((t) => clearTimeout(t));
      flashTimersRef.current.clear();
      flashNodesRef.current.clear();
      flashEdgesRef.current.clear();
      if (animationRef.current === handle) animationRef.current = null;
    };
    // Re-bind when the renderer is recreated (graph/theme change) so the handle
    // always refreshes the live instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationRef, builtGraph, isDark]);

  /* ── Minimap ──────────────────────────────────────────────────────────
   * A sigma-native bird's-eye view (cytoscape-navigator is cytoscape-only).
   * Draws each visible node as a dot scaled into the canvas, plus a stroked
   * rectangle for the current viewport (derived via viewportToGraph on the two
   * container corners). Redraws on every afterRender (covers pan/zoom + the
   * initial frame) and on graph rebuild. All guarded so it never blanks the map.
   */
  const drawMinimap = useCallback(() => {
    const canvas = minimapCanvasRef.current;
    const sigma = sigmaRef.current;
    const graph = graphRef.current;
    if (!canvas || !sigma || !graph) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || 180;
      const cssH = canvas.clientHeight || 120;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // Graph bounding box from raw node x/y attributes.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      graph.forEachNode((_id, attr) => {
        const x = attr.x as number;
        const y = attr.y as number;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

      const pad = 8;
      const gW = maxX - minX || 1;
      const gH = maxY - minY || 1;
      const sc = Math.min((cssW - pad * 2) / gW, (cssH - pad * 2) / gH);
      // Centre the scaled graph within the minimap canvas.
      const offX = (cssW - gW * sc) / 2;
      const offY = (cssH - gH * sc) / 2;
      const gx = (x: number) => offX + (x - minX) * sc;
      const gy = (y: number) => offY + (y - minY) * sc;

      const pal = getPalette(isDark);
      // Nodes as dots (edges skipped for perf).
      ctx.fillStyle = isDark ? '#7c8190' : '#9aa0ac';
      graph.forEachNode((id, attr) => {
        const x = attr.x as number;
        const y = attr.y as number;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        // Flashing nodes pop cyan even in the minimap.
        ctx.fillStyle = flashNodesRef.current.has(id)
          ? pal.flash
          : isDark
            ? '#7c8190'
            : '#9aa0ac';
        ctx.beginPath();
        ctx.arc(gx(x), gy(y), 1.6, 0, Math.PI * 2);
        ctx.fill();
      });

      // Current viewport rectangle, in graph space, via the two corners.
      const tl = sigma.viewportToGraph({ x: 0, y: 0 });
      const br = sigma.viewportToGraph({ x: sigma.getDimensions().width, y: sigma.getDimensions().height });
      const rx1 = gx(Math.min(tl.x, br.x));
      const ry1 = gy(Math.min(tl.y, br.y));
      const rx2 = gx(Math.max(tl.x, br.x));
      const ry2 = gy(Math.max(tl.y, br.y));
      ctx.strokeStyle = pal.flash;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.max(0.5, rx1),
        Math.max(0.5, ry1),
        Math.min(cssW - 1, rx2 - rx1),
        Math.min(cssH - 1, ry2 - ry1),
      );
    } catch {
      /* minimap is purely decorative — never throw */
    }
  }, [isDark]);

  // Redraw the minimap on render (pan/zoom/initial frame) and on rebuild/open.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !minimapOpen) return;
    drawMinimap();
    const onAfterRender = () => drawMinimap();
    try {
      sigma.on('afterRender', onAfterRender);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        sigma.off('afterRender', onAfterRender);
      } catch {
        /* ignore */
      }
    };
  }, [drawMinimap, minimapOpen, builtGraph, isDark]);

  // Click-to-recenter: convert the click point inside the minimap back to graph
  // space, then to the sigma viewport, then to the camera's framed-graph space
  // and animate the camera there. Best-effort; wrapped so a bad conversion is a
  // no-op rather than a broken pan.
  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = minimapCanvasRef.current;
      const sigma = sigmaRef.current;
      const graph = graphRef.current;
      if (!canvas || !sigma || !graph) return;
      try {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const cssW = canvas.clientWidth || 180;
        const cssH = canvas.clientHeight || 120;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        graph.forEachNode((_id, attr) => {
          const x = attr.x as number;
          const y = attr.y as number;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        });
        if (!Number.isFinite(minX)) return;

        const pad = 8;
        const gW = maxX - minX || 1;
        const gH = maxY - minY || 1;
        const sc = Math.min((cssW - pad * 2) / gW, (cssH - pad * 2) / gH);
        const offX = (cssW - gW * sc) / 2;
        const offY = (cssH - gH * sc) / 2;
        // Minimap pixel → graph coords.
        const graphX = (px - offX) / sc + minX;
        const graphY = (py - offY) / sc + minY;

        // graph → viewport → framed-graph → camera target. graphToViewport
        // already accounts for the live camera, so the round-trip recenters on
        // the clicked point without us re-deriving the normalization manually.
        const viewport = sigma.graphToViewport({ x: graphX, y: graphY });
        const framed = sigma.viewportToFramedGraph(viewport);
        const cam = sigma.getCamera();
        cam.animate({ x: framed.x, y: framed.y }, { duration: 250 });
      } catch {
        /* leave the minimap display-only if conversion is awkward */
      }
    },
    [],
  );

  /* ── Export (PNG / CSV) ────────────────────────────────────────────────── */

  const handleExportPNG = useCallback(() => {
    const sigma = sigmaRef.current;
    const container = containerRef.current;
    if (!sigma || !container) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      const cssW = container.clientWidth || 800;
      const cssH = container.clientHeight || 600;

      // Composite the sigma canvas layers in DOM order. Querying the container
      // is renderer-agnostic and avoids guessing a sigma export method. Sigma's
      // layer canvases already carry a dpr-scaled backing store, so size the
      // output to that native resolution and draw 1:1 — drawing to a larger
      // canvas would just upscale-blur the same pixels.
      const layers = container.querySelectorAll('canvas');
      const first = layers[0] as HTMLCanvasElement | undefined;
      const outW = first?.width || Math.round(cssW * dpr);
      const outH = first?.height || Math.round(cssH * dpr);

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d');
      if (!ctx) return;

      // Theme background — sigma's layers are transparent.
      ctx.fillStyle = isDark ? '#1e1e22' : '#ffffff';
      ctx.fillRect(0, 0, outW, outH);

      layers.forEach((layer) => {
        try {
          ctx.drawImage(layer, 0, 0, outW, outH);
        } catch {
          /* skip a layer that refuses to draw */
        }
      });

      const url = out.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'process-map.png';
      a.click();
    } catch {
      /* export failure must not crash the renderer */
    }
    setExportOpen(false);
  }, [isDark]);

  const handleExportCSV = useCallback(() => {
    try {
      const nodesCsv = buildNodesCsv(nodes);
      const edgesCsv = buildEdgesCsv(edges);
      const combined = '# Nodes\n' + nodesCsv + '\n\n# Edges\n' + edgesCsv;
      triggerDownload(combined, 'process-map.csv', 'text/csv');
    } catch {
      /* ignore */
    }
    setExportOpen(false);
  }, [nodes, edges]);

  // Close the export menu on outside click.
  useEffect(() => {
    if (!exportOpen) return;
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportOpen]);

  const visibleCount = builtGraph.order;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-surface-2">
      {/* Trial badge */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-line bg-surface-2/95 px-2 py-1 text-[10px] font-medium text-fg-muted backdrop-blur-md">
        <FlaskConical size={11} className="text-accent" />
        WebGL renderer (trial)
      </div>

      {/* Export cluster (top-right) */}
      {visibleCount > 0 && (
        <div ref={exportMenuRef} className="absolute right-3 top-3 z-10">
          <button
            onClick={() => setExportOpen((o) => !o)}
            className={clsx(
              'flex items-center gap-1 rounded-md border border-line bg-surface-2/95 px-2 py-1 text-fg-muted backdrop-blur-md transition-colors',
              'hover:bg-tint hover:text-fg',
              exportOpen && 'bg-tint text-fg',
            )}
            title="Export"
          >
            <Download size={13} />
            <ChevronDown
              size={10}
              className={clsx('transition-transform', exportOpen && 'rotate-180')}
            />
          </button>

          {exportOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] overflow-hidden rounded-lg border border-line bg-surface-1 shadow-lg">
              <button
                onClick={handleExportPNG}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-tint"
              >
                <Image size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                <div>
                  <p className="text-[12px] font-medium text-fg-secondary">Export as PNG</p>
                  <p className="text-[10px] text-fg-faint">High-res raster image</p>
                </div>
              </button>
              <button
                onClick={handleExportCSV}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-tint"
              >
                <FileSpreadsheet size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                <div>
                  <p className="text-[12px] font-medium text-fg-secondary">Export data as CSV</p>
                  <p className="text-[10px] text-fg-faint">Nodes and edges table</p>
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Minimap (bottom-right) */}
      {visibleCount > 0 && (
        minimapOpen ? (
          <div className="absolute bottom-3 right-3 z-10 overflow-hidden rounded-md border border-line bg-surface-2/95 backdrop-blur-md">
            <div className="flex items-center justify-between border-b border-line px-2 py-1">
              <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide text-fg-faint">
                <MapIcon size={9} />
                Overview
              </span>
              <button
                onClick={() => setMinimapOpen(false)}
                className="rounded p-0.5 text-fg-muted transition-colors hover:bg-tint hover:text-fg"
                title="Hide minimap"
              >
                <X size={10} />
              </button>
            </div>
            <canvas
              ref={minimapCanvasRef}
              onClick={handleMinimapClick}
              title="Click to recenter"
              className="block cursor-pointer"
              style={{ width: 180, height: 120 }}
            />
          </div>
        ) : (
          <button
            onClick={() => setMinimapOpen(true)}
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-line bg-surface-2/95 px-2 py-1 text-[10px] font-medium text-fg-muted backdrop-blur-md transition-colors hover:bg-tint hover:text-fg"
            title="Show minimap"
          >
            <MapIcon size={11} />
            Overview
          </button>
        )
      )}

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
