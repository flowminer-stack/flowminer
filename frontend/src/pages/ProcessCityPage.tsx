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
 * slow (or high-volume), and colour = health. Activities are laid out as
 * avenues by their distance from the start (the process flows away from
 * camera), connected by glowing streets with case "traffic".
 *
 * three.js is lazy-loaded via this route's code-split chunk. Layout ranks
 * are computed by BFS distance from the start activities, which is robust to
 * loops (longest-path ranking inflates on cycles). All GPU resources are
 * disposed on unmount.
 */

type Metric = 'duration' | 'frequency';
const TIER = [0x10b981, 0xf59e0b, 0xf43f5e]; // healthy, degraded, at-risk

interface Placed {
  id: string;
  label: string;
  x: number;
  z: number;
  height: number;
  foot: number;
  tier: number;
  node: ProcessNode;
}

const SP_X = 15;
const SP_Z = 16;

function layout(nodes: ProcessNode[], edges: ProcessEdge[], metric: Metric): { placed: Placed[]; byId: Map<string, Placed> } {
  // Successor adjacency.
  const succ = new Map<string, string[]>();
  nodes.forEach((n) => succ.set(n.id, []));
  for (const e of edges) succ.get(e.source)?.push(e.target);

  // BFS ranks from the start activities (cycle-safe — each node visited once).
  let starts = nodes.filter((n) => n.is_start).map((n) => n.id);
  if (starts.length === 0) {
    const top = [...nodes].sort((a, b) => b.frequency - a.frequency)[0];
    starts = top ? [top.id] : [];
  }
  const rank = new Map<string, number>();
  const queue: string[] = [];
  starts.forEach((s) => {
    if (!rank.has(s)) {
      rank.set(s, 0);
      queue.push(s);
    }
  });
  while (queue.length) {
    const cur = queue.shift()!;
    const r = rank.get(cur)!;
    for (const t of succ.get(cur) ?? []) {
      if (!rank.has(t)) {
        rank.set(t, r + 1);
        queue.push(t);
      }
    }
  }
  // Unreachable activities land in their own back row.
  const maxReached = Math.max(0, ...[...rank.values()]);
  nodes.forEach((n) => {
    if (!rank.has(n.id)) rank.set(n.id, maxReached + 1);
  });

  // Group by rank, order by frequency for a tidy skyline.
  const byRank = new Map<number, ProcessNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id)!;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }
  byRank.forEach((arr) => arr.sort((a, b) => b.frequency - a.frequency));

  const metricVal = (n: ProcessNode) => (metric === 'duration' ? n.avg_duration ?? 0 : n.frequency);
  const vmax = Math.max(...nodes.map(metricVal), 1);
  const fmax = Math.max(...nodes.map((n) => n.frequency), 1);
  const durs = nodes.map((n) => n.avg_duration ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const dq1 = durs[Math.floor(durs.length / 3)] ?? 0;
  const dq2 = durs[Math.floor((2 * durs.length) / 3)] ?? 0;

  const placed: Placed[] = [];
  const byId = new Map<string, Placed>();
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of sortedRanks) {
    const arr = byRank.get(r)!;
    const offset = ((arr.length - 1) * SP_X) / 2;
    arr.forEach((n, i) => {
      const d = n.avg_duration ?? 0;
      const tier = d <= dq1 ? 0 : d <= dq2 ? 1 : 2;
      const h = 3 + (metricVal(n) / vmax) * 30;
      const foot = 2.4 + (n.frequency / fmax) * 2.6; // slender towers
      const pl: Placed = { id: n.id, label: n.label, x: i * SP_X - offset, z: r * SP_Z, height: h, foot, tier, node: n };
      placed.push(pl);
      byId.set(n.id, pl);
    });
  }
  // Centre on Z.
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
  const [hover, setHover] = useState<{ x: number; y: number; node: ProcessNode } | null>(null);

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

    // City extent for framing the ground + camera.
    const spanX = Math.max(...placed.map((p) => Math.abs(p.x) + p.foot), 14);
    const spanZ = Math.max(...placed.map((p) => Math.abs(p.z) + p.foot), 14);
    const maxH = Math.max(...placed.map((p) => p.height), 8);
    const reach = Math.max(spanX, spanZ);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c10);
    scene.fog = new THREE.Fog(0x0a0c10, reach * 2.4, reach * 7 + 160);

    const fov = 52;
    const camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 6000);
    // Frame the whole bounding box from a 3/4 angle, accounting for the
    // viewport aspect, so a long thin process and a compact one both fill
    // the frame nicely.
    const aspect = width / height;
    const radius = Math.sqrt(spanX * spanX + spanZ * spanZ) + maxH * 0.8;
    const vFov = (fov * Math.PI) / 180;
    const fitH = radius / Math.tan(vFov / 2);
    const fitW = radius / Math.tan(Math.atan(Math.tan(vFov / 2) * aspect));
    const dist = Math.max(fitH, fitW) * 0.95 + 20;
    const camPos = new THREE.Vector3(dist * 0.52, dist * 0.5 + maxH * 0.6, dist * 0.72);
    const camTarget = new THREE.Vector3(0, maxH * 0.25, 0);
    camera.position.copy(camPos);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.08;
    controls.minDistance = 14;
    controls.maxDistance = dist * 3 + 120;
    controls.target.copy(camTarget);

    resetRef.current = () => {
      camera.position.copy(camPos);
      controls.target.copy(camTarget);
      controls.update();
    };

    // Lights.
    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x0a0c10, 0.65));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(reach, maxH * 3 + 40, reach);
    scene.add(dir);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // Ground plane — gives the city a base to stand on.
    const groundGeo = track(new THREE.PlaneGeometry(reach * 3 + 60, reach * 3 + 60));
    const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x10141b, roughness: 0.95, metalness: 0 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const grid = new THREE.GridHelper(reach * 3 + 60, Math.round((reach * 3 + 60) / 6), 0x223049, 0x161c27);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);

    // Towers with crisp edge outlines.
    const buildings: THREE.Mesh[] = [];
    for (const p of placed) {
      const geo = track(new THREE.BoxGeometry(p.foot, p.height, p.foot));
      const mat = track(
        new THREE.MeshStandardMaterial({
          color: TIER[p.tier],
          emissive: TIER[p.tier],
          emissiveIntensity: 0.34,
          roughness: 0.4,
          metalness: 0.15,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.height / 2, p.z);
      mesh.userData = { id: p.id };
      scene.add(mesh);
      buildings.push(mesh);

      const edgeGeo = track(new THREE.EdgesGeometry(geo));
      const edgeMat = track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      const outline = new THREE.LineSegments(edgeGeo, edgeMat);
      outline.position.copy(mesh.position);
      scene.add(outline);
    }

    // Streets — glowing lines just above the ground between towers.
    const maxFreq = Math.max(...discovery.edges.map((e) => e.frequency), 1);
    const streets: Array<{ a: THREE.Vector3; b: THREE.Vector3; freq: number }> = [];
    const linePositions: number[] = [];
    for (const e of discovery.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b || a === b) continue;
      const va = new THREE.Vector3(a.x, 0.4, a.z);
      const vb = new THREE.Vector3(b.x, 0.4, b.z);
      linePositions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      streets.push({ a: va, b: vb, freq: e.frequency });
    }
    const lineGeo = track(new THREE.BufferGeometry());
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lineMat = track(new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.45 }));
    scene.add(new THREE.LineSegments(lineGeo, lineMat));

    // Traffic — glowing dots travelling the busiest streets.
    const busy = [...streets].sort((s1, s2) => s2.freq - s1.freq).slice(0, 60);
    const trafficGeo = track(new THREE.SphereGeometry(0.65, 10, 10));
    const trafficMat = track(new THREE.MeshBasicMaterial({ color: 0x67e8f9 }));
    const cars = busy.map((s) => ({ mesh: ((m) => (scene.add(m), m))(new THREE.Mesh(trafficGeo, trafficMat)), s, t: Math.random(), speed: 0.12 + (s.freq / maxFreq) * 0.4 }));

    // Hover picking.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: THREE.Mesh | null = null;
    const onPointerMove = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(buildings, false)[0]?.object as THREE.Mesh | undefined;
      if (hit !== hovered) {
        if (hovered) (hovered.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.34;
        hovered = hit ?? null;
        if (hovered) (hovered.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.85;
      }
      if (hit) {
        const p = byId.get(hit.userData.id as string);
        if (p) setHover({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, node: p.node });
      } else setHover(null);
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', () => setHover(null));

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
        c.mesh.position.set(c.s.a.x + (c.s.b.x - c.s.a.x) * c.t, 0.9, c.s.a.z + (c.s.b.z - c.s.a.z) * c.t);
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

      <div className="relative mt-4 h-[640px] w-full overflow-hidden rounded-xl border border-line bg-[#0a0c10]">
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
