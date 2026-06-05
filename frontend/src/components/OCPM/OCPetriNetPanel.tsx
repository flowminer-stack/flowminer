import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { ocel } from '@/api/client';
import { useUIStore } from '@/store';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCached, setCached } from '@/store/analysisCache';
import type { OCPetriNetResponse } from '@/types';

// ─── OCEL-Native: OC Petri Net (activity coverage) ────────────────────────────

export default function OCPetriNetPanel({ ocelId }: { ocelId: string }) {
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
  // Remembered zoom/pan so a theme rebuild doesn't snap back to the whole graph.
  const viewRef = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
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
        { selector: 'node.activity', style: { 'label': 'data(label)', 'background-color': nodeBg, 'border-width': 1, 'border-color': nodeBorder, 'shape': 'roundrectangle', 'width': 'label', 'height': 'label', 'padding': '8px', 'font-size': '10px', 'font-family': 'Manrope, sans-serif', 'text-valign': 'center', 'text-halign': 'center', 'color': nodeText, 'min-zoomed-font-size': 9 } as any },
        { selector: 'node.objtype', style: { 'label': 'data(label)', 'background-color': isDark ? '#083344' : '#ecfeff', 'border-width': 2, 'border-color': '#06b6d4', 'shape': 'roundrectangle', 'width': 'label', 'height': 'label', 'padding': '12px', 'font-size': '11px', 'font-weight': 700, 'font-family': 'Manrope, sans-serif', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': '120px', 'color': '#06b6d4', 'min-zoomed-font-size': 9 } as any },
        { selector: 'edge', style: { 'width': 1, 'line-color': edgeColor, 'target-arrow-shape': 'none', 'opacity': 0.4, 'curve-style': 'bezier' } as any },
      ],
      layout: { name: 'cose', animate: false, fit: !viewRef.current, nodeRepulsion: () => 30000, idealEdgeLength: () => 80, gravity: 0.5, padding: 30 } as any,
      userZoomingEnabled: true, userPanningEnabled: true, minZoom: 0.15, maxZoom: 5, wheelSensitivity: 1.0, pixelRatio: 1, textureOnViewport: true,
    });

    if (viewRef.current) cy.viewport({ zoom: viewRef.current.zoom, pan: viewRef.current.pan });

    return () => {
      viewRef.current = { zoom: cy.zoom(), pan: { ...cy.pan() } };
      cy.destroy();
    };
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
