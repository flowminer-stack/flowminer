import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import cytoscape, { Core } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { Radio, Play, Pause, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import { useProcessMap, useEventLogData } from '@/hooks/useProcessMining';
import type { ProcessNode, ProcessEdge } from '@/types';

try { cytoscape.use(dagre); } catch { /* already registered */ }

/* ── Live Process Pulse ───────────────────────────────────────────────────
 *
 * The DFG re-skinned as a dark observability "service map": cases stream
 * through it as glowing particles whose density tracks how busy each path is,
 * and activities carry a health colour. It turns a static map into something
 * that breathes — the bottleneck literally clogs and glows red.
 *
 * Implementation: a normal Cytoscape DFG (dark stylesheet) with a transparent
 * <canvas> over it. A requestAnimationFrame loop spawns particles per edge
 * (rate ∝ frequency) and draws them by lerping between the SOURCE and TARGET
 * nodes' live rendered positions — so the particles track pan/zoom for free.
 * No streaming infra and no new dependency required.
 */

type ColorBy = 'throughput' | 'duration' | 'health';

const TIER_COLOR = ['#10b981', '#f59e0b', '#f43f5e']; // fast/healthy, mid, slow/at-risk
const ACCENT = '#22d3ee'; // cyan particle for throughput mode

interface EdgeMeta {
  source: string;
  target: string;
  freqNorm: number; // 0..1
  tier: number; // 0..2 by avg_duration
  spawnAccumulator: number;
}
interface Particle {
  edgeIdx: number;
  t: number; // 0..1 progress
  speed: number; // t per second
  color: string;
}

function tierOf(value: number | null, q1: number, q2: number): number {
  if (value == null) return 0;
  return value <= q1 ? 0 : value <= q2 ? 1 : 2;
}

function darkStyles(): any[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '110px',
        'font-size': '10px',
        'font-family': 'Manrope, system-ui, sans-serif',
        'font-weight': 500,
        color: '#cbd5e1',
        'background-color': '#16181d',
        'border-width': 2,
        'border-color': 'data(tierColor)',
        'border-opacity': 0.9,
        shape: 'roundrectangle',
        width: 'label',
        height: 'label',
        padding: '12px',
        'text-valign': 'center',
        'text-halign': 'center',
        'min-zoomed-font-size': 8,
        'underlay-color': 'data(tierColor)',
        'underlay-opacity': 0.18,
        'underlay-padding': 8,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 'data(width)',
        'line-color': '#2a2f3a',
        'target-arrow-color': '#3a4150',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        opacity: 0.55,
      },
    },
  ];
}

