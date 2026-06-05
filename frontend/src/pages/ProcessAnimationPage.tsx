import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import cytoscape, { Core } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { Play, Pause, RotateCcw, Rewind, FastForward } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { format } from 'date-fns';
import { mining as miningApi } from '@/api/client';
import type { DiscoveryResponse, TimelineResponse } from '@/types';
import { useEventLogData } from '@/hooks/useProcessMining';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCyStyles } from '@/components/ProcessMap/ProcessMap';
import { FLUID_CY_OPTS } from '@/utils/cyFluid';
import { useUIStore } from '@/store';

cytoscape.use(dagre);

const SPEEDS = [0.5, 1, 2, 5, 10, 25];

export default function ProcessAnimationPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const theme = useUIStore((s) => s.theme);
  const isDark = theme === 'dark';

  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [currentIdx, setCurrentIdx] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  // ── Load both discovery and timeline ───────────────────────────────────
  useEffect(() => {
    if (!eventLogId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const [d, t] = await Promise.all([
          miningApi.discover({
            event_log_id: eventLogId,
            algorithm: 'dfg',
            parameters: {},
          }),
          miningApi.getTimeline(eventLogId),
        ]);
        if (!cancelled) {
          setDiscovery(d);
          setTimeline(t);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load animation data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  // ── Initialize cytoscape once discovery data is loaded ─────────────────
  useEffect(() => {
    if (!discovery || !containerRef.current) return;

    const elements = [
      ...discovery.nodes.map((n) => ({
        data: {
          id: n.id,
          label: n.label,
          width: Math.max(100, 60 + (n.label?.length ?? 0) * 4),
          height: 36,
        },
        classes: [n.is_start ? 'start' : '', n.is_end ? 'end' : '']
          .filter(Boolean)
          .join(' '),
      })),
      ...discovery.edges.map((e) => ({
        data: {
          id: `${e.source}__${e.target}`,
          source: e.source,
          target: e.target,
          label: String(e.frequency ?? ''),
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: getCyStyles(isDark),
      layout: {
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 40,
        rankSep: 70,
      } as any,
      ...FLUID_CY_OPTS,
    });

    cyRef.current = cy;

    // Layer used for animation highlighting: dim all first
    cy.elements().style('opacity', 0.35);

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [discovery, isDark]);

  // ── Apply highlighting for current timeline index ──────────────────────
  const applyFrame = (idx: number) => {
    const cy = cyRef.current;
    if (!cy || !timeline) return;
    const events = timeline.events;
    if (idx <= 0) {
      cy.elements().style('opacity', 0.35);
      cy.edges().removeStyle('line-color width');
      return;
    }

    // Windowed approach: look back at the last N events and fade highlights
    const windowSize = 200;
    const start = Math.max(0, idx - windowSize);
    const slice = events.slice(start, idx);

    // Count edge traversals and node touches inside the window
    const edgeCounts = new Map<string, number>();
    const nodeCounts = new Map<string, number>();
    slice.forEach((ev) => {
      nodeCounts.set(ev.activity, (nodeCounts.get(ev.activity) || 0) + 1);
      if (ev.source) {
        const edgeId = `${ev.source}__${ev.activity}`;
        edgeCounts.set(edgeId, (edgeCounts.get(edgeId) || 0) + 1);
      }
    });

    // Dim everything first
    cy.elements().style('opacity', 0.25);

    // Highlight nodes in proportion to activity
    const maxNode = Math.max(1, ...nodeCounts.values());
    nodeCounts.forEach((count, act) => {
      const node = cy.getElementById(act);
      if (node && node.length > 0) {
        const intensity = 0.4 + (count / maxNode) * 0.6;
        node.style({ opacity: intensity, 'border-width': 2, 'border-color': '#06b6d4' } as any);
      }
    });

    // Highlight edges in proportion to traversals
    const maxEdge = Math.max(1, ...edgeCounts.values());
    edgeCounts.forEach((count, id) => {
      const edge = cy.getElementById(id);
      if (edge && edge.length > 0) {
        const intensity = 0.4 + (count / maxEdge) * 0.6;
        edge.style({
          opacity: intensity,
          'line-color': '#06b6d4',
          width: 2 + (count / maxEdge) * 4,
        } as any);
      }
    });
  };

  useEffect(() => {
    applyFrame(currentIdx);
  }, [currentIdx, timeline]);

  // ── Play/pause loop using requestAnimationFrame ────────────────────────
  useEffect(() => {
    if (!playing || !timeline) return;
    const total = timeline.events.length;

    const eventsPerSecond = 30 * speed; // base 30 eps * speed
    lastTickRef.current = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setCurrentIdx((idx) => {
        const next = idx + eventsPerSecond * dt;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed, timeline]);

  const currentTimeLabel = useMemo(() => {
    if (!timeline || timeline.events.length === 0) return '--';
    const idx = Math.min(Math.floor(currentIdx), timeline.events.length - 1);
    const ev = timeline.events[Math.max(0, idx)];
    try {
      return format(new Date(ev.timestamp), 'MMM d, yyyy HH:mm:ss');
    } catch {
      return ev.timestamp;
    }
  }, [currentIdx, timeline]);

  const total = timeline?.events.length || 0;
  const pct = total > 0 ? (Math.min(currentIdx, total) / total) * 100 : 0;

  if (loading) return <LoadingSpinner size="lg" text="Loading animation..." fullPage />;
  if (error) return <p className="py-10 text-center text-[12px] text-fg-muted">{error}</p>;

  return (
    <div className="flex h-[calc(100vh-120px)] flex-col gap-3">
      <PageHeader
        title="Process Animation"
        icon={Play}
        backTo={-1}
        description="Replay the event log through the discovered process map. Nodes and edges brighten as events flow through them over time."
        subtitle={eventLog?.name ?? 'Event Log'}
        actions={
          <span className="text-[11px] text-fg-muted">
            Event <span className="text-fg">{Math.floor(currentIdx).toLocaleString()}</span> / {total.toLocaleString()}
            {' · '}
            <span className="text-fg">{currentTimeLabel}</span>
          </span>
        }
      />

      <div ref={containerRef} className="flex-1 rounded-lg border border-line bg-surface-1" />

      <div className="rounded-lg border border-line bg-surface-1 p-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setCurrentIdx(0);
              setPlaying(false);
            }}
            title="Restart"
            className="btn-ghost p-2"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={() => setCurrentIdx((i) => Math.max(0, i - 100))}
            title="Skip back"
            className="btn-ghost p-2"
          >
            <Rewind size={14} />
          </button>
          <button
            onClick={() => setPlaying((p) => !p)}
            className="btn-primary flex items-center gap-1.5 px-3"
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            onClick={() => setCurrentIdx((i) => Math.min(total, i + 100))}
            title="Skip forward"
            className="btn-ghost p-2"
          >
            <FastForward size={14} />
          </button>
          <div className="ml-4 flex items-center gap-2">
            <span className="text-[11px] text-fg-faint">Speed</span>
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`rounded px-2 py-0.5 text-[10px] ${
                  s === speed ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-tint'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[10px] text-fg-faint">{Math.round(pct)}%</span>
          <input
            type="range"
            min={0}
            max={total}
            value={Math.min(currentIdx, total)}
            onChange={(e) => setCurrentIdx(Number(e.target.value))}
            className="flex-1"
          />
        </div>
      </div>
    </div>
  );
}
