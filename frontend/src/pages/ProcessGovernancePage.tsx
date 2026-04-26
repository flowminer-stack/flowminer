import { useEffect, useState } from 'react';
import { FileCheck, Plus, Clock } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { governance, type GovernanceEntry, type GovernanceStatus } from '@/api/client';

// ARIS Flows-style governance lifecycle. Backed by ``governance_entries``
// + ``governance_transitions`` so every promotion is recorded with
// actor + comment in an immutable audit trail. The previous MVP used
// localStorage; this is the real thing.

const statusColor: Record<GovernanceStatus, string> = {
  draft: 'bg-tint text-fg-muted',
  review: 'bg-warning/10 text-warning',
  approved: 'bg-success/10 text-success',
  published: 'bg-accent/10 text-accent',
  retired: 'bg-danger/10 text-danger',
};

const nextState: Record<GovernanceStatus, GovernanceStatus | null> = {
  draft: 'review',
  review: 'approved',
  approved: 'published',
  published: 'retired',
  retired: null,
};

export default function ProcessGovernancePage() {
  const [entries, setEntries] = useState<GovernanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, unknown[]>>({});

  const reload = () => {
    setLoading(true);
    governance
      .listEntries()
      .then(setEntries)
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  const handleAdd = async () => {
    await governance.createEntry({ name: 'Untitled process', version: '1.0', notes: '' });
    reload();
  };

  const updateField = async (id: string, patch: Partial<GovernanceEntry>) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    await governance.updateEntry(id, {
      name: patch.name ?? e.name,
      version: patch.version ?? e.version,
      notes: patch.notes ?? e.notes,
    });
    setEntries((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };

  const promote = async (id: string) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const n = nextState[e.status];
    if (!n) return;
    const comment = window.prompt(`Promoting "${e.name}" to ${n}. Optional comment:`);
    await governance.promoteEntry(id, n, comment || undefined);
    reload();
  };

  const showHistory = async (id: string) => {
    if (expanded[id]) {
      setExpanded((p) => {
        const copy = { ...p };
        delete copy[id];
        return copy;
      });
      return;
    }
    const h = await governance.entryHistory(id);
    setExpanded((p) => ({ ...p, [id]: h }));
  };

  return (
    <div>
      <PageHeader
        title="Process governance"
        icon={FileCheck}
        description="Draft → review → approved → published → retired. Every promotion is audited with actor and comment."
      />

      <div className="mt-6 flex items-center justify-end">
        <button onClick={handleAdd} className="btn-primary text-[11px]">
          <Plus size={11} />
          New process entry
        </button>
      </div>

      {loading ? (
        <LoadingSpinner fullPage text="Loading governance entries…" />
      ) : entries.length === 0 ? (
        <div className="mt-12 rounded-lg border border-dashed border-line bg-surface-1 p-8 text-center">
          <p className="text-[12px] text-fg-muted">
            No governance entries yet. Add one to track a process model through its lifecycle.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {entries.map((e) => {
            const history = expanded[e.id];
            return (
              <div key={e.id} className="rounded-lg border border-line bg-surface-1 p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <input
                      value={e.name}
                      onChange={(ev) =>
                        updateField(e.id, { name: ev.target.value })
                      }
                      className="w-full bg-transparent text-[13px] font-semibold text-fg outline-none"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-fg-muted">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusColor[e.status]}`}
                      >
                        {e.status}
                      </span>
                      <span>
                        v{' '}
                        <input
                          value={e.version}
                          onChange={(ev) => updateField(e.id, { version: ev.target.value })}
                          className="w-12 bg-transparent text-fg-secondary outline-none"
                        />
                      </span>
                      <span className="text-fg-faint">
                        updated {new Date(e.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                    <textarea
                      value={e.notes ?? ''}
                      onChange={(ev) => updateField(e.id, { notes: ev.target.value })}
                      placeholder="Notes, rationale, open questions…"
                      className="mt-2 w-full resize-none bg-transparent text-[11px] text-fg-muted outline-none"
                      rows={1}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    {nextState[e.status] && (
                      <button
                        onClick={() => promote(e.id)}
                        className="btn-secondary whitespace-nowrap text-[10px]"
                      >
                        → {nextState[e.status]}
                      </button>
                    )}
                    <button
                      onClick={() => showHistory(e.id)}
                      className="flex items-center gap-1 rounded border border-line bg-surface-0 px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
                    >
                      <Clock size={10} />
                      History
                    </button>
                  </div>
                </div>
                {history && Array.isArray(history) && history.length > 0 && (
                  <div className="mt-3 space-y-1 rounded-md bg-surface-0 px-3 py-2">
                    {(
                      history as Array<{
                        id: string;
                        from_status: string | null;
                        to_status: string;
                        comment: string | null;
                        created_at: string;
                      }>
                    ).map((h) => (
                      <div key={h.id} className="text-[10px] text-fg-muted">
                        <span className="font-semibold">
                          {h.from_status ?? '—'} → {h.to_status}
                        </span>{' '}
                        · {new Date(h.created_at).toLocaleString()}
                        {h.comment && <> · {h.comment}</>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