export default function ProcessPulsePage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const { discovery, loading, error } = useProcessMap(eventLogId, 'dfg');

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cyRef = useRef<Core | null>(null);
  const rafRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const edgeMetaRef = useRef<EdgeMeta[]>([]);
  const lastTsRef = useRef<number>(0);

  const [colorBy, setColorBy] = useState<ColorBy>('throughput');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  // Keep latest control values readable from the rAF loop without
  // restarting it.
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const colorByRef = useRef(colorBy);
  playingRef.current = playing;
  speedRef.current = speed;
  colorByRef.current = colorBy;

  // Precompute node/edge duration terciles for health colouring.
  const { nodeTier, edgeStats } = useMemo(() => {
    const nodes: ProcessNode[] = discovery?.nodes ?? [];
    const edges: ProcessEdge[] = discovery?.edges ?? [];
    const nd = nodes.map((n) => n.avg_duration ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
    const nq1 = nd[Math.floor(nd.length / 3)] ?? 0;
    const nq2 = nd[Math.floor((2 * nd.length) / 3)] ?? 0;
    const nodeTier = new Map<string, number>();
    nodes.forEach((n) => nodeTier.set(n.id, tierOf(n.avg_duration, nq1, nq2)));

    const ed = edges.map((e) => e.avg_duration ?? 0).filter((d) => d > 0).sort((a, b) => a - b);
    const eq1 = ed[Math.floor(ed.length / 3)] ?? 0;
    const eq2 = ed[Math.floor((2 * ed.length) / 3)] ?? 0;
    const maxFreq = Math.max(...edges.map((e) => e.frequency), 1);
    return { nodeTier, edgeStats: { eq1, eq2, maxFreq } };
  }, [discovery]);

  // Build the dark Cytoscape graph.
  useEffect(() => {
    if (!containerRef.current || !discovery || discovery.nodes.length === 0) return;
    const nodes = discovery.nodes;
    const edges = discovery.edges;

    const elements = [
      ...nodes.map((n) => ({
        data: {
          id: n.id,
          label: `${n.label}`,
          tierColor: TIER_COLOR[nodeTier.get(n.id) ?? 0],
        },
      })),
      ...edges.map((e, i) => ({
        data: {
          id: `e${i}`,
          source: e.source,
          target: e.target,
          width: 1 + (e.frequency / edgeStats.maxFreq) * 4,
        },
      })),
    ];

    cyRef.current?.destroy();
    const cy = cytoscape({
      container: containerRef.current,
      elements: elements as any,
      style: darkStyles(),
      layout: { name: 'dagre', rankDir: 'TB', nodeSep: 55, rankSep: 75, edgeSep: 20, fit: true, padding: 50, animate: false } as any,
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 1.0,
      pixelRatio: 1,
      textureOnViewport: true,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    // Edge metadata for the particle system.
    edgeMetaRef.current = edges.map((e) => ({
      source: e.source,
      target: e.target,
      freqNorm: e.frequency / edgeStats.maxFreq,
      tier: tierOf(e.avg_duration, edgeStats.eq1, edgeStats.eq2),
      spawnAccumulator: 0,
    }));
    particlesRef.current = [];

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [discovery, nodeTier, edgeStats]);

  // Particle animation loop — runs for the life of the page; reads control
  // refs so toggling play/colour/speed never restarts it.
  useEffect(() => {
    const step = (ts: number) => {
      rafRef.current = requestAnimationFrame(step);
      const cy = cyRef.current;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!cy || !canvas || !container) return;

      const dt = lastTsRef.current ? Math.min((ts - lastTsRef.current) / 1000, 0.05) : 0;
      lastTsRef.current = ts;

      // Size canvas to the container (DPR-aware).
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const metas = edgeMetaRef.current;
      const particles = particlesRef.current;
      const playing = playingRef.current;
      const spd = speedRef.current;
      const cby = colorByRef.current;

      // Cache rendered node positions this frame.
      const pos = new Map<string, { x: number; y: number }>();
      const renderedPos = (id: string) => {
        let p = pos.get(id);
        if (!p) {
          const el = cy.getElementById(id);
          if (el.empty()) return null;
          const rp = el.renderedPosition();
          p = { x: rp.x, y: rp.y };
          pos.set(id, p);
        }
        return p;
      };

      // Spawn — rate ∝ frequency, capped globally.
      if (playing && particles.length < 700) {
        for (let i = 0; i < metas.length; i++) {
          const m = metas[i];
          m.spawnAccumulator += dt * spd * (0.4 + m.freqNorm * 3.2);
          while (m.spawnAccumulator >= 1 && particles.length < 700) {
            m.spawnAccumulator -= 1;
            particles.push({
              edgeIdx: i,
              t: 0,
              speed: 0.35 + Math.random() * 0.15,
              color:
                cby === 'throughput'
                  ? ACCENT
                  : TIER_COLOR[m.tier],
            });
          }
        }
      }

      // Advance + draw.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = particles.length - 1; i >= 0; i--) {
        const part = particles[i];
        if (playing) part.t += part.speed * spd * dt;
        if (part.t >= 1) {
          particles.splice(i, 1);
          continue;
        }
        const m = metas[part.edgeIdx];
        if (!m) {
          particles.splice(i, 1);
          continue;
        }
        const a = renderedPos(m.source);
        const b = renderedPos(m.target);
        if (!a || !b) continue;
        const x = a.x + (b.x - a.x) * part.t;
        const y = a.y + (b.y - a.y) * part.t;
        const r = 2.6;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
        grad.addColorStop(0, part.color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = part.color;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTsRef.current = 0;
    };
  }, []);

  // Recolour nodes when the colorBy lens changes (particles recolour on
  // spawn; nodes recolour live here).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const tier = nodeTier.get(n.id()) ?? 0;
        const col = colorBy === 'throughput' ? '#3a4150' : TIER_COLOR[tier];
        n.data('tierColor', col);
      });
    });
  }, [colorBy, nodeTier, discovery]);

  const zoomBy = useCallback((factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ zoom: { level: Math.max(cy.minZoom(), Math.min(cy.zoom() * factor, cy.maxZoom())), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } } as any, { duration: 120 });
  }, []);
  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 50 } } as any, { duration: 300 });
  }, []);

  if (loading) return <LoadingSpinner size="lg" text="Warming up the pulse…" fullPage />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const empty = !discovery || discovery.nodes.length === 0;

  return (
    <div>
      <PageHeader
        title="Live Process Pulse"
        icon={Radio}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="Your process, breathing. Cases flow as particles along the busiest paths; activities glow by health. A live control room for the process rather than a static map."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      {/* Toolbar */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-line">
          {(['throughput', 'duration', 'health'] as ColorBy[]).map((c) => (
            <button
              key={c}
              onClick={() => setColorBy(c)}
              className={`px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${
                colorBy === c ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-tint'
              }`}
            >
              {c === 'throughput' ? 'Color by throughput' : c === 'duration' ? 'Duration' : 'Health'}
            </button>
          ))}
        </div>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-tint"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <label className="flex items-center gap-2 text-[12px]">
          <span className="text-fg-muted">Speed</span>
          <input type="range" min={25} max={300} step={5} value={Math.round(speed * 100)} onChange={(e) => setSpeed(Number(e.target.value) / 100)} className="w-28 accent-accent" />
          <span className="w-9 font-semibold tabular-nums text-fg">{speed.toFixed(1)}×</span>
        </label>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-fg-muted">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLOR[0] }} />healthy</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLOR[1] }} />degraded</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLOR[2] }} />at risk</span>
        </div>
      </div>

      {/* Stage */}
      <div className="relative mt-4 h-[620px] w-full overflow-hidden rounded-xl border border-line" style={{ background: 'radial-gradient(circle at 50% 30%, #14171d 0%, #0c0e12 100%)' }}>
        {empty ? (
          <EmptyState icon={Radio} title="No process to animate" description="Discover a process map first to see it pulse." />
        ) : (
          <>
            <div ref={containerRef} className="absolute inset-0" style={{ touchAction: 'none' }} />
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />
            <div className="absolute bottom-3 right-3 z-10 flex items-center gap-px rounded-lg border border-white/10 bg-black/40 p-0.5 backdrop-blur-md">
              <button onClick={() => zoomBy(1.3)} className="p-2 text-slate-300 hover:text-white" title="Zoom in"><ZoomIn size={14} /></button>
              <button onClick={() => zoomBy(1 / 1.3)} className="p-2 text-slate-300 hover:text-white" title="Zoom out"><ZoomOut size={14} /></button>
              <button onClick={handleFit} className="p-2 text-slate-300 hover:text-white" title="Fit"><Maximize2 size={14} /></button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
