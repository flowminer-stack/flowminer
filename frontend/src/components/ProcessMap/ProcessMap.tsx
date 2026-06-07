import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import cytoscape, { Core, EventObject, NodeSingular, EdgeSingular } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import navigator from 'cytoscape-navigator';
import 'cytoscape-navigator/cytoscape.js-navigator.css';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  MessageSquare,
  Map as MapIcon,
} from 'lucide-react';
import { formatNumber, formatDuration } from '../../utils/format';
import { simplifyGraph } from '../../utils/simplifyGraph';
import type { ProcessNode, ProcessEdge, Annotation } from '../../types';
import { useUIStore } from '../../store';
import ExportMenu from './ExportMenu';

// Register cytoscape extensions once. Guard against double-registration
// (Vite HMR re-runs this module), which otherwise throws.
try { cytoscape.use(dagre); } catch { /* already registered */ }
try { cytoscape.use(navigator); } catch { /* already registered */ }

export type LayoutName = 'dagre' | 'breadthfirst' | 'circle' | 'concentric' | 'grid';

interface ProcessMapProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  complexity: number;
  onNodeClick?: (node: ProcessNode) => void;
  onEdgeClick?: (edge: ProcessEdge) => void;
  // Tap on empty canvas — parent clears the current selection so the
  // neighbourhood dimming clears (standard "click away to deselect").
  onBackgroundTap?: () => void;
  selectedNode?: string;
  annotations?: Annotation[];
  layoutDirection?: 'TB' | 'LR';
  layoutName?: LayoutName;
  colorBy?: 'frequency' | 'duration' | 'performance';
  cyRef?: React.MutableRefObject<Core | null>;
  // ── Competitive parity props ─────────────────────────────────────
  // Abs vs relative label rendering (Disco): '847 cases' vs '34%'.
  labelMode?: 'absolute' | 'relative';
  // Highlight-slow mode (Disco): grey everything below the median dwell,
  // paint above-median activities with a warm accent so bottlenecks
  // jump out at a glance.
  highlightSlow?: boolean;
  // Hide list (Celonis): activity ids the user has toggled off via the
  // hide-events panel. These nodes are removed from the visible graph.
  hiddenActivities?: Set<string>;
  // Click-to-filter (UiPath / Celonis / ARIS): adds a filter chip for
  // the clicked activity. Invoked alongside onNodeClick so both hooks
  // can coexist.
  onAddActivityFilter?: (activity: string) => void;
  // Right-click context menu (Signavio): native browser menu is
  // suppressed; the parent renders its own React menu at the given
  // pixel position.
  onContextMenu?: (
    node: ProcessNode,
    pos: { x: number; y: number },
  ) => void;
  // Hover tooltip data (Disco): disable by passing false if the
  // parent wants a simpler renderer.
  showHoverTooltip?: boolean;
  // Activity-frequency threshold (Apromore triple slider): hide nodes
  // whose frequency falls below this percentile (0-100, default 0 = show all).
  activityThreshold?: number;
}

/* ── Theme-aware cytoscape styles ─────────────────────────────────────── */

