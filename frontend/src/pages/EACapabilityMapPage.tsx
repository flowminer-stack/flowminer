import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Grid3x3, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  governance,
  eventLogs as logsApi,
  projects as projectsApi,
  type Capability,
} from '@/api/client';
import type { EventLog, Project } from '@/types';

// Mavim-style EA capability map backed by the ``capabilities`` table.
// Users build a tree of business capabilities (each with a parent),
// link one or more event logs per capability, and drill into a
// process view from any cell. KPI badges show total cases / events
// rolled up across linked logs.

interface CapNode extends Capability {
  children: CapNode[];
}

function buildTree(flat: Capability[]): CapNode[] {
  const map = new Map<string, CapNode>();
  for (const c of flat) map.set(c.id, { ...c, children: [] });
  const roots: CapNode[] = [];
  for (const n of map.values()) {
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  return roots;
}

export default function EACapabilityMapPage() {
  const navigate = useNavigate();
  const [caps, setCaps] = useState<Capability[]>([]);
  const [allLogs, setAllLogs] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = () => {
    setLoading(true);
    Promise.all([governance.listCapabilities(), projectsApi.list()])
      .then(async ([capData, projs]) => {
        setCaps(capData);
        const logResults = await Promise.allSettled(
          (projs as Project[]).map((p) => logsApi.list(p.id)),
        );
        const logs = logResults
          .filter((r): r is PromiseFulfilledResult<EventLog[]> => r.status === 'fulfilled')
          .flatMap((r) => r.value);
        setAllLogs(logs);
      })
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  const tree = useMemo(() => buildTree(caps), [caps]);
  const logById = useMemo(
    () => new Map(allLogs.map((l) => [l.id, l])),
    [allLogs],
  );

  const handleAddRoot = async () => {
    const name = window.prompt('New capability name:');
    if (!name) return;
    await governance.createCapability({ name });
    reload();
  };

  const handleAddChild = async (parentId: string) => {
    const name = window.prompt('New sub-capability name:');
    if (!name) return;
    await governance.createCapability({ name, parent_id: parentId });
    reload();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this capability and all its children?')) return;
    await governance.deleteCapability(id);
    reload();
  };

  const handleLinkLog = async (cap: Capability) => {
    const logId = window.prompt(
      `Link an event log to "${cap.name}". Paste the log ID:`,
    );
    if (!logId) return;
    await governance.updateCapability(cap.id, {
      linked_event_log_ids: [...cap.linked_event_log_ids, logId],
    });
    reload();
  };

  const handleUnlinkLog = async (cap: Capability, logId: string) => {
    await governance.updateCapability(cap.id, {
      linked_event_log_ids: cap.linked_event_log_ids.filter((x) => x !== logId),
    });
    reload();
  };

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: CapNode, depth = 0) => {
    const isOpen = expanded.has(node.id);
    const linkedLogs = node.linked_event_log_ids
      .map((id) => logById.get(id))
      .filter((l): l is EventLog => !!l);
    const totalCases = linkedLogs.reduce((s, l) => s + (l.total_cases ?? 0), 0);
    const totalEvents = linkedLogs.reduce((s, l) => s + (l.total_events ?? 0), 0);
    return (
      <div key={node.id} style={{ marginLeft: depth * 18 }}>
        <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-line bg-surface-1 p-3">
          <button
            type="button"
            onClick={() => toggle(node.id)}
            className="mt-0.5 text-fg-faint hover:text-fg"
          >
            {node.children.length > 0 ? (
              isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />
            ) : (
              <span className="inline-block w-3" />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-fg">{node.name}</p>
            {node.description && (
              <p className="text-[10px] text-fg-muted">{node.description}</p>
            )}
            {linkedLogs.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-fg-faint">
                <span>{totalCases.toLocaleString()} cases</span>
                <span>·</span>
                <span>{totalEvents.toLocaleString()} events</span>
                <span>·</span>
                <span>{linkedLogs.length} log{linkedLogs.length !== 1 ? 's' : ''}</span>
              </div>
            )}
            {linkedLogs.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {linkedLogs.map((l) => (
                  <span
                    key={l.id}
                    className="group flex items-center gap-1 rounded bg-tint px-1.5 py-0.5 text-[10px] text-fg-secondary"
                  >
                    <button
                      type="button"
                      onClick={() => navigate(`/process/${l.id}`)}
                      className="hover:text-accent"
                    >
                      {l.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUnlinkLog(node, l.id)}
                      className="text-fg-ghost opacity-0 hover:text-danger group-hover:opacity-100"
                    >
                      <Trash2 size={9} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => handleAddChild(node.id)}
              className="rounded border border-line bg-surface-0 px-2 py-0.5 text-fg-muted hover:border-accent hover:text-accent"
            >
              <Plus size={9} /> Sub
            </button>
            <button
              type="button"
              onClick={() => handleLinkLog(node)}
              className="rounded border border-line bg-surface-0 px-2 py-0.5 text-fg-muted hover:border-accent hover:text-accent"
            >
              + Log
            </button>
            <button
              type="button"
              onClick={() => handleDelete(node.id)}
              className="rounded border border-line bg-surface-0 px-2 py-0.5 text-fg-muted hover:border-danger hover:text-danger"
            >
              <Trash2 size={9} />
            </button>
          </div>
        </div>
        {isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="EA capability map"
        icon={Grid3x3}
        description="Bird's-eye grid of your business capabilities with live KPI badges — click a cell to drill into its process view"
      />
      <div className="mt-6 flex items-center justify-end">
        <button onClick={handleAddRoot} className="btn-primary text-[11px]">
          <Plus size={11} />
          New root capability
        </button>
      </div>
      {loading ? (
        <LoadingSpinner fullPage text="Loading capability map…" />
      ) : tree.length === 0 ? (
        <div className="mt-12 rounded-lg border border-dashed border-line bg-surface-1 p-8 text-center">
          <p className="text-[12px] text-fg-muted">
            No capabilities defined yet. Create your first root capability to start
            building a tree.
          </p>
        </div>
      ) : (
        <div className="mt-6">{tree.map((n) => renderNode(n))}</div>
      )}
    </div>
  );
}
