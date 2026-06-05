import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Users, ArrowRight, ArrowRightLeft, Maximize2 } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import cytoscape from 'cytoscape';
import type { Core } from 'cytoscape';
import { useEventLogData } from '@/hooks/useProcessMining';
import { FLUID_CY_OPTS } from '@/utils/cyFluid';
import { mining } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import { useUIStore } from '@/store';
import type { SocialNetworkResponse, SocialNetworkNode } from '@/types';
import { getCached, setCached } from '@/store/analysisCache';

function scaleLinear(value: number, min: number, max: number, outMin: number, outMax: number): number {
  if (max === min) return (outMin + outMax) / 2;
  return outMin + ((value - min) / (max - min)) * (outMax - outMin);
}

interface SelectedResource {
  node: SocialNetworkNode;
  outgoing: Array<{ target: string; frequency: number }>;
  incoming: Array<{ source: string; frequency: number }>;
  totalHandovers: number;
}

export default function SocialNetworkPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  const { eventLog } = useEventLogData(eventLogId);
  const cached = eventLogId ? getCached<SocialNetworkResponse>(eventLogId, 'social_network') : null;
  const [data, setData] = useState<SocialNetworkResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [selected, setSelected] = useState<SelectedResource | null>(null);

  const cyContainerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!eventLogId) return;
    if (retryCount === 0) {
      const existing = getCached<SocialNetworkResponse>(eventLogId, 'social_network');
      if (existing) { setData(existing); setLoading(false); return; }
    }
    setLoading(true);
    setError(null);
    mining
      .getSocialNetwork(eventLogId)
      .then((d) => { setCached(eventLogId, 'social_network', d); setData(d); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load social network'))
      .finally(() => setLoading(false));
  }, [eventLogId, retryCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeSelect = useCallback((nodeId: string) => {
    if (!data) return;
    const node = data.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const outgoing = data.edges
      .filter((e) => e.source === nodeId)
      .map((e) => ({ target: e.target, frequency: e.frequency }))
      .sort((a, b) => b.frequency - a.frequency);

    const incoming = data.edges
      .filter((e) => e.target === nodeId)
      .map((e) => ({ source: e.source, frequency: e.frequency }))
      .sort((a, b) => b.frequency - a.frequency);

    setSelected({
      node,
      outgoing,
      incoming,
      totalHandovers: outgoing.reduce((s, e) => s + e.frequency, 0) + incoming.reduce((s, e) => s + e.frequency, 0),
    });

    // Highlight in cytoscape
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('highlighted dimmed');
    cy.edges().removeClass('highlighted dimmed');

    const cyNode = cy.getElementById(nodeId);
    if (cyNode.length > 0) {
      const neighborhood = cyNode.neighborhood().add(cyNode);
      neighborhood.addClass('highlighted');
      cy.elements().not(neighborhood).addClass('dimmed');
    }
  }, [data]);

  const handleDeselect = useCallback(() => {
    setSelected(null);
    const cy = cyRef.current;
    if (cy) {
      cy.nodes().removeClass('highlighted dimmed');
      cy.edges().removeClass('highlighted dimmed');
    }
  }, []);

  const handleNodeSelectRef = useRef(handleNodeSelect);
  handleNodeSelectRef.current = handleNodeSelect;

  const handleDeselectRef = useRef(handleDeselect);
  handleDeselectRef.current = handleDeselect;

  // Build cytoscape graph
  useEffect(() => {
    if (!data || !cyContainerRef.current) return;
    if (data.nodes.length === 0) return;

    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const accent = isDark ? '#06b6d4' : '#4f63b2';
    const nodeBg = isDark ? '#2a2a30' : '#ffffff';
    const nodeBorder = isDark ? '#44444c' : '#c8cbd4';
    const nodeText = isDark ? '#e0e0e4' : '#1a1d24';
    const edgeColor = isDark ? '#4a8aaa' : '#7a9abb';
    const edgeTextBg = isDark ? '#1e1e22' : '#f7f8fa';
    const edgeTextColor = isDark ? '#71717a' : '#6c7283';

    const freqs = data.nodes.map((n) => n.frequency);
    const minFreq = Math.min(...freqs);
    const maxFreq = Math.max(...freqs);

    const edgeFreqs = data.edges.map((e) => e.frequency);
    const minEdgeFreq = edgeFreqs.length > 0 ? Math.min(...edgeFreqs) : 1;
    const maxEdgeFreq = edgeFreqs.length > 0 ? Math.max(...edgeFreqs) : 1;

    const elements: cytoscape.ElementDefinition[] = [
      ...data.nodes.map((node) => ({
        data: {
          id: node.id,
          label: `${node.label}\n${node.frequency}`,
          frequency: node.frequency,
          size: scaleLinear(node.frequency, minFreq, maxFreq, 50, 100),
        },
      })),
      ...data.edges.map((edge) => ({
        data: {
          id: `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          frequency: edge.frequency,
          label: String(edge.frequency),
          width: scaleLinear(edge.frequency, minEdgeFreq, maxEdgeFreq, 1, 5),
        },
      })),
    ];

    const cy = cytoscape({
      container: cyContainerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'text-wrap': 'wrap',
            'text-max-width': '100px',
            'font-size': '11px',
            'font-family': 'Manrope, system-ui, sans-serif',
            'font-weight': 600,
            'background-color': nodeBg,
            'border-width': 1.5,
            'border-color': nodeBorder,
            'shape': 'ellipse',
            'width': 'data(size)',
            'height': 'data(size)',
            'text-valign': 'center',
            'text-halign': 'center',
            'color': nodeText,
            'min-zoomed-font-size': 9,
            'transition-property': 'border-color border-width opacity background-color',
            'transition-duration': '0.15s',
          } as any,
        },
        {
          selector: 'node.highlighted',
          style: {
            'border-color': accent,
            'border-width': 3,
            'background-color': isDark ? 'rgba(6, 182, 212, 0.1)' : 'rgba(79, 99, 178, 0.08)',
            'z-index': 999,
          } as any,
        },
        {
          selector: 'node.dimmed',
          style: {
            'opacity': 0.15,
          } as any,
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'target-arrow-shape': 'vee',
            'arrow-scale': 0.7,
            'line-color': edgeColor,
            'target-arrow-color': edgeColor,
            'width': 'data(width)',
            'opacity': 0.5,
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
            'transition-property': 'line-color opacity width',
            'transition-duration': '0.15s',
          } as any,
        },
        {
          selector: 'edge.highlighted',
          style: {
            'line-color': accent,
            'target-arrow-color': accent,
            'opacity': 0.9,
            'width': 3,
            'z-index': 999,
          } as any,
        },
        {
          selector: 'edge.dimmed',
          style: {
            'opacity': 0.06,
          } as any,
        },
      ],
      layout: {
        name: 'circle',
        padding: 40,
        animate: false,
        ready: () => {
          // auto-fit after layout so the network fills the canvas
          setTimeout(() => cyRef.current?.fit(undefined, 40), 0);
        },
      } as any,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      ...FLUID_CY_OPTS,
    });

    cyRef.current = cy;

    // Node click handler
    cy.on('tap', 'node', (evt) => {
      const nodeId = evt.target.id();
      handleNodeSelectRef.current(nodeId);
    });

    // Background click to deselect
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        handleDeselectRef.current();
      }
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, isDark]);

  if (loading) {
    return <LoadingSpinner size="lg" text="Building social network..." fullPage />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={retry} />;
  }

  const hasNoResources = !loading && !error && data && data.nodes.length === 0;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <PageHeader
        title="Resource Handover Network"
        icon={Users}
        backTo={-1}
        description="Visualizes how work passes between resources. Node size reflects event volume; edge thickness reflects handover frequency."
        subtitle={
          data
            ? `${eventLog?.name ?? 'Event Log'} — ${data.total_resources} resources, ${data.total_handovers.toLocaleString()} handovers`
            : (eventLog?.name ?? 'Event Log')
        }
        actions={
          data && data.nodes.length > 0 ? (
            <button
              onClick={() => { handleDeselect(); cyRef.current?.fit(undefined, 50); }}
              className="btn-ghost text-xs"
            >
              <Maximize2 size={13} />
              Fit View
            </button>
          ) : undefined
        }
      />

      {/* Main content */}
      <div className="mt-4 flex flex-1 gap-4 overflow-hidden">
        {/* Graph */}
        <div className="relative flex-1 overflow-hidden rounded-lg border border-line bg-surface-2">
          {hasNoResources && (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <Users size={40} className="mx-auto mb-3 text-fg-ghost" />
                <p className="text-[13px] font-medium text-fg-secondary">No resource data available</p>
                <p className="mt-1 text-[12px] text-fg-muted">
                  Upload an event log with a resource column to see the handover network.
                </p>
              </div>
            </div>
          )}
          <div
            ref={cyContainerRef}
            className="h-full w-full"
            style={{ display: hasNoResources ? 'none' : undefined }}
          />
        </div>

        {/* Side panel */}
        <div className="card w-72 shrink-0 overflow-y-auto">
          <div className="border-b border-line px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-fg-secondary">
              {selected ? selected.node.label : 'Resources'}
            </h2>
            {selected && (
              <button
                onClick={handleDeselect}
                className="mt-1 text-[11px] text-accent hover:underline"
              >
                Clear selection
              </button>
            )}
          </div>

          {selected ? (
            <div className="p-4 space-y-4">
              {/* Stats */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-fg-muted">Events handled</span>
                  <span className="text-[12px] font-semibold text-fg">{selected.node.frequency}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-fg-muted">Total handovers</span>
                  <span className="text-[12px] font-semibold text-fg">{selected.totalHandovers}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-fg-muted">Hands off to</span>
                  <span className="text-[12px] font-semibold text-fg">{selected.outgoing.length} resources</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-fg-muted">Receives from</span>
                  <span className="text-[12px] font-semibold text-fg">{selected.incoming.length} resources</span>
                </div>
              </div>

              {/* Outgoing */}
              {selected.outgoing.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-2">
                    Hands off to
                  </h3>
                  <div className="space-y-1">
                    {selected.outgoing.map((e) => (
                      <div
                        key={e.target}
                        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 bg-tint/40 cursor-pointer hover:bg-tint transition-colors"
                        onClick={() => handleNodeSelect(e.target)}
                      >
                        <ArrowRight size={11} className="shrink-0 text-accent" />
                        <span className="text-[12px] text-fg-secondary truncate flex-1">{e.target}</span>
                        <span className="text-[11px] font-mono font-semibold text-fg-muted">{e.frequency}x</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Incoming */}
              {selected.incoming.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-2">
                    Receives from
                  </h3>
                  <div className="space-y-1">
                    {selected.incoming.map((e) => (
                      <div
                        key={e.source}
                        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 bg-tint/40 cursor-pointer hover:bg-tint transition-colors"
                        onClick={() => handleNodeSelect(e.source)}
                      >
                        <ArrowRight size={11} className="shrink-0 text-success rotate-180" />
                        <span className="text-[12px] text-fg-secondary truncate flex-1">{e.source}</span>
                        <span className="text-[11px] font-mono font-semibold text-fg-muted">{e.frequency}x</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="divide-y divide-line/50">
                {data && [...data.nodes]
                  .sort((a, b) => b.frequency - a.frequency)
                  .map((node) => (
                    <div
                      key={node.id}
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-tint/30 transition-colors cursor-pointer"
                      onClick={() => handleNodeSelect(node.id)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Users size={12} className="shrink-0 text-fg-faint" />
                        <span className="truncate text-[12px] text-fg-secondary">{node.label}</span>
                      </div>
                      <span className="ml-2 shrink-0 rounded-full bg-tint px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                        {node.frequency}
                      </span>
                    </div>
                  ))}
              </div>

              {data && data.edges.length > 0 && (
                <div className="border-t border-line px-4 py-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted mb-2">Top Handovers</h3>
                  <div className="space-y-1.5">
                    {[...data.edges]
                      .sort((a, b) => b.frequency - a.frequency)
                      .slice(0, 8)
                      .map((edge, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                          <span className="truncate max-w-[70px]">{edge.source}</span>
                          <ArrowRightLeft size={10} className="shrink-0 text-fg-ghost" />
                          <span className="truncate max-w-[70px]">{edge.target}</span>
                          <span className="ml-auto shrink-0 font-mono font-semibold text-fg-secondary">{edge.frequency}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
