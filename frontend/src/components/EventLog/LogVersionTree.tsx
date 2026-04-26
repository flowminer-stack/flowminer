import { useEffect, useMemo, useState } from 'react';
import { GitBranch, Plus, Trash2, Download } from 'lucide-react';
import { governance, type LogVersion } from '@/api/client';
import { useFilterStore } from '@/store/filterStore';

// Apromore-style log version tree. Users snapshot the current filter
// state as a named version, optionally branched off a parent. The
// backend stores the filter payload JSON so loading a version pipes
// the saved chips back into the shared filter store, re-scoping every
// downstream analysis.

interface TreeNode extends LogVersion {
  children: TreeNode[];
}

function buildVersionTree(flat: LogVersion[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const v of flat) map.set(v.id, { ...v, children: [] });
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  return roots;
}

export default function LogVersionTree({ eventLogId }: { eventLogId: string }) {
  const [versions, setVersions] = useState<LogVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const serialise = useFilterStore((s) => s.serialise);
  const deserialise = useFilterStore((s) => s.deserialise);

  const reload = () => {
    setLoading(true);
    governance
      .listLogVersions(eventLogId)
      .then(setVersions)
      .finally(() => setLoading(false));
  };

  useEffect(reload, [eventLogId]);

  const tree = useMemo(() => buildVersionTree(versions), [versions]);

  const handleSnapshot = async () => {
    const name = window.prompt('Version name:');
    if (!name) return;
    const description = window.prompt('Optional description:') ?? undefined;
    const filterJson = serialise();
    try {
      await governance.createLogVersion({
        event_log_id: eventLogId,
        parent_id: selectedParent,
        name,
        description,
        filter_payload: JSON.parse(filterJson),
      });
      reload();
    } catch (e) {
      console.error(e);
    }
  };

  const handleLoad = (v: LogVersion) => {
    if (v.filter_payload) {
      deserialise(JSON.stringify(v.filter_payload));
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this version? Child branches will become roots.'))
      return;
    await governance.deleteLogVersion(id);
    reload();
  };

  const renderNode = (node: TreeNode, depth = 0) => (
    <div key={node.id} style={{ marginLeft: depth * 16 }}>
      <div
        className={`mt-1 flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
          selectedParent === node.id
            ? 'border-accent bg-accent/5'
            : 'border-line bg-surface-0 hover:border-line-strong'
        }`}
      >
        <button
          type="button"
          onClick={() => setSelectedParent(node.id === selectedParent ? null : node.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title="Click to select as parent for the next snapshot"
        >
          <GitBranch size={11} className="shrink-0 text-fg-muted" />
          <span className="truncate text-[11px] font-semibold text-fg">
            {node.name}
          </span>
          {node.description && (
            <span className="truncate text-[10px] text-fg-faint">· {node.description}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => handleLoad(node)}
          className="rounded border border-line bg-surface-0 px-1.5 py-0.5 text-[9px] text-fg-muted hover:border-accent hover:text-accent"
          title="Load this version's filters"
        >
          <Download size={9} className="mr-0.5 inline" />
          load
        </button>
        <button
          type="button"
          onClick={() => handleDelete(node.id)}
          className="rounded border border-line bg-surface-0 px-1.5 py-0.5 text-[9px] text-fg-muted hover:border-danger hover:text-danger"
        >
          <Trash2 size={9} />
        </button>
      </div>
      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <GitBranch size={12} className="text-accent" />
        <span className="text-[11px] font-semibold text-fg">Log version tree</span>
        <button
          type="button"
          onClick={handleSnapshot}
          className="ml-auto flex items-center gap-1 rounded border border-line bg-surface-0 px-2 py-0.5 text-[10px] font-medium text-fg-muted hover:border-accent hover:text-accent"
          title="Snapshot current filters as a new version"
        >
          <Plus size={9} />
          Snapshot
        </button>
      </div>
      {selectedParent && (
        <p className="mb-2 text-[10px] text-fg-muted">
          Parent selected — next snapshot branches from{' '}
          <span className="font-semibold">
            {versions.find((v) => v.id === selectedParent)?.name}
          </span>
          .{' '}
          <button
            type="button"
            onClick={() => setSelectedParent(null)}
            className="text-accent hover:underline"
          >
            clear
          </button>
        </p>
      )}
      {loading ? (
        <p className="text-[10px] text-fg-muted">Loading…</p>
      ) : tree.length === 0 ? (
        <p className="text-[10px] text-fg-ghost">
          No versions yet. Apply some filters, then hit Snapshot.
        </p>
      ) : (
        <div>{tree.map((n) => renderNode(n))}</div>
      )}
    </div>
  );
}
