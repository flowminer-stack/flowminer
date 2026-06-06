import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RotateCcw } from 'lucide-react';
import type { ProcessNode, ProcessEdge } from '@/types/mining';
import { simplifyGraph } from '@/utils/simplifyGraph';
import { formatDuration, formatNumber } from '@/utils/format';

/* ── Process City canvas (3D CodeCity for processes) ──────────────────────
 *
 * Reusable three.js renderer shared by the standalone Process City page and
 * the default "City" tab on the process view. Each activity is a tower (TALL =
 * slow or high-volume, colour = health); towers are laid out as avenues by BFS
 * distance from the start, connected by glowing streets with case "traffic".
 *
 * Streets are simplified with the shared top-paths filter (keepAllNodes: true)
 * so the skyline shows every activity but only the dominant traffic — otherwise
 * a dense log like BPIC2019 buries the city under ~500 ground lines.
 *
 * three.js is loaded via the route/tab's code-split chunk. All GPU resources
 * are disposed on unmount. Callers should gate on isWebGLAvailable() and render
 * a 2D fallback when WebGL is unavailable.
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

interface SelectedInfo {
  node: ProcessNode;
  inN: ProcessNode[];
  outN: ProcessNode[];
}

function layout(
  nodes: ProcessNode[],
  edges: ProcessEdge[],
  metric: Metric,
): { placed: Placed[]; byId: Map<string, Placed> } {
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

  // Bound the footprint: wrap wide ranks into a compact grid block instead of
  // one ever-widening avenue. Dense logs (e.g. BPIC2019) have ranks with a
  // dozen+ activities, which previously stretched the city into a thin, very
  // wide strip with long diagonal streets. Capping columns (~sqrt of the node
  // count) keeps the city roughly square; ranks still advance in depth so the
  // overall front-to-back reading of process progress is preserved.
  const maxCols = Math.max(4, Math.round(Math.sqrt(nodes.length * 1.3)));

  let zRow = 0; // running depth in grid-rows across all ranks
  for (const r of sortedRanks) {
    const arr = byRank.get(r)!;
    const cols = Math.min(arr.length, maxCols);
    const rows = Math.ceil(arr.length / cols);
    const xOffset = ((cols - 1) * SP_X) / 2;
    arr.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const d = n.avg_duration ?? 0;
      const tier = d <= dq1 ? 0 : d <= dq2 ? 1 : 2;
      const h = 3 + (metricVal(n) / vmax) * 30;
      const foot = 2.4 + (n.frequency / fmax) * 2.6; // slender towers
      const pl: Placed = {
        id: n.id, label: n.label,
        x: col * SP_X - xOffset, z: (zRow + row) * SP_Z,
        height: h, foot, tier, node: n,
      };
      placed.push(pl);
      byId.set(n.id, pl);
    });
    zRow += rows;
  }
  // Centre on Z.
  const zShift = ((zRow - 1) * SP_Z) / 2;
  placed.forEach((p) => (p.z -= zShift));
  return { placed, byId };
}

interface ProcessCityCanvasProps {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  /** Absolute cap on streets drawn, keeping the skyline clean (default 80). */
  maxStreets?: number;
  /** Height utility class for the canvas frame (default h-[640px]). */
  heightClass?: string;
}

