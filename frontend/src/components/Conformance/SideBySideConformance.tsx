import { useEffect, useMemo, useState } from 'react';
import { Columns } from 'lucide-react';
import ProcessMap from '@/components/ProcessMap/ProcessMap';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { mining as miningApi } from '@/api/client';
import type { DiscoveryResponse, ProcessNode } from '@/types';

// ARIS-style side-by-side conformance view. Two process maps render
// simultaneously: left = reference model (inductive miner at a
// high-cut threshold), right = mined DFG from the actual log.
// Clicking a node in either map selects the same-labelled node in
// the other so users can eyeball deviations visually.
//
// The "reference" model is conceptually meant to be a user-authored
// baseline. We don't have a BPMN upload path yet, so for the MVP we
// pretend a clean inductive-miner run *is* the baseline. Swap in a
// real reference once the BPMN import endpoint exists.

export default function SideBySideConformance({ eventLogId }: { eventLogId: string }) {
  const [reference, setReference] = useState<DiscoveryResponse | null>(null);
  const [mined, setMined] = useState<DiscoveryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncedNode, setSyncedNode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Reference = clean inductive-miner run at high filter threshold.
    // Mined = heuristic miner run (includes noise paths the model
    // doesn't sanction). The two make a meaningful diff the user can
    // inspect side by side without a BPMN upload step.
    Promise.all([
      miningApi.discover({ event_log_id: eventLogId, algorithm: 'inductive', parameters: { threshold: 0.3 } }),
      miningApi.discover({ event_log_id: eventLogId, algorithm: 'heuristic' }),
    ])
      .then(([ref, act]) => {
        if (!cancelled) {
          setReference(ref);
          setMined(act);
        }
      })
      .catch((e) => {
        if (!cancelled)
          setError(e?.response?.data?.detail ?? 'Failed to load side-by-side view');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [eventLogId]);

  // Activities present in both models: used to paint conforming nodes.
  // Activities only in one side become "deviation" highlights.
  const { refOnly, minedOnly } = useMemo(() => {
    if (!reference || !mined) return { refOnly: new Set(), minedOnly: new Set() };
    const refSet = new Set(reference.nodes.map((n) => n.label));
    const minedSet = new Set(mined.nodes.map((n) => n.label));
    return {
      refOnly: new Set([...refSet].filter((x) => !minedSet.has(x))),
      minedOnly: new Set([...minedSet].filter((x) => !refSet.has(x))),
    };
  }, [reference, mined]);

  if (loading) {
    return (
      <div className="card p-5">
        <LoadingSpinner size="md" text="Running reference + mined discovery…" />
      </div>
    );
  }
  if (error || !reference || !mined) {
    return (
      <div className="card p-5">
        <p className="text-[11px] text-danger">{error}</p>
      </div>
    );
  }

  const onSelect = (node: ProcessNode) => {
    setSyncedNode(node.label);
  };

  return (
    <div className="card p-5">
      <div className="mb-2 flex items-center gap-2">
        <Columns size={14} className="text-accent" />
        <h3 className="text-[13px] font-semibold text-fg">
          Side-by-side conformance
        </h3>
      </div>
      <p className="text-[11px] text-fg-muted">
        Left = reference model (clean inductive miner). Right = mined DFG
        from the actual log. Clicking a node highlights the matching
        activity in the other panel, so deviations pop visually.
      </p>
      <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
        <Legend color="bg-danger/20 border-danger/40" label={`Reference-only (${refOnly.size})`} />
        <Legend color="bg-warning/20 border-warning/40" label={`Mined-only (${minedOnly.size})`} />
        {syncedNode && (
          <span className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent">
            Synced: {syncedNode}
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2" style={{ height: 420 }}>
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-faint">
            Reference model
          </div>
          <div className="flex-1">
            <ProcessMap
              nodes={reference.nodes}
              edges={reference.edges}
              complexity={100}
              layoutName="dagre"
              showHoverTooltip
              onNodeClick={onSelect}
              selectedNode={
                syncedNode
                  ? reference.nodes.find((n) => n.label === syncedNode)?.id
                  : undefined
              }
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-faint">
            Mined log
          </div>
          <div className="flex-1">
            <ProcessMap
              nodes={mined.nodes}
              edges={mined.edges}
              complexity={100}
              layoutName="dagre"
              showHoverTooltip
              onNodeClick={onSelect}
              selectedNode={
                syncedNode ? mined.nodes.find((n) => n.label === syncedNode)?.id : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-sm border ${color}`} />
      <span className="text-fg-muted">{label}</span>
    </span>
  );
}
