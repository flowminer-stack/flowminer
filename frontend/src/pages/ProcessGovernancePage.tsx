import { useEffect, useState } from 'react';
import { FileCheck, Plus, Clock, GitPullRequest } from 'lucide-react';
import clsx from 'clsx';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { governance, type GovernanceEntry, type GovernanceStatus } from '@/api/client';
import ChangeRequestsPanel from '@/components/Governance/ChangeRequestsPanel';
import { useProjectsStore } from '@/store';

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

type Tab = 'entries' | 'change-requests';

const TABS: Array<{ value: Tab; label: string; icon: typeof FileCheck }> = [
  { value: 'entries', label: 'Lifecycle entries', icon: FileCheck },
  { value: 'change-requests', label: 'Change requests', icon: GitPullRequest },
];

export default function ProcessGovernancePage() {
  const [tab, setTab] = useState<Tab>('entries');
  const [entries, setEntries] = useState<GovernanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, unknown[]>>({});

  // Project scope for the change-requests panel
  const projects = useProjectsStore((s) => s.projects);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);
  const currentProject = useProjectsStore((s) => s.currentProject);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  // Derive the effective project id: prefer currentProject, fall back to picker
  const projectId = currentProject?.id ?? selectedProjectId;

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

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

      {/* Tab bar */}
      <div className="mt-5 flex items-center gap-1 border-b border-line">
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={clsx(
              'flex items-center gap-1.5 border-b-2 px-3 pb-2 pt-1 text-[12px] font-medium transition-colors',
              tab === value
                ? 'border-accent text-accent'
                : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Lifecycle entries tab ─────────────────────────────────────── */}
      {tab === 'entries' && (
        <>
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
        </>
      )}

      {/* ── Change requests tab ───────────────────────────────────────── */}
      {tab === 'change-requests' && (
        <div className="mt-6">
          {/* Project picker — shown only when no current project is set in the store */}
          {!currentProject && (
            <div className="mb-5 flex items-center gap-3">
              <label className="text-[12px] font-medium text-fg-muted">Project</label>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="input py-1 text-[11px]"
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {projectId ? (
            <ChangeRequestsPanel projectId={projectId} />
          ) : (
            <div className="mt-12 rounded-lg border border-dashed border-line bg-surface-1 p-8 text-center">
              <p className="text-[12px] text-fg-muted">
                Select a project above to view and create change requests.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
