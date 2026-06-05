import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Building2, RotateCcw } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import { useProcessMap, useEventLogData } from '@/hooks/useProcessMining';
import type { ProcessNode, ProcessEdge } from '@/types';
import { formatDuration, formatNumber } from '@/utils/format';

/* ── Process City (3D CodeCity for processes) ─────────────────────────────
 *
 * Fly through your process as a skyline. Each activity is a tower: TALL =
 * slow (or high-volume), and colour = health. Streets connect towers along
 * the directly-follows paths and glow with case "traffic". It turns an
 * abstract graph into a place you can explore — a screenshot that travels.
 *
 * three.js is lazy-loaded via this route's code-split chunk, so it never
 * touches the main bundle. Layout is a deterministic layered placement
 * computed here (no headless graph engine). Everything is disposed on unmount.
 */

type Metric = 'duration' | 'frequency';
const TIER = [0x10b981, 0xf59e0b, 0xf43f5e]; // healthy, degraded, at-risk

interface Placed {
  id: string;
  label: string;
  x: number;
  z: number;
  height: number;
  tier: number;
  node: ProcessNode;
}

// Deterministic layered layout: rank by longest-path depth from start
// activities, then spread laterally within each rank by frequency.
function layout(nodes: ProcessNode[], edges: ProcessEdge[], metric: Metric): { placed: Placed[]; byId: Map<string, Placed> } {
  const ids = nodes.map((n) => n.id);
  const rank = new Map<string, number>();
  ids.forEach((id) => rank.set(id, 0));
  const starts = nodes.filter((n) => n.is_start).map((n) => n.id);
  starts.forEach((id) => rank.set(id, 0));

  // Relax ranks: rank[target] = max(rank[target], rank[source]+1). A few
  // passes converge for DAG-ish graphs and stay bounded on cycles.
  const passes = Math.min(ids.length, 24);
  for (let p = 0; p < passes; p++) {
    let changed = false;
    for (const e of edges) {
      const rs = rank.get(e.source);
      const rt = rank.get(e.target);
      if (rs == null || rt == null) continue;
      if (rt < rs + 1 && rs + 1 < ids.length) {
        rank.set(e.target, rs + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group by rank, order by frequency desc.
  const byRank = new Map<number, ProcessNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }
  byRank.forEach((arr) => arr.sort((a, b) => b.frequency - a.frequency));

  // Metric normalisation for tower height + health tiers.
  const metricVal = (n: ProcessNode) => (metric === 'duration' ? n.avg_duration ?? 0 : n.frequency);
  const vals = nodes.map(metricVal).filter((v) => v > 0).sort((a, b) => a - b);
  const vmax = vals.at(-1) ?? 1;
  const durs = nodes.map((n) => n.avg_duration ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const dq1 = durs[Math.floor(durs.length / 3)] ?? 0;
  const dq2 = durs[Math.floor((2 * durs.length) / 3)] ?? 0;

  const SP_X = 9;
  const SP_Z = 11;
  const placed: Placed[] = [];
  const byId = new Map<string, Placed>();
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of sortedRanks) {
    const arr = byRank.get(r)!;
    const offset = ((arr.length - 1) * SP_X) / 2;
    arr.forEach((n, i) => {
      const d = n.avg_duration ?? 0;
      const tier = d <= dq1 ? 0 : d <= dq2 ? 1 : 2;
      const h = 2 + (metricVal(n) / vmax) * 26;
      const pl: Placed = { id: n.id, label: n.label, x: i * SP_X - offset, z: r * SP_Z, height: h, tier, node: n };
      placed.push(pl);
      byId.set(n.id, pl);
    });
  }
  // Centre the city on Z.
  const maxRank = Math.max(...sortedRanks, 0);
  const zShift = (maxRank * SP_Z) / 2;
  placed.forEach((p) => (p.z -= zShift));
  return { placed, byId };
}

export default function ProcessCityPage() {
  const { eventLogId } = useParams<{ eventLogId: string }>();
  const { eventLog } = useEventLogData(eventLogId);
  const { discovery, loading, error } = useProcessMap(eventLogId, 'dfg');

  const mountRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});
  const [metric, setMetric] = useState<Metric>('duration');
  const [hover, setHover] = useState<{ x: number; y: number; node: ProcessNode; height: number } | null>(null);

  const placedData = useMemo(() => {
    if (!discovery || discovery.nodes.length === 0) return null;
    return layout(discovery.nodes, discovery.edges, metric);
  }, [discovery, metric]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !placedData || !discovery) return;
    const { placed, byId } = placedData;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0e12);
    scene.fog = new THREE.Fog(0x0c0e12, 80, 260);

    // Frame the camera to the city's actual extent so small processes
    // aren't lost in the distance and big ones still fit.
    const spanX = Math.max(...placed.map((p) => Math.abs(p.x)), 8);
    const spanZ = Math.max(...placed.map((p) => Math.abs(p.z)), 8);
    const maxH = Math.max(...placed.map((p) => p.height), 8);
    const radius = Math.max(spanX, spanZ) * 1.7 + 28;
    const camPos = new THREE.Vector3(0, Math.max(maxH * 1.5, radius * 0.7), radius);
    const camTarget = new THREE.Vector3(0, maxH * 0.3, 0);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 2000);
    camera.position.copy(camPos);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 12;
    controls.maxDistance = radius * 3.5;
    controls.target.copy(camTarget);

    resetRef.current = () => {
      camera.position.copy(camPos);
      controls.target.copy(camTarget);
      controls.update();
    };

    // Lights.
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0c0e12, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(40, 80, 40);
    scene.add(dir);

    // Ground grid.
    const grid = new THREE.GridHelper(400, 80, 0x1f2937, 0x161a22);
    (grid.material as THREE.Material).opacity = 0.5;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // Towers. Reuse one geometry, scale per-building via matrix; but we also
    // want per-building footprint, so build individual boxes (counts are
    // small — tens to low hundreds of activities).
    const buildingMeta: Array<{ mesh: THREE.Mesh; base: number }> = [];
    for (const p of placed) {
      const foot = 3.2 + (p.node.frequency / Math.max(...placed.map((q) => q.node.frequency), 1)) * 3.5;
      const geo = track(new THREE.BoxGeometry(foot, p.height, foot));
      const mat = track(
        new THREE.MeshStandardMaterial({
          color: TIER[p.tier],
          emissive: TIER[p.tier],
          emissiveIntensity: 0.32,
          roughness: 0.45,
          metalness: 0.1,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.height / 2, p.z);
      mesh.userData = { id: p.id };
      scene.add(mesh);
      buildingMeta.push({ mesh, base: 0.32 });
    }

    // Streets (edges) — thin glowing lines along the ground between towers.
    const maxFreq = Math.max(...discovery.edges.map((e) => e.frequency), 1);
    const streets: Array<{ a: THREE.Vector3; b: THREE.Vector3; freq: number }> = [];
    const linePositions: number[] = [];
    for (const e of discovery.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const va = new THREE.Vector3(a.x, 0.3, a.z);
      const vb = new THREE.Vector3(b.x, 0.3, b.z);
      linePositions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      streets.push({ a: va, b: vb, freq: e.frequency });
    }
    const lineGeo = track(new THREE.BufferGeometry());
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lineMat = track(new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.5 }));
    scene.add(new THREE.LineSegments(lineGeo, lineMat));

    // Traffic — glowing dots travelling along the busiest streets.
    const busy = [...streets].sort((s1, s2) => s2.freq - s1.freq).slice(0, 48);
    const trafficGeo = track(new THREE.SphereGeometry(0.55, 8, 8));
    const trafficMat = track(new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    const cars = busy.map((s) => {
      const m = new THREE.Mesh(trafficGeo, trafficMat);
      scene.add(m);
      return { mesh: m, s, t: Math.random(), speed: 0.12 + (s.freq / maxFreq) * 0.4 };
    });

    // Hover picking.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: THREE.Mesh | null = null;
    const meshes = buildingMeta.map((b) => b.mesh);

    const onPointerMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes, false);
      const hit = hits[0]?.object as THREE.Mesh | undefined;
      if (hit !== hovered) {
        if (hovered) (hovered.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.32;
        hovered = hit ?? null;
        if (hovered) (hovered.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.7;
      }
      if (hit) {
        const p = byId.get(hit.userData.id as string);
        if (p) setHover({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, node: p.node, height: p.height });
      } else {
        setHover(null);
      }
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', () => setHover(null));

    // Animation loop.
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (const c of cars) {
        c.t += c.speed * dt;
        if (c.t > 1) c.t -= 1;
        c.mesh.position.set(
          c.s.a.x + (c.s.b.x - c.s.a.x) * c.t,
          0.8,
          c.s.a.z + (c.s.b.z - c.s.a.z) * c.t,
        );
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [placedData, discovery]);

  if (loading) return <LoadingSpinner size="lg" text="Constructing the city…" fullPage />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  const empty = !discovery || discovery.nodes.length === 0;

  return (
    <div>
      <PageHeader
        title="Process City"
        icon={Building2}
        backTo={eventLogId ? `/process/${eventLogId}` : -1}
        description="Your process as a 3D city. Each tower is an activity — taller means slower (or higher-volume), colour is health, and the streets glow with case traffic. Drag to orbit, scroll to zoom."
        subtitle={eventLog?.name ?? 'Event Log'}
      />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-fg-muted">Tower height by</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-line">
          {(['duration', 'frequency'] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-3 py-1.5 text-[12px] font-medium capitalize transition-colors ${
                metric === m ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-tint'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={() => resetRef.current()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-secondary transition-colors hover:bg-tint"
        >
          <RotateCcw size={13} />
          Reset view
        </button>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-fg-muted">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: '#10b981' }} />fast</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />medium</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: '#f43f5e' }} />slow</span>
        </div>
      </div>

      <div className="relative mt-4 h-[640px] w-full overflow-hidden rounded-xl border border-line bg-[#0c0e12]">
        {empty ? (
          <EmptyState icon={Building2} title="No process to build" description="Discover a process map first to raise the city." />
        ) : (
          <>
            <div ref={mountRef} className="absolute inset-0" />
            {hover && (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-white/10 bg-black/80 px-2.5 py-1.5 text-[11px] text-slate-100 shadow-lg"
                style={{ left: hover.x, top: hover.y - 10 }}
              >
                <div className="font-semibold">{hover.node.label}</div>
                <div className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 text-slate-300">
                  <span>Runs</span>
                  <span className="tabular-nums">{formatNumber(hover.node.frequency)}</span>
                  <span>Avg time</span>
                  <span className="tabular-nums">{hover.node.avg_duration == null ? '—' : formatDuration(hover.node.avg_duration)}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