export function getCyStyles(isDark: boolean): any[] {
  const bg = isDark ? '#1e1e22' : '#ffffff';
  const nodeBg = isDark ? '#242428' : '#ffffff';
  const nodeBorder = isDark ? '#3a3a40' : '#d4d7dc';
  const nodeText = isDark ? '#e0e0e4' : '#1a1d24';
  const edgeTextBg = isDark ? '#1a1a1e' : '#f7f8fa';
  const edgeTextColor = isDark ? '#71717a' : '#6c7283';
  // Start/end markers are vibrant solid fills so they pop as the process'
  // entry/exit. The fill is light enough that the label must be DARK to read
  // (white-on-green / white-on-salmon was barely legible). Light theme uses
  // darker fills, so white text reads there.
  const startColor = isDark ? '#34d399' : '#059669';
  const startBg = isDark ? '#34d399' : '#059669';
  const startText = isDark ? '#0a1f17' : '#ffffff';
  const endColor = isDark ? '#f87171' : '#dc2626';
  const endBg = isDark ? '#f87171' : '#dc2626';
  const endText = isDark ? '#2a0c0c' : '#ffffff';
  const selectColor = isDark ? '#06b6d4' : '#4f63b2';
  const selectBg = isDark ? 'rgba(6, 182, 212, 0.06)' : 'rgba(79, 99, 178, 0.06)';

  void bg; // used for export

  return [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '110px',
        'font-size': '12px',
        'font-family': 'Manrope, system-ui, sans-serif',
        'font-weight': 500,
        'background-color': nodeBg,
        'border-width': 1,
        'border-color': nodeBorder,
        'border-opacity': 0.8,
        'shape': 'roundrectangle',
        'width': 'data(width)',
        'height': 'data(height)',
        'padding': '8px',
        'text-valign': 'center',
        'text-halign': 'center',
        'color': nodeText,
        'text-background-color': nodeBg,
        'text-background-opacity': 0,
        // Activity labels always render (no min-zoomed-font-size) — at a
        // default fit the graph can sit at a low zoom and the names must
        // still be visible without clicking. Edge freq-labels keep the LOD.
        'transition-property': 'border-color border-width opacity background-color',
        'transition-duration': '0.15s',
      } as any,
    },
    {
      selector: 'node.start',
      style: {
        'border-color': startColor,
        'border-width': 1.5,
        'border-style': 'solid',
        'shape': 'roundrectangle',
        'background-color': startBg,
        'color': startText,
        'font-weight': 700,
      },
    },
    {
      selector: 'node.end',
      style: {
        'border-color': endColor,
        'border-width': 1.5,
        'border-style': 'solid',
        'shape': 'roundrectangle',
        'background-color': endBg,
        'color': endText,
        'font-weight': 700,
      },
    },
    {
      selector: 'node.has-annotation',
      style: {
        'border-style': 'dashed',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': selectColor,
        'border-width': 2,
        'background-color': selectBg,
        // Reset to the standard contrasting text — the selected fill is a
        // dark/light tint, so a start/end node's dark label would vanish.
        'color': nodeText,
      },
    },
    {
      selector: 'node.dimmed',
      style: {
        'opacity': 0.12,
      },
    },
    {
      // Disco-style "highlight slow activities" paint — applied to
      // any node whose avg_duration exceeds the visible-node median
      // when the user toggles the highlight-slow mode on.
      selector: 'node.slow',
      style: {
        'border-color': isDark ? '#f59e0b' : '#d97706',
        'border-width': 2,
        'background-color': isDark
          ? 'rgba(245, 158, 11, 0.12)'
          : 'rgba(217, 119, 6, 0.08)',
        'color': nodeText,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'vee',
        'arrow-scale': 0.8,
        'line-color': isDark ? '#3a3a40' : '#d4d7dc',
        'target-arrow-color': isDark ? '#3a3a40' : '#d4d7dc',
        'width': 1.5,
        // Opaque base edges render >2x faster than semi-transparent ones
        // (the canvas must read back existing pixels to composite alpha).
        // The .dimmed class still drives dimming via its own opacity.
        'opacity': 1,
        'label': 'data(label)',
        'min-zoomed-font-size': 9,
        'font-size': '9px',
        'font-family': 'JetBrains Mono, monospace',
        'font-weight': 500,
        'text-rotation': 'autorotate',
        'text-background-color': edgeTextBg,
        'text-background-opacity': 0.85,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
        'color': edgeTextColor,
        'text-margin-y': -8,
        'transition-property': 'line-color opacity width',
        'transition-duration': '0.15s',
      } as any,
    },
    {
      // Only apply data-mapped color when the data field is present
      selector: 'edge[color]',
      style: {
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
      },
    },
    {
      // Only apply data-mapped width when the data field is present
      selector: 'edge[width]',
      style: {
        'width': 'data(width)',
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': selectColor,
        'target-arrow-color': selectColor,
        'width': 3,
        'opacity': 1,
      },
    },
    {
      selector: 'edge.dimmed',
      style: {
        'opacity': 0.05,
      },
    },
    {
      // Semantic zoom: at overview scale we toggle this class on every
      // edge to drop the frequency labels entirely (beyond what
      // min-zoomed-font-size does), cutting render cost and clutter where
      // the most elements are on screen. Removed as the user zooms in.
      selector: 'edge.lod-far',
      style: {
        'text-opacity': 0,
      },
    },
  ];
}

/* ── Softer performance colors ────────────────────────────────────────── */

