import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { ocel } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';
import type { ObjectsGraphResponse } from '@/types';

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
            'label': 'data(label)', 'min-zoomed-font-size': 9, 'font-size': '9px', 'font-family': 'JetBrains Mono, monospace',
            'text-rotation': 'autorotate', 'color': isDark ? '#71717a' : '#6c7283',
            'text-background-color': isDark ? '#1e1e22' : '#f7f8fa',
            'text-background-opacity': 0.85, 'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle', 'text-margin-y': -8,
          } as any,
        },
      ],
      layout: { name: 'circle', padding: 60, animate: false } as any,
      userZoomingEnabled: true, userPanningEnabled: true, minZoom: 0.15, maxZoom: 5, wheelSensitivity: 1.0, pixelRatio: 'auto', textureOnViewport: true,
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

export default function ObjectGraphPanel({ ocelId }: { ocelId: string }) {
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
