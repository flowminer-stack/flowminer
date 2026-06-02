import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import cytoscape, { Core, EventObject, NodeSingular, EdgeSingular } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  MessageSquare,
} from 'lucide-react';
import { formatNumber } from '../../utils/format';
import type { ProcessNode, ProcessEdge, Annotation } from '../../types';
import { useUIStore } from '../../store';
import ExportMenu from './ExportMenu';

cytoscape.use(dagre);

export type LayoutName = 'dagre' | 'breadthfirst' | 'circle' | 'concentric' | 'grid';

interface ProcessMapProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  complexity: number;
  onNodeClick?: (node: ProcessNode) => void;
  onEdgeClick?: (edge: ProcessEdge) => void;
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
  const startColor = isDark ? '#34d399' : '#059669';
  const startBg = isDark ? 'rgba(52, 211, 153, 0.06)' : 'rgba(5, 150, 105, 0.06)';
  const endColor = isDark ? '#f87171' : '#dc2626';
  const endBg = isDark ? 'rgba(248, 113, 113, 0.06)' : 'rgba(220, 38, 38, 0.06)';
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
        'font-size': '10px',
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
        'opacity': 0.7,
        'label': 'data(label)',
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

  // Identify start and end node IDs
  const startIds = new Set(nodes.filter((n) => n.is_start).map((n) => n.id));
  const endIds = new Set(nodes.filter((n) => n.is_end).map((n) => n.id));

  // Step 1: Always keep edges connected to start or end nodes (structural backbone)
  const backboneEdges: ProcessEdge[] = [];
  const otherEdges: ProcessEdge[] = [];
  for (const edge of edges) {
    if (startIds.has(edge.source) || startIds.has(edge.target) ||
        endIds.has(edge.source) || endIds.has(edge.target)) {
      backboneEdges.push(edge);
    } else {
      otherEdges.push(edge);
    }
  }

  // Step 2: From the remaining edges, take top-N by frequency based on complexity
  const sortedOther = [...otherEdges].sort((a, b) => b.frequency - a.frequency);
  const otherCount = Math.max(0, Math.ceil((complexity / 100) * sortedOther.length));
  const selectedOther = sortedOther.slice(0, otherCount);

  // Step 3: Merge backbone + selected edges
  const allVisibleEdges = [...backboneEdges, ...selectedOther];

  // Step 4: Collect visible node IDs from visible edges
  const visibleNodeIds = new Set<string>();
  for (const edge of allVisibleEdges) {
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }
  // Always include start/end nodes themselves
  for (const id of startIds) visibleNodeIds.add(id);
  for (const id of endIds) visibleNodeIds.add(id);

  // Step 5: Final filter — only keep edges where both endpoints made it through
  const connectedEdges = allVisibleEdges.filter(
    (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
  );

  const visibleNodes = nodes.filter((n) => visibleNodeIds.has(n.id));

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

/* ── Component ────────────────────────────────────────────────────────── */

const ProcessMap: React.FC<ProcessMapProps> = ({
  nodes,
  edges,
  complexity,
  onNodeClick,
  onEdgeClick,
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

  // Rich hover tooltip state (Disco): floating overlay positioned
  // relative to the cytoscape container with the node's full stats.
  const [hover, setHover] = useState<
    { node: ProcessNode; x: number; y: number } | null
  >(null);

  const runLayout = useCallback(
    (cy: Core) => {
      const baseOpts = {
        animate: true,
        animationDuration: 250,
        animationEasing: 'ease-out',
        fit: true,
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
      minZoom: 0.3,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      boxSelectionEnabled: false,
      pixelRatio: 2,
      textureOnViewport: false,
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

    const handleResize = () => {
      cy.resize();
      cy.fit(undefined, 50);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
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
    runLayout(cy);
  }, [cyNodes, cyEdges, isReady, runLayout]);

  // Click / hover / context-menu events
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;

    const handleNodeTap = (evt: EventObject) => {
      const node = evt.target as NodeSingular;
      const nodeData = node.data('nodeData') as ProcessNode;
      if (nodeData && onNodeClick) onNodeClick(nodeData);
      if (nodeData && onAddActivityFilter) onAddActivityFilter(nodeData.label);
    };

    const handleEdgeTap = (evt: EventObject) => {
      const edge = evt.target as EdgeSingular;
      const edgeData = edge.data('edgeData') as ProcessEdge;
      if (edgeData && onEdgeClick) onEdgeClick(edgeData);
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
    cy.on('mouseover', 'node', handleNodeHoverIn);
    cy.on('mouseout', 'node', handleNodeHoverOut);
    cy.on('cxttap', 'node', handleNodeCxt);

    return () => {
      cy.off('tap', 'node', handleNodeTap);
      cy.off('tap', 'edge', handleEdgeTap);
      cy.off('mouseover', 'node', handleNodeHoverIn);
      cy.off('mouseout', 'node', handleNodeHoverOut);
      cy.off('cxttap', 'node', handleNodeCxt);
    };
  }, [onNodeClick, onEdgeClick, onAddActivityFilter, onContextMenu, showHoverTooltip, isReady]);

  // Selection highlight
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !isReady) return;

    cy.nodes().unselect().removeClass('dimmed');
    cy.edges().unselect().removeClass('dimmed');

    if (selectedNode) {
      const node = cy.getElementById(selectedNode);
      if (node.length > 0) {
        node.select();
        const neighborhood = node.neighborhood().add(node);
        cy.elements().not(neighborhood).addClass('dimmed');
      }
    }
  }, [selectedNode, isReady]);

  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ zoom: { level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 } as any);
  }, []);

  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ zoom: { level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 } as any);
  }, []);

  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 50 }, duration: 200 } as any);
  }, []);

  return (
    <div className="relative w-full h-full min-h-[400px] rounded-lg overflow-hidden bg-surface-2">
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
        <ExportMenu
          cyRef={cyRef}
          nodes={nodes}
          edges={edges}
          isDark={isDark}
        />
      </div>

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
                  {formatDurationShort(hover.node.avg_duration)}
                </span>
              </>
            )}
            {hover.node.median_duration != null && (
              <>
                <span>Median</span>
                <span className="tabular-nums text-fg-secondary">
                  {formatDurationShort(hover.node.median_duration)}
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

function formatDurationShort(s: number): string {
  if (!s && s !== 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export default ProcessMap;