export default function ProcessCityCanvas({
  nodes,
  edges,
  maxStreets = 80,
  heightClass = 'h-[640px]',
}: ProcessCityCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});
  const [metric, setMetric] = useState<Metric>('duration');
  const [hover, setHover] = useState<{ x: number; y: number; node: ProcessNode } | null>(null);
  // Click-to-focus: selecting a tower highlights it + its directly-connected
  // towers/streets and dims the rest, and opens a detail panel. selectRef lets
  // the React panel (e.g. clicking a neighbour chip) drive the 3D selection.
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  const selectRef = useRef<(id: string | null) => void>(() => {});

  // Layout uses the FULL edge set for accurate BFS ranks; only the drawn
  // streets are simplified to the dominant traffic.
  const placedData = useMemo(() => {
    if (nodes.length === 0) return null;
    return layout(nodes, edges, metric);
  }, [nodes, edges, metric]);

  const streetEdges = useMemo(
    () => simplifyGraph(nodes, edges, { maxEdges: maxStreets, keepAllNodes: true }).edges,
    [nodes, edges, maxStreets],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !placedData) return;
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

    // Clear any stale selection from a previous data/metric render.
    setSelected(null);

    // Towers with crisp edge outlines. Track each by id so selection can
    // recolor / dim them individually.
    interface BuildingObj {
      mesh: THREE.Mesh;
      mat: THREE.MeshStandardMaterial;
      edgeMat: THREE.LineBasicMaterial;
    }
    const buildingById = new Map<string, BuildingObj>();
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
          transparent: true,
          opacity: 1,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(p.x, p.height / 2, p.z);
      mesh.userData = { id: p.id, hover: false };
      scene.add(mesh);
      buildings.push(mesh);

      const edgeGeo = track(new THREE.EdgesGeometry(geo));
      const edgeMat = track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      const outline = new THREE.LineSegments(edgeGeo, edgeMat);
      outline.position.copy(mesh.position);
      scene.add(outline);
      buildingById.set(p.id, { mesh, mat, edgeMat });
    }

    // Streets — one flat ground ribbon per edge (not 1px lines, whose width
    // WebGL ignores, and not one merged mesh, so each can be dimmed/highlighted
    // on selection). Width scales with traffic.
    const maxFreq = Math.max(...streetEdges.map((e) => e.frequency), 1);
    interface StreetObj {
      mat: THREE.MeshBasicMaterial;
      source: string;
      target: string;
      a: THREE.Vector3;
      b: THREE.Vector3;
      freq: number;
    }
    const streetObjs: StreetObj[] = [];
    // Directed adjacency for the selection neighbourhood + detail panel.
    const neighbors = new Map<string, { in: Set<string>; out: Set<string> }>();
    const ensureN = (id: string) => {
      let n = neighbors.get(id);
      if (!n) { n = { in: new Set(), out: new Set() }; neighbors.set(id, n); }
      return n;
    };
    const perp = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const e of streetEdges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b || a === b) continue;
      ensureN(e.source).out.add(e.target);
      ensureN(e.target).in.add(e.source);
      const va = new THREE.Vector3(a.x, 0.18, a.z);
      const vb = new THREE.Vector3(b.x, 0.18, b.z);
      const hw = 0.5 + (e.frequency / maxFreq) * 2.6;
      perp.subVectors(vb, va).cross(up).normalize().multiplyScalar(hw);
      const y = 0.18;
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute([
        va.x + perp.x, y, va.z + perp.z, va.x - perp.x, y, va.z - perp.z, vb.x + perp.x, y, vb.z + perp.z,
        va.x - perp.x, y, va.z - perp.z, vb.x - perp.x, y, vb.z - perp.z, vb.x + perp.x, y, vb.z + perp.z,
      ], 3));
      const mat = track(new THREE.MeshBasicMaterial({
        color: 0x2dd4bf, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      scene.add(new THREE.Mesh(geo, mat));
      streetObjs.push({ mat, source: e.source, target: e.target, a: va, b: vb, freq: e.frequency });
    }

    // Traffic — glowing dots travelling the busiest streets.
    const busy = [...streetObjs].sort((s1, s2) => s2.freq - s1.freq).slice(0, 60);
    const trafficGeo = track(new THREE.SphereGeometry(0.65, 10, 10));
    const trafficMat = track(new THREE.MeshBasicMaterial({ color: 0x67e8f9 }));
    const cars = busy.map((s, i) => ({
      mesh: ((m) => (scene.add(m), m))(new THREE.Mesh(trafficGeo, trafficMat)),
      s,
      // Deterministic phase offset (no Math.random) so cars don't bunch up.
      t: (i * 0.137) % 1,
      speed: 0.12 + (s.freq / maxFreq) * 0.4,
    }));

    // ── Selection / focus ──────────────────────────────────────────────
    let selId: string | null = null;
    const applyVisual = () => {
      const sel = selId;
      buildingById.forEach((bo, id) => {
        let state: 'selected' | 'neighbor' | 'normal' | 'dimmed';
        if (!sel) state = 'normal';
        else if (id === sel) state = 'selected';
        else {
          const n = neighbors.get(sel);
          state = n && (n.in.has(id) || n.out.has(id)) ? 'neighbor' : 'dimmed';
        }
        let emissive: number, opacity: number, edge: number;
        if (state === 'selected') { emissive = 1.05; opacity = 1; edge = 0.95; }
        else if (state === 'neighbor') { emissive = 0.62; opacity = 1; edge = 0.5; }
        else if (state === 'dimmed') { emissive = 0.04; opacity = 0.14; edge = 0.04; }
        else { emissive = 0.34; opacity = 1; edge = 0.22; }
        if (bo.mesh.userData.hover && state !== 'selected') emissive = Math.max(emissive, 0.85);
        bo.mat.emissiveIntensity = emissive;
        bo.mat.opacity = opacity;
        bo.edgeMat.opacity = edge;
      });
      streetObjs.forEach((so) => {
        if (!sel) { so.mat.opacity = 0.4; so.mat.color.setHex(0x2dd4bf); }
        else if (so.source === sel || so.target === sel) { so.mat.opacity = 0.95; so.mat.color.setHex(0x5eead4); }
        else { so.mat.opacity = 0.04; so.mat.color.setHex(0x2dd4bf); }
      });
      cars.forEach((c) => { c.mesh.visible = !sel || c.s.source === sel || c.s.target === sel; });
    };

    const select = (id: string | null) => {
      selId = id;
      applyVisual();
      const p = id ? byId.get(id) : null;
      if (!p) { setSelected(null); return; }
      const n = neighbors.get(id!) ?? { in: new Set<string>(), out: new Set<string>() };
      const toNodes = (ids: Set<string>) =>
        ([...ids].map((x) => byId.get(x)?.node).filter(Boolean) as ProcessNode[])
          .sort((x, y) => y.frequency - x.frequency);
      setSelected({ node: p.node, inN: toNodes(n.in), outN: toNodes(n.out) });
    };
    selectRef.current = select;

    // Hover picking + click-to-select. A "tap" (little movement) selects;
    // a drag orbits the camera (so selection never fights OrbitControls).
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (ev: PointerEvent): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(buildings, false)[0]?.object as THREE.Mesh | undefined;
      return hit ? (hit.userData.id as string) : null;
    };
    let hoveredId: string | null = null;
    const setHoverId = (id: string | null) => {
      if (id === hoveredId) return;
      if (hoveredId) { const b = buildingById.get(hoveredId); if (b) b.mesh.userData.hover = false; }
      hoveredId = id;
      if (hoveredId) { const b = buildingById.get(hoveredId); if (b) b.mesh.userData.hover = true; }
      applyVisual();
    };
    const onPointerMove = (ev: PointerEvent) => {
      const id = pick(ev);
      setHoverId(id);
      const rect = renderer.domElement.getBoundingClientRect();
      if (id) {
        const p = byId.get(id);
        if (p) setHover({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, node: p.node });
      } else setHover(null);
      renderer.domElement.style.cursor = id ? 'pointer' : 'default';
    };
    const onPointerLeave = () => { setHoverId(null); setHover(null); };
    let downX = 0, downY = 0, downT = 0;
    const onPointerDown = (ev: PointerEvent) => { downX = ev.clientX; downY = ev.clientY; downT = performance.now(); };
    const onPointerUp = (ev: PointerEvent) => {
      // Ignore drags (orbit) and long presses — only a quick tap selects.
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
      if (performance.now() - downT > 500) return;
      select(pick(ev));
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') select(null); };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);

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
      window.removeEventListener('keydown', onKey);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      selectRef.current = () => {};
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [placedData, streetEdges]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
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

      <div className={`relative mt-4 w-full overflow-hidden rounded-xl border border-line bg-[#0a0c10] ${heightClass}`}>
        <div ref={mountRef} className="absolute inset-0" />
        {hover && !selected && (
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

        {!selected && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-[11px] text-slate-300 backdrop-blur-sm">
            Click a tower to focus its connections · drag to orbit
          </div>
        )}

        {selected && (
          <div
            data-testid="city-detail-panel"
            className="absolute right-3 top-3 z-20 max-h-[calc(100%-1.5rem)] w-72 overflow-y-auto rounded-xl border border-white/10 bg-[#0d1018]/95 p-4 text-slate-100 shadow-2xl backdrop-blur-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-wide text-accent">Focused activity</div>
                <div className="mt-0.5 break-words text-sm font-semibold leading-snug">{selected.node.label}</div>
              </div>
              <button
                onClick={() => selectRef.current(null)}
                className="shrink-0 rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:bg-white/10"
                aria-label="Clear selection"
              >
                Esc
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-white/5 bg-white/5 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">Runs</div>
                <div className="tabular-nums text-sm font-semibold">{formatNumber(selected.node.frequency)}</div>
              </div>
              <div className="rounded-lg border border-white/5 bg-white/5 px-2.5 py-1.5">
                <div className="text-[10px] text-slate-400">Avg time</div>
                <div className="tabular-nums text-sm font-semibold">
                  {selected.node.avg_duration == null ? '—' : formatDuration(selected.node.avg_duration)}
                </div>
              </div>
            </div>

            <NeighborList title={`Comes from (${selected.inN.length})`} nodes={selected.inN} onPick={(id) => selectRef.current(id)} />
            <NeighborList title={`Goes to (${selected.outN.length})`} nodes={selected.outN} onPick={(id) => selectRef.current(id)} />

            {selected.inN.length === 0 && selected.outN.length === 0 && (
              <div className="mt-3 text-[11px] text-slate-400">No dominant connections in the shown traffic.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NeighborList({
  title,
  nodes,
  onPick,
}: {
  title: string;
  nodes: ProcessNode[];
  onPick: (id: string) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{title}</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {nodes.map((n) => (
          <button
            key={n.id}
            onClick={() => onPick(n.id)}
            title={`${n.label} · ${formatNumber(n.frequency)} runs`}
            className="max-w-full truncate rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-200 transition-colors hover:border-accent/50 hover:bg-accent/10"
          >
            {n.label}
          </button>
        ))}
      </div>
    </div>
  );
}
