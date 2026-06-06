import type { ProcessNode, ProcessEdge } from '@/types/mining';

/**
 * Shared "top-paths" graph simplification for every process view (2D map,
 * 3D Process City, Pulse …).
 *
 * The previous map logic force-kept EVERY edge touching a start or end
 * activity as "structural backbone". That assumes a handful of start/end
 * activities — true for synthetic logs, false for real ones like BPIC2019,
 * where dozens of activities are start/end. There the backbone swallowed the
 * whole graph (491 of 498 edges) and the detail slider had nothing left to
 * trim, so the map stayed a hairball no matter what.
 *
 * Instead we rank ALL edges by frequency and keep the strongest, then add a
 * *bounded* connectivity guarantee: each start activity keeps its single
 * strongest outgoing edge and each end activity its strongest incoming one, so
 * the process stays anchored without re-introducing the hairball.
 */

export interface SimplifyOptions {
  /** 0–100: keep this percentage of edges, ranked by frequency. 100 = all. */
  complexity?: number;
  /** Absolute cap on kept edges. Takes precedence over `complexity`. */
  maxEdges?: number;
  /**
   * Keep every input node even if simplification left it with no edges.
   * Process City wants this — the skyline shows all activities as towers and
   * only thins the *streets*. The 2D map wants the default (false): drop
   * orphaned nodes so the canvas isn't littered with disconnected boxes.
   */
  keepAllNodes?: boolean;
}

export interface SimplifiedGraph {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export function simplifyGraph(
  nodes: ProcessNode[],
  edges: ProcessEdge[],
  opts: SimplifyOptions = {},
): SimplifiedGraph {
  if (edges.length === 0) return { nodes, edges };

  const sorted = [...edges].sort((a, b) => b.frequency - a.frequency);

  let target: number;
  if (opts.maxEdges != null) {
    target = Math.min(opts.maxEdges, sorted.length);
  } else {
    const c = opts.complexity ?? 100;
    target = Math.max(0, Math.ceil((c / 100) * sorted.length));
  }

  const kept = new Set<ProcessEdge>(sorted.slice(0, target));

  // Bounded connectivity guarantee — anchor every start/end activity with at
  // most one extra edge each (its strongest), so aggressive trims still read
  // as a process rather than a scatter of nodes.
  const startIds = new Set(nodes.filter((n) => n.is_start).map((n) => n.id));
  const endIds = new Set(nodes.filter((n) => n.is_end).map((n) => n.id));
  const hasOut = new Set<string>();
  const hasIn = new Set<string>();
  for (const e of kept) {
    hasOut.add(e.source);
    hasIn.add(e.target);
  }
  for (const s of startIds) {
    if (!hasOut.has(s)) {
      const best = sorted.find((e) => e.source === s); // strongest (sorted desc)
      if (best) kept.add(best);
    }
  }
  for (const t of endIds) {
    if (!hasIn.has(t)) {
      const best = sorted.find((e) => e.target === t);
      if (best) kept.add(best);
    }
  }

  // Preserve frequency order in the output.
  const keptEdges = sorted.filter((e) => kept.has(e));

  if (opts.keepAllNodes) return { nodes, edges: keptEdges };

  const visibleNodeIds = new Set<string>();
  for (const e of keptEdges) {
    visibleNodeIds.add(e.source);
    visibleNodeIds.add(e.target);
  }
  for (const id of startIds) visibleNodeIds.add(id);
  for (const id of endIds) visibleNodeIds.add(id);

  return {
    nodes: nodes.filter((n) => visibleNodeIds.has(n.id)),
    edges: keptEdges,
  };
}