function softenColor(hex: string, isDark: boolean): string {
  // Map the harsh backend colors to softer variants
  const map: Record<string, [string, string]> = {
    '#22c55e': ['#4ade80', '#34d399'],  // green
    '#eab308': ['#d4a017', '#fbbf24'],  // yellow
    '#ef4444': ['#e57373', '#f87171'],  // red
  };
  const pair = map[hex?.toLowerCase()];
  if (pair) return isDark ? pair[1] : pair[0];
  // For unknown colors, return a muted default
  if (!hex || hex === '#3f3f46' || hex === '#94a3b8') {
    return isDark ? '#52525b' : '#94a3af';
  }
  return hex;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function scaleValue(
  value: number,
  min: number,
  max: number,
  outMin: number,
  outMax: number,
): number {
  if (max === min) return (outMin + outMax) / 2;
  return outMin + ((value - min) / (max - min)) * (outMax - outMin);
}

function getFilteredElements(
  nodes: ProcessNode[],
  edges: ProcessEdge[],
  complexity: number,
  annotations?: Annotation[],
  isDark = true,
  labelMode: 'absolute' | 'relative' = 'absolute',
  highlightSlow = false,
  hiddenActivities?: Set<string>,
  activityThreshold = 0,
) {
  if (nodes.length === 0) return { cyNodes: [], cyEdges: [], visibleNodeCount: 0, visibleEdgeCount: 0 };

  // Activity-frequency threshold (Apromore triple slider). Hide any
  // non-start/non-end activity whose frequency falls below the given
  // percentile of the frequency distribution. Start/end nodes are
  // always kept so the graph stays anchored.
  if (activityThreshold > 0) {
    const sorted = [...nodes.map((n) => n.frequency)].sort((a, b) => a - b);
    const idx = Math.floor((activityThreshold / 100) * sorted.length);
    const cutoff = sorted[idx] ?? 0;
    nodes = nodes.filter(
      (n) => n.is_start || n.is_end || n.frequency >= cutoff,
    );
    const kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  }

  // Hide-events filter (Celonis): drop nodes whose id or label the
  // user has chosen to hide, then drop edges that touch them.
  if (hiddenActivities && hiddenActivities.size > 0) {
    nodes = nodes.filter(
      (n) => !hiddenActivities.has(n.id) && !hiddenActivities.has(n.label),
    );
    const kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  }

  // Top-paths simplification: rank edges by frequency and keep the strongest
  // up to the detail level, with a bounded start/end connectivity guarantee.
  // (See simplifyGraph — this replaces the old "keep every start/end edge"
  // backbone that swallowed dense real-world logs like BPIC2019 whole.)
  const { nodes: visibleNodes, edges: connectedEdges } = simplifyGraph(nodes, edges, {
    complexity,
  });

  const freqs = visibleNodes.map((n) => n.frequency);
  const minFreq = Math.min(...freqs);
  const maxFreq = Math.max(...freqs);

  const edgeFreqs = connectedEdges.map((e) => e.frequency);
  const minEdgeFreq = Math.min(...edgeFreqs);
  const maxEdgeFreq = Math.max(...edgeFreqs);

  const annotatedNodeIds = new Set(
    (annotations || []).filter((a) => a.activity_name).map((a) => a.activity_name),
  );

  // Median dwell time across visible nodes — drives the highlight-slow
  // mode (Disco). Cheap to compute once up front.
  const dwellMedian = (() => {
    const ds = visibleNodes
      .map((n) => n.avg_duration ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    if (ds.length === 0) return 0;
    return ds[Math.floor(ds.length / 2)];
  })();

  // Total frequency across visible nodes — used to render relative
  // percentages when labelMode === 'relative'.
  const totalFreq = visibleNodes.reduce((s, n) => s + n.frequency, 0) || 1;

  const cyNodes = visibleNodes.map((node) => {
    // Tighter, more uniform sizing
    const w = scaleValue(node.frequency, minFreq, maxFreq, 100, 140);
    const h = scaleValue(node.frequency, minFreq, maxFreq, 38, 50);
    const classes: string[] = [];
    if (node.is_start) classes.push('start');
    if (node.is_end) classes.push('end');
    if (annotatedNodeIds.has(node.id)) classes.push('has-annotation');
    if (
      highlightSlow &&
      dwellMedian > 0 &&
      (node.avg_duration ?? 0) > dwellMedian
    ) {
      classes.push('slow');
    } else if (highlightSlow) {
      classes.push('dimmed');
    }

    const freqLabel =
      labelMode === 'relative'
        ? `${((node.frequency / totalFreq) * 100).toFixed(1)}%`
        : formatNumber(node.frequency);

    return {
      data: {
        id: node.id,
        label: `${node.label}\n${freqLabel}`,
        width: w,
        height: h,
        nodeData: node,
      },
      classes: classes.join(' '),
    };
  });

  const totalEdgeFreq = connectedEdges.reduce((s, e) => s + e.frequency, 0) || 1;

  const cyEdges = connectedEdges.map((edge) => {
    // Thinner edges: 1-4px instead of 1-8px
    const w = scaleValue(edge.frequency, minEdgeFreq, maxEdgeFreq, 1, 4);
    const color = softenColor(edge.performance_color || '', isDark);
    const label =
      labelMode === 'relative'
        ? `${((edge.frequency / totalEdgeFreq) * 100).toFixed(1)}%`
        : formatNumber(edge.frequency);

    return {
      data: {
        id: `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        label,
        width: w,
        color,
        edgeData: edge,
      },
    };
  });

  return { cyNodes, cyEdges, visibleNodeCount: visibleNodes.length, visibleEdgeCount: connectedEdges.length };
}

/* ── Selection + focus helpers ────────────────────────────────────────── */

// Apply the selection highlight + neighbourhood dimming for `selectedNode`.
// Batched so N class mutations collapse into a single redraw. Called when
// the selection changes AND after the element set is rebuilt — a
// filter/slider/theme change wipes selection state off the new elements,
// so without re-applying here the highlight would silently vanish.
function applySelectionHighlight(cy: Core, selectedNode?: string) {
  cy.batch(() => {
    cy.nodes().unselect().removeClass('dimmed');
    cy.edges().unselect().removeClass('dimmed');
    if (selectedNode) {
      const node = cy.getElementById(selectedNode);
      if (node.length > 0) {
        node.select();
        const nb = node.neighborhood().add(node);
        cy.elements().not(nb).addClass('dimmed');
      }
    }
  });
}

// Zoom-to-selection: frame a node + its neighbours on an EXPLICIT user tap.
// Skips the move when the node is already comfortably in view, and caps the
// zoom to a readable ceiling so an isolated node doesn't blow up to fill the
// canvas (cy.fit would otherwise clamp to the global maxZoom).
function focusOnNode(cy: Core, node: NodeSingular) {
  const nb = node.neighborhood().add(node);
  const bb = nb.boundingBox();
  const ext = cy.extent();
  const inView =
    bb.x1 >= ext.x1 && bb.x2 <= ext.x2 && bb.y1 >= ext.y1 && bb.y2 <= ext.y2;
  if (inView) return;
  const W = Math.max(cy.width() - 160, 50);
  const H = Math.max(cy.height() - 160, 50);
  const fitZoom = Math.min(W / Math.max(bb.w, 1), H / Math.max(bb.h, 1));
  const zoom = Math.max(cy.minZoom(), Math.min(fitZoom, 1.5));
  cy.stop();
  cy.animate(
    { zoom, center: { eles: nb } },
    { duration: 300, easing: 'ease-in-out-cubic' },
  );
}

/* ── Component ────────────────────────────────────────────────────────── */

const ProcessMap: React.FC<ProcessMapProps> = ({
  nodes,
  edges,
  complexity,
  onNodeClick,
  onEdgeClick,
  onBackgroundTap,
  selectedNode,
  annotations,
  layoutDirection = 'TB',
  layoutName = 'dagre',
  colorBy: _colorBy = 'performance',
  cyRef: externalCyRef,
  labelMode = 'absolute',
  highlightSlow = false,
  hiddenActivities,
  onAddActivityFilter,
  onContextMenu,
  showHoverTooltip = true,
  activityThreshold = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [isReady, setIsReady] = useState(false);
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  // Preserve-viewport: only auto-fit on the first real (non-empty) layout
  // and when the layout TYPE changes — never on a filter/slider/theme
  // change, so the camera stops teleporting to the whole graph.
  const hasInitialFitRef = useRef(false);
  const prevLayoutKeyRef = useRef('');
  // Last cursor position over the canvas (rendered px) so the zoom buttons
  // can anchor to where the user is looking instead of viewport center.
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  // Current level-of-detail state, to avoid redundant class toggles.
  const lodFarRef = useRef(false);
  // Minimap (cytoscape-navigator): a bird's-eye overlay so users jump
  // across a large graph by clicking the thumbnail instead of the slow
  // zoom-out / zoom-in loop. Off by default (clutter on small maps).
  const minimapRef = useRef<HTMLDivElement>(null);
  const navInstanceRef = useRef<{ destroy(): void } | null>(null);
  const navInitedRef = useRef(false);
  // Default the minimap open so the bird's-eye view is there without the user
  // having to discover the toggle (consistent across all graphs).
  const [showMinimap, setShowMinimap] = useState(true);

  // Latest selection, readable from the element-update effect (which must
  // NOT depend on selectedNode, or it would re-run the layout on every
  // selection). Lets us re-apply the highlight after an element rebuild.
  const selectedNodeRef = useRef<string | undefined>(selectedNode);
  selectedNodeRef.current = selectedNode;

  // Rich hover tooltip state (Disco): floating overlay positioned
  // relative to the cytoscape container with the node's full stats.
  const [hover, setHover] = useState<
    { node: ProcessNode; x: number; y: number } | null
  >(null);

  const runLayout = useCallback(
    (cy: Core, fit: boolean) => {
      const baseOpts = {
        animate: true,
        animationDuration: 250,
        animationEasing: 'ease-out',
        // Caller decides whether to re-fit. Filter/slider changes pass
        // false so the user's zoom/pan survives; only first load and a
        // layout-type switch pass true.
        fit,
        padding: 50,
      };
      let opts: any;
      switch (layoutName) {
        case 'breadthfirst':
          opts = { ...baseOpts, name: 'breadthfirst', directed: true, spacingFactor: 1.2 };
          break;
        case 'circle':
          opts = { ...baseOpts, name: 'circle' };
          break;
        case 'concentric':
          opts = { ...baseOpts, name: 'concentric', concentric: (node: any) => node.degree(), levelWidth: () => 2 };
          break;
        case 'grid':
          opts = { ...baseOpts, name: 'grid', rows: Math.ceil(Math.sqrt(cy.nodes().length)) };
          break;
        default: // dagre
          opts = { ...baseOpts, name: 'dagre', rankDir: layoutDirection, nodeSep: 60, rankSep: 70, edgeSep: 25 };
          break;
      }
      cy.one('layoutstop', () => {
        // Disconnected nodes pile up at a single point under the structure
        // layouts (dagre/breadthfirst) — the Alpha Miner in particular yields
        // a sparse model on noisy logs, leaving several activities with no
        // edges, which made the map look like "one node". Spread those
        // isolated nodes in a tidy grid beneath the connected graph so each is
        // individually visible (and its label readable). The other layouts
        // (grid/circle/concentric) already place every node, so we leave them.
        if (layoutName === 'dagre' || layoutName === 'breadthfirst') {
          const isolated = cy.nodes().filter((n: any) => n.degree(false) === 0);
          if (isolated.length > 1) {
            const connected = cy.nodes().filter((n: any) => n.degree(false) > 0);
            const bb = (connected.length ? connected : cy.nodes()).boundingBox();
            const cols = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
            const colW = 170;
            const rowH = 80;
            const startX = bb.x1;
            const startY = bb.y2 + 90;
            isolated.forEach((n: any, i: number) => {
              n.position({
                x: startX + (i % cols) * colW,
                y: startY + Math.floor(i / cols) * rowH,
              });
            });
          }
        }
        // Fit when the caller asked (first load / layout-type switch) OR when
        // the freshly-laid-out graph is poorly framed by the current viewport.
        // The latter catches an ALGORITHM switch: it re-lays-out with fit=false
        // to preserve the user's pan/zoom, but a much smaller model (e.g. DFG's
        // 42 nodes → Heuristic's 9) left at the previous zoom renders as a tiny
        // cramped cluster that reads as "all nodes on top of each other". A
        // small filter/slider tweak keeps a similar-sized graph, so it stays
        // put as intended.
        let shouldFit = fit;
        if (!shouldFit && cy.nodes().nonempty()) {
          const bb = cy.elements().boundingBox();
          const z = cy.zoom();
          const rw = bb.w * z;
          const rh = bb.h * z;
          const vw = cy.width();
          const vh = cy.height();
          const tooSmall = rw < vw * 0.3 && rh < vh * 0.3;
          const tooBig = rw > vw * 1.6 || rh > vh * 1.6;
          if (tooSmall || tooBig) shouldFit = true;
        }
        if (shouldFit) {
          // After the auto-fit (now including any re-arranged isolated nodes),
          // don't leave the graph at an unreadable zoom — a wide/dense map fits
          // at ~0.25-0.4 where labels are too small. Raise to a floor so
          // activity names are legible by default; the graph may overflow the
          // viewport (pan to see it all) but you no longer have to zoom in.
          cy.fit(undefined, 50);
          const FLOOR = 0.6;
          if (cy.zoom() < FLOOR) {
            cy.zoom(FLOOR);
            cy.center();
          }
        }
      });
      cy.layout(opts).run();
    },
    [layoutDirection, layoutName],
  );

  // Initialize cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: getCyStyles(isDark),
      // Wider range so dense graphs zoom out further and detail reads in
      // closer; combined with wheelSensitivity:1 the trip from the fit
      // floor to a legible close-up is short.
      minZoom: 0.15,
      maxZoom: 5,
      // 1.0 is cytoscape's calibrated default. 0.3 delivered only 30% of
      // the expected zoom per wheel tick — the "takes forever to zoom in".
      wheelSensitivity: 1.0,
      boxSelectionEnabled: false,
      // pixelRatio:'auto' keeps text crisp on HiDPI. We hide edges (not the
      // whole canvas) during a gesture: textureOnViewport blanks any region
      // you pan *into* until release, whereas hideEdgesOnViewport keeps nodes
      // live and only drops the expensive edges, snapping them back on stop.
      pixelRatio: 'auto',
      textureOnViewport: false,
      hideEdgesOnViewport: false,
      // Touch / mobile parity: allow pinch-to-zoom and one-finger pan
      // on touch devices so the map is usable on tablets and phones.
      // Cytoscape enables these by default, but we set them explicitly
      // so a future default change can't silently disable touch.
      userZoomingEnabled: true,
      userPanningEnabled: true,
    });

    cyRef.current = cy;
    if (externalCyRef) externalCyRef.current = cy;
    setIsReady(true);

    // Resize: re-sync the canvas bounding box but DO NOT re-fit — a
    // sidebar toggle / DevTools / window snap must not blow away the
    // user's zoom and pan.
    const handleResize = () => {
      cy.resize();
    };
    window.addEventListener('resize', handleResize);

    const container = containerRef.current;

    // Camera-yields-to-user: if the user grabs the graph mid-animation
    // (a programmatic fit/zoom-to-selection is running), stop it so their
    // input takes precedence instead of the camera "fighting back".
    const stopAnim = () => cy.stop();
    // Track the cursor over the canvas so the zoom buttons can anchor to
    // it rather than the geometric viewport center.
    const trackMouse = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      lastMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const clearMouse = () => { lastMouseRef.current = null; };
    container.addEventListener('wheel', stopAnim, { passive: true });
    container.addEventListener('mousedown', stopAnim);
    container.addEventListener('touchstart', stopAnim, { passive: true });
    container.addEventListener('mousemove', trackMouse);
    container.addEventListener('mouseleave', clearMouse);

    // Semantic zoom: hide edge frequency labels entirely at overview
    // scale. rAF-throttled and gated on a state ref so we only touch the
    // graph when crossing the threshold, not on every zoom frame.
    let lodRaf = 0;
    const onZoom = () => {
      if (lodRaf) return;
      lodRaf = requestAnimationFrame(() => {
        lodRaf = 0;
        const far = cy.zoom() < 0.55;
        if (far === lodFarRef.current) return;
        lodFarRef.current = far;
        cy.batch(() => { cy.edges().toggleClass('lod-far', far); });
      });
    };
    cy.on('zoom', onZoom);

    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('wheel', stopAnim);
      container.removeEventListener('mousedown', stopAnim);
      container.removeEventListener('touchstart', stopAnim);
      container.removeEventListener('mousemove', trackMouse);
      container.removeEventListener('mouseleave', clearMouse);
      cy.off('zoom', onZoom);
      if (lodRaf) cancelAnimationFrame(lodRaf);
      // Tear down the minimap before the core (its listeners go with cy).
      try { navInstanceRef.current?.destroy(); } catch { /* noop */ }
      navInstanceRef.current = null;
      navInitedRef.current = false;
      cy.destroy();
      cyRef.current = null;
      if (externalCyRef) externalCyRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update styles when theme changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;
    cy.style(getCyStyles(isDark) as any);
  }, [isDark, isReady]);

  // Memoize the cytoscape element array so filter + scale work only runs
  // when the upstream props actually change — not on every parent re-render
  // that happens to pass new object identities.
  const { cyNodes, cyEdges, visibleNodeCount, visibleEdgeCount } = useMemo(
    () =>
      getFilteredElements(
        nodes,
        edges,
        complexity,
        annotations,
        isDark,
        labelMode,
        highlightSlow,
        hiddenActivities,
        activityThreshold,
      ),
    [nodes, edges, complexity, annotations, isDark, labelMode, highlightSlow, hiddenActivities, activityThreshold],
  );

  // Update elements
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;

    cy.elements().remove();
    cy.add([...cyNodes, ...cyEdges] as any);

    // Decide whether to re-fit. Fit ONLY on (a) the first non-empty
    // layout, or (b) a change of layout type/direction (positions change
    // wholesale). A filter/slider/theme change re-runs layout with
    // fit:false so the viewport stays exactly where the user left it.
    const layoutKey = `${layoutName}:${layoutDirection}`;
    const layoutChanged =
      prevLayoutKeyRef.current !== '' && prevLayoutKeyRef.current !== layoutKey;
    const doFit = (!hasInitialFitRef.current || layoutChanged) && cyNodes.length > 0;

    runLayout(cy, doFit);
    if (doFit) hasInitialFitRef.current = true;
    // Only record the layout key for passes that actually laid out a
    // non-empty graph, so an empty/loading pass can't mis-gate the first
    // real fit.
    if (cyNodes.length > 0) prevLayoutKeyRef.current = layoutKey;
    // Re-apply LOD state to freshly-added edges at the current zoom.
    if (lodFarRef.current) cy.edges().addClass('lod-far');
    // The re-added elements carry no selection state — re-apply the
    // highlight/dimming so it survives a filter/slider/theme change.
    applySelectionHighlight(cy, selectedNodeRef.current);
  }, [cyNodes, cyEdges, isReady, runLayout, layoutName, layoutDirection]);

  // Click / hover / context-menu events
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;

    const handleNodeTap = (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      const nodeData = node.data('nodeData') as ProcessNode;
      if (nodeData && onNodeClick) onNodeClick(nodeData);
      if (nodeData && onAddActivityFilter) onAddActivityFilter(nodeData.label);
      // Zoom-to-selection is driven from the explicit user tap — NOT the
      // selectedNode prop — so programmatic/external selection (AI "show
      // details", side-by-side sync) never yanks the camera, and it can't
      // race the first-load fit.
      focusOnNode(cy, node);
    };

    const handleEdgeTap = (evt: EventObject) => {
      const edge = evt.target as EdgeSingular;
      const edgeData = edge.data('edgeData') as ProcessEdge;
      if (edgeData && onEdgeClick) onEdgeClick(edgeData);
    };

    // Tap on empty canvas → let the parent clear the selection (un-dim).
    // cytoscape fires this generic 'tap' for every tap; we act only when the
    // target is the core (i.e. background), so node/edge taps are unaffected.
    const handleBackgroundTap = (evt: EventObject) => {
      if (evt.target === cy && onBackgroundTap) onBackgroundTap();
    };

    // Hover tooltip — mouseover/mouseout on nodes. We compute a
    // container-relative pixel position from the cy rendered position.
    const containerEl = cy.container();
    const handleNodeHoverIn = (evt: EventObject) => {
      if (!showHoverTooltip) return;
      const node = evt.target as NodeSingular;
      const nodeData = node.data('nodeData') as ProcessNode;
      if (!nodeData) return;
      const pos = node.renderedPosition();
      setHover({ node: nodeData, x: pos.x, y: pos.y });
    };
    const handleNodeHoverOut = () => setHover(null);

    // Right-click context menu (Signavio). cytoscape emits `cxttap`
    // for right-click on elements. We translate the renderedPosition
    // to container-relative pixel coordinates for the overlay.
    const handleNodeCxt = (evt: EventObject) => {
      if (!onContextMenu) return;
      const node = evt.target as NodeSingular;
      const nodeData = node.data('nodeData') as ProcessNode;
      if (!nodeData) return;
      const rect = containerEl?.getBoundingClientRect();
      const pos = node.renderedPosition();
      onContextMenu(nodeData, {
        x: (rect?.left ?? 0) + pos.x,
        y: (rect?.top ?? 0) + pos.y,
      });
    };

    cy.on('tap', 'node', handleNodeTap);
    cy.on('tap', 'edge', handleEdgeTap);
    cy.on('tap', handleBackgroundTap);
    cy.on('mouseover', 'node', handleNodeHoverIn);
    cy.on('mouseout', 'node', handleNodeHoverOut);
    cy.on('cxttap', 'node', handleNodeCxt);

    return () => {
      cy.off('tap', 'node', handleNodeTap);
      cy.off('tap', 'edge', handleEdgeTap);
      cy.off('tap', handleBackgroundTap);
      cy.off('mouseover', 'node', handleNodeHoverIn);
      cy.off('mouseout', 'node', handleNodeHoverOut);
      cy.off('cxttap', 'node', handleNodeCxt);
    };
  }, [onNodeClick, onEdgeClick, onBackgroundTap, onAddActivityFilter, onContextMenu, showHoverTooltip, isReady]);

  // Selection highlight (dimming only). Zoom-to-selection is handled in
  // the node-tap handler so only an explicit user click moves the camera,
  // never a programmatic/external selection change.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;
    applySelectionHighlight(cy, selectedNode);
  }, [selectedNode, isReady]);

  // Minimap lifecycle — init the cytoscape-navigator into its container
  // when toggled on (and the graph is ready); tear it down when toggled
  // off or on unmount. Best-effort: never let it break the map.
  // Create the navigator ONCE, the first time the user enables it (and the
  // graph is ready); thereafter we just show/hide the container with CSS.
  // cytoscape-navigator's destroy() does NOT unbind the zoom/pan/render
  // listeners it puts on the core, so re-creating it on every toggle would
  // leak a growing set of handlers. Creating it once sidesteps that; it's
  // torn down with the cy instance on unmount (see the init effect cleanup).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady || !showMinimap || navInitedRef.current) return;
    // Mark inited up-front so a throw can't trigger a retry storm that
    // partially re-binds listeners; cy.destroy() on unmount cleans up.
    navInitedRef.current = true;
    try {
      // cytoscape-navigator augments the core with .navigator() but ships
      // no types; cast narrowly to the surface we use. NB: in 2.0.2 the
      // `container` option ONLY accepts a string selector — passing the DOM
      // node makes the lib append an unstyled 400x400 panel to <body>.
      const withNav = cy as unknown as {
        navigator(o: Record<string, unknown>): { destroy(): void };
      };
      navInstanceRef.current = withNav.navigator({
        container: '#processmap-minimap',
        viewLiveFramerate: 0,        // redraw the viewport box on demand, not every frame
        thumbnailEventFramerate: 30, // cap thumbnail refreshes
        dblClickDelay: 200,
        removeCustomContainer: false, // keep our React-owned div on destroy
      });
    } catch (err) {
      console.warn('ProcessMap minimap init failed', err);
    }
  }, [showMinimap, isReady]);

  // Anchor button zoom to the cursor's last position over the canvas (so
  // the region you're looking at stays put), falling back to the viewport
  // center when the pointer isn't over the graph.
  const zoomAnchor = useCallback((cy: Core) => {
    const m = lastMouseRef.current;
    if (m && m.x >= 0 && m.y >= 0 && m.x <= cy.width() && m.y <= cy.height()) {
      return m;
    }
    return { x: cy.width() / 2, y: cy.height() / 2 };
  }, []);

  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.stop();
    cy.animate(
      { zoom: { level: Math.min(cy.zoom() * 1.3, cy.maxZoom()), renderedPosition: zoomAnchor(cy) } },
      { duration: 150, easing: 'ease-out' },
    );
  }, [zoomAnchor]);

  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.stop();
    cy.animate(
      { zoom: { level: Math.max(cy.zoom() / 1.3, cy.minZoom()), renderedPosition: zoomAnchor(cy) } },
      { duration: 150, easing: 'ease-out' },
    );
  }, [zoomAnchor]);

  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.stop();
    // Deliberate "show me everything" — read it as a smooth camera move,
    // not a teleport.
    cy.animate(
      { fit: { eles: cy.elements(), padding: 50 } },
      { duration: 400, easing: 'ease-in-out-cubic' },
    );
  }, []);

  return (
    <div className="relative w-full h-full min-h-0 rounded-lg overflow-hidden bg-surface-2">
      {/* Floating controls — bottom-right for less visual clutter */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-px rounded-lg border border-line bg-surface-2/95 backdrop-blur-md p-0.5 shadow-sm">
        <button
          onClick={handleZoomIn}
          className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={handleZoomOut}
          className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <div className="w-px h-5 bg-line mx-0.5" />
        <button
          onClick={handleFit}
          className="p-2 rounded-md text-fg-muted hover:bg-tint hover:text-fg transition-colors"
          title="Fit to screen"
        >
          <Maximize2 size={14} />
        </button>
        <button
          onClick={() => setShowMinimap((v) => !v)}
          className={`p-2 rounded-md transition-colors ${
            showMinimap
              ? 'bg-accent/10 text-accent'
              : 'text-fg-muted hover:bg-tint hover:text-fg'
          }`}
          title={showMinimap ? 'Hide minimap' : 'Show minimap'}
          aria-pressed={showMinimap}
        >
          <MapIcon size={14} />
        </button>
        <ExportMenu
          cyRef={cyRef}
          nodes={nodes}
          edges={edges}
          isDark={isDark}
        />
      </div>

      {/* Minimap (cytoscape-navigator) — bird's-eye overview for jumping
          around large graphs without the zoom-out/zoom-in loop. Always in
          the DOM (the navigator resolves it by id) but hidden until toggled.
          The `cytoscape-navigator` class is needed for the library's inner
          canvas/thumbnail CSS; the inline styles override its default
          position:fixed 400x400 so it sits as a 180x120 box top-right. */}
      <div
        id="processmap-minimap"
        ref={minimapRef}
        className="cytoscape-navigator overflow-hidden rounded-lg border border-line shadow-md"
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          bottom: 'auto',
          left: 'auto',
          width: 180,
          height: 120,
          zIndex: 10,
          background: isDark ? '#1e1e22' : '#ffffff',
          display: showMinimap ? 'block' : 'none',
        }}
      />

      {/* Annotation count */}
      {annotations && annotations.length > 0 && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1.5 rounded-md border border-line bg-surface-2/95 backdrop-blur-md px-2.5 py-1.5 text-[10px] text-fg-muted">
          <MessageSquare size={11} className="text-accent" />
          <span>{annotations.length} annotation{annotations.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Empty state */}
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <Maximize2 className="w-7 h-7 text-fg-ghost mx-auto mb-2" />
            <p className="text-[12px] font-medium text-fg-muted">No process data</p>
            <p className="text-[10px] text-fg-faint mt-0.5">Upload an event log to discover the process map</p>
          </div>
        </div>
      )}

      {/* Cytoscape canvas.
          A11y: cytoscape renders to a <canvas>, which is opaque to
          screen readers. We label the container as an image/graph and
          pair it with a visually-hidden text summary (below) so AT
          users get the node/edge counts. ``touch-action: none`` hands
          all touch gestures to cytoscape so pinch-to-zoom and pan work
          on mobile without the browser hijacking them for page scroll. */}
      <div
        ref={containerRef}
        role="img"
        aria-label={`Process map graph showing ${visibleNodeCount} ${
          visibleNodeCount === 1 ? 'activity' : 'activities'
        } and ${visibleEdgeCount} ${
          visibleEdgeCount === 1 ? 'transition' : 'transitions'
        }. Use the on-screen zoom controls, or pinch to zoom and drag to pan on touch devices.`}
        className="w-full h-full"
        style={{ touchAction: 'none' }}
      />

      {/* Visually-hidden summary for screen readers — kept in sync with
          the rendered graph so non-visual users get the headline
          counts the canvas can't expose. */}
      <p className="sr-only" aria-live="polite">
        Discovered process map with {visibleNodeCount}{' '}
        {visibleNodeCount === 1 ? 'activity' : 'activities'} and{' '}
        {visibleEdgeCount}{' '}
        {visibleEdgeCount === 1 ? 'transition' : 'transitions'} currently
        visible.
      </p>

      {/* Rich hover tooltip (Disco-style) — absolutely positioned
          relative to the map container. Shows abs/rel frequency, mean
          duration, and start/end flags so the user gets the headline
          stats without clicking. */}
      {hover && showHoverTooltip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <div className="font-semibold text-fg">{hover.node.label}</div>
          <div className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-fg-muted">
            <span>Frequency</span>
            <span className="tabular-nums text-fg-secondary">
              {formatNumber(hover.node.frequency)}
            </span>
            {hover.node.avg_duration != null && (
              <>
                <span>Avg dwell</span>
                <span className="tabular-nums text-fg-secondary">
                  {formatDuration(hover.node.avg_duration)}
                </span>
              </>
            )}
            {hover.node.median_duration != null && (
              <>
                <span>Median</span>
                <span className="tabular-nums text-fg-secondary">
                  {formatDuration(hover.node.median_duration)}
                </span>
              </>
            )}
            {hover.node.is_start && (
              <>
                <span className="text-success">Role</span>
                <span className="text-success">start</span>
              </>
            )}
            {hover.node.is_end && (
              <>
                <span className="text-danger">Role</span>
                <span className="text-danger">end</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProcessMap;
