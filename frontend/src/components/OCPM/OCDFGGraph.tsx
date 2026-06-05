import { useEffect, useRef, useCallback } from 'react';
import { Boxes, Maximize2 } from 'lucide-react';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

try { cytoscape.use(dagre); } catch { /* already registered */ }
import type { Core } from 'cytoscape';
import { useUIStore } from '@/store';
import type { OCELSummary, OCDFGResponse } from '@/types';
import { getTypeColor, formatNumber } from './shared';

// ─── OC-DFG Cytoscape graph ───────────────────────────────────────────────────

export default function OCDFGGraph({
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

    // Preserve the user's zoom/pan across a rebuild (e.g. a theme toggle)
    // so the camera doesn't snap back to the whole graph.
    const prevView = cyRef.current
      ? { zoom: cyRef.current.zoom(), pan: { ...cyRef.current.pan() } }
      : null;
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
            // Opaque edges-with-arrows render >2x faster than
            // semi-transparent ones; the colour already reads as light.
            'opacity': 1,
            'label': 'data(label)',
            'min-zoomed-font-size': 9,
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
        fit: !prevView,
        padding: 50,
      } as any,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.15,
      maxZoom: 5,
      // 1.0 is cytoscape's calibrated default; 0.3 made wheel zoom ~3x
      // slower than every other app. pixelRatio:1 + textureOnViewport
      // keep pan/zoom cheap on HiDPI.
      wheelSensitivity: 1.0,
      pixelRatio: 'auto',
      textureOnViewport: true,
    });

    if (prevView) cy.viewport({ zoom: prevView.zoom, pan: prevView.pan });
    else if (cy.zoom() < 0.6) { cy.zoom(0.6); cy.center(); } // readable label floor
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
