import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Inbox,
  CheckCircle2,
  BellOff,
  ArchiveX,
  Play,
  Trash2,
  AlertCircle,
  Plus,
  Search,
  X,
  ArrowRight,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import { tasks as tasksApi } from '@/api/client';
import { useProjectsStore, useUIStore } from '@/store';
import type { Task, TaskStatus, TaskPriority, TaskSummary } from '@/types';
import PageHeader from '@/components/common/PageHeader';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import Modal from '@/components/common/Modal';
import WhatsChangedDigest from '@/components/Inbox/WhatsChangedDigest';

const STATUS_TABS: Array<{
  value: TaskStatus | 'all';
  label: string;
  icon: typeof Inbox;
}> = [
  { value: 'all', label: 'All', icon: Inbox },
  { value: 'open', label: 'Open', icon: AlertCircle },
  { value: 'in_progress', label: 'In Progress', icon: Play },
  { value: 'snoozed', label: 'Snoozed', icon: BellOff },
  { value: 'resolved', label: 'Resolved', icon: CheckCircle2 },
  { value: 'closed', label: 'Closed', icon: ArchiveX },
];

const PRIORITY_CLASSES: Record<TaskPriority, string> = {
  urgent: 'bg-danger/10 text-danger',
  high: 'bg-warning/10 text-warning',
  medium: 'bg-accent/10 text-accent',
  low: 'bg-tint text-fg-muted',
};

export default function InboxPage() {
  const projects = useProjectsStore((s) => s.projects);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);
  const addNotification = useUIStore((s) => s.addNotification);

  const [taskList, setTaskList] = useState<Task[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskStatus | 'all'>('open');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Task | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Create form state
  const [createProjectId, setCreateProjectId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createPriority, setCreatePriority] = useState<TaskPriority>('medium');

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const load = async () => {
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        tasksApi.list(),
        tasksApi.summary(),
      ]);
      setTaskList(list);
      setSummary(sum);
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Failed to load inbox',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projectById = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects],
  );

  const filtered = useMemo(() => {
    let out = taskList;
    if (tab !== 'all') {
      out = out.filter((t) => t.status === tab);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q) ||
          (t.case_id || '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [taskList, tab, search]);

  const countFor = (s: TaskStatus | 'all'): number => {
    if (!summary) return 0;
    if (s === 'all') return summary.total;
    return summary[s] ?? 0;
  };

  const updateStatus = async (task: Task, status: TaskStatus) => {
    try {
      const updated = await tasksApi.update(task.id, { status });
      setTaskList((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
      if (selected?.id === task.id) setSelected(updated);
      await loadSummary();
      addNotification({ type: 'success', title: `Task marked ${status.replace('_', ' ')}` });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update task' });
    }
  };

  const deleteTask = async (task: Task) => {
    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
    try {
      await tasksApi.delete(task.id);
      setTaskList((prev) => prev.filter((t) => t.id !== task.id));
      if (selected?.id === task.id) setSelected(null);
      await loadSummary();
      addNotification({ type: 'success', title: 'Task deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete task' });
    }
  };

  const loadSummary = async () => {
    try {
      const s = await tasksApi.summary();
      setSummary(s);
    } catch {
      /* ignore */
    }
  };

  const handleCreate = async () => {
    if (!createProjectId || !createTitle.trim()) return;
    try {
      const t = await tasksApi.create({
        project_id: createProjectId,
        title: createTitle.trim(),
        description: createDescription.trim() || null,
        priority: createPriority,
      });
      setTaskList((prev) => [t, ...prev]);
      await loadSummary();
      setCreateOpen(false);
      setCreateTitle('');
      setCreateDescription('');
      setCreateProjectId('');
      setCreatePriority('medium');
      addNotification({ type: 'success', title: 'Task created' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to create task' });
    }
  };

  if (loading && taskList.length === 0) {
    return <LoadingSpinner size="lg" text="Loading inbox…" fullPage />;
  }

  return (
    <div>
      <PageHeader
        title="Inbox"
        icon={Inbox}
        description="Operational tasks across every project you can see. Work through items, transition status, and resolve them here."
        actions={
          <button
            onClick={() => {
              setCreateProjectId(projects[0]?.id ?? '');
              setCreateOpen(true);
            }}
            className="btn-primary"
          >
            <Plus size={15} />
            New Task
          </button>
        }
      />

      {/* Proactive "what changed since your last visit" digest. */}
      <div className="mt-6">
        <WhatsChangedDigest />
      </div>

      {/* Status tabs */}
      <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-line pb-3">
        {STATUS_TABS.map((t) => {
          const count = countFor(t.value);
          const active = tab === t.value;
          const Icon = t.icon;
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors',
                active
                  ? 'bg-accent/10 text-accent'
                  : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
              )}
            >
              <Icon size={13} />
              {t.label}
              <span
                className={clsx(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                  active ? 'bg-accent/15' : 'bg-tint',
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
        <div className="ml-auto relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="input pl-7 pr-7 py-1.5 text-[12px] w-48"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* List + detail */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* Task list */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={
                search
                  ? `No tasks match "${search}"`
                  : tab === 'all'
                    ? 'Your inbox is empty'
                    : `No ${tab.replace('_', ' ')} tasks`
              }
              description="Tasks appear here when action rules fire on process conditions, or create one manually to start tracking work."
              action={
                !search && tab === 'all' ? (
                  <button
                    onClick={() => {
                      setCreateProjectId(projects[0]?.id ?? '');
                      setCreateOpen(true);
                    }}
                    className="btn-secondary text-[12px]"
                  >
                    <Plus size={13} />
                    Create a task
                  </button>
                ) : undefined
              }
            />
          ) : (
            filtered.map((task) => (
              <button
                key={task.id}
                onClick={() => setSelected(task)}
                className={clsx(
                  'card w-full p-4 text-left transition-colors',
                  selected?.id === task.id && 'border-accent/40 bg-accent/5',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[13px] font-semibold text-fg">{task.title}</h3>
                      <span
                        className={clsx(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                          PRIORITY_CLASSES[task.priority],
                        )}
                      >
                        {task.priority}
                      </span>
                    </div>
                    {task.description && (
                      <p className="mt-1 line-clamp-1 text-[11px] text-fg-muted">
                        {task.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-fg-faint">
                      <span className="truncate">
                        {projectById[task.project_id]?.name ?? 'Unknown project'}
                      </span>
                      {task.case_id && (
                        <span className="font-mono">case {task.case_id}</span>
                      )}
                      <span>{formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}</span>
                    </div>
                  </div>
                  <StatusBadge status={task.status} />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail pane */}
        <div className="lg:sticky lg:top-4">
          {selected ? (
            <TaskDetailPane
              task={selected}
              projectName={projectById[selected.project_id]?.name}
              onClose={() => setSelected(null)}
              onStatus={(s) => updateStatus(selected, s)}
              onDelete={() => deleteTask(selected)}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-line p-8 text-center">
              <Inbox size={22} className="mx-auto text-fg-ghost" />
              <p className="mt-2 text-[12px] text-fg-muted">
                Select a task to see its details.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New task"
        footer={
          <>
            <button onClick={() => setCreateOpen(false)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!createTitle.trim() || !createProjectId}
              className="btn-primary"
            >
              Create task
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Project
            </label>
            <select
              value={createProjectId}
              onChange={(e) => setCreateProjectId(e.target.value)}
              className="input w-full"
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Title
            </label>
            <input
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="e.g. Review outlier invoices for Vendor X"
              className="input w-full"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Description{' '}
              <span className="font-normal text-fg-faint">(optional)</span>
            </label>
            <textarea
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              rows={3}
              className="input resize-none w-full"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Priority
            </label>
            <select
              value={createPriority}
              onChange={(e) => setCreatePriority(e.target.value as TaskPriority)}
              className="input w-full"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ── Status badge ───────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: TaskStatus }) {
  const config: Record<TaskStatus, { label: string; className: string }> = {
    open: { label: 'Open', className: 'bg-accent/10 text-accent' },
    in_progress: { label: 'In Progress', className: 'bg-warning/10 text-warning' },
    snoozed: { label: 'Snoozed', className: 'bg-tint text-fg-muted' },
    resolved: { label: 'Resolved', className: 'bg-success/10 text-success' },
    closed: { label: 'Closed', className: 'bg-tint text-fg-muted' },
  };
  const c = config[status];
  return (
    <span
      className={clsx(
        'shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold',
        c.className,
      )}
    >
      {c.label}
    </span>
  );
}

/* ── Task detail pane ───────────────────────────────────────────────────── */

function TaskDetailPane({
  task,
  projectName,
  onClose,
  onStatus,
  onDelete,
}: {
  task: Task;
  projectName?: string;
  onClose: () => void;
  onStatus: (s: TaskStatus) => void;
  onDelete: () => void;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-fg">{task.title}</h2>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
            <StatusBadge status={task.status} />
            <span
              className={clsx(
                'rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                PRIORITY_CLASSES[task.priority],
              )}
            >
              {task.priority}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
        >
          <X size={13} />
        </button>
      </div>

      {task.description && (
        <div className="mt-4 rounded-lg border border-line/60 bg-surface-1 p-3 text-[12px] text-fg-secondary">
          {task.description}
        </div>
      )}

      <div className="mt-4 space-y-2 text-[11px]">
        <DetailRow label="Project" value={projectName ?? '—'} />
        {task.case_id && <DetailRow label="Case" value={task.case_id} mono />}
        <DetailRow
          label="Created"
          value={formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
        />
        {task.resolved_at && (
          <DetailRow
            label="Resolved"
            value={formatDistanceToNow(new Date(task.resolved_at), { addSuffix: true })}
          />
        )}
        {task.event_log_id && (
          <div className="flex items-center justify-between gap-2 py-1 text-[11px]">
            <span className="text-fg-muted">Event log</span>
            <Link
              to={`/process/${task.event_log_id}`}
              className="flex items-center gap-1 font-semibold text-accent hover:text-accent-hover"
            >
              Open <ArrowRight size={10} />
            </Link>
          </div>
        )}
      </div>

      <div className="mt-5 space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-fg-faint">Actions</p>
        <div className="flex flex-wrap gap-2">
          {task.status !== 'in_progress' && (
            <button
              onClick={() => onStatus('in_progress')}
              className="btn-secondary text-[11px]"
            >
              <Play size={11} />
              Start
            </button>
          )}
          {task.status !== 'snoozed' && (
            <button
              onClick={() => onStatus('snoozed')}
              className="btn-secondary text-[11px]"
            >
              <BellOff size={11} />
              Snooze
            </button>
          )}
          {task.status !== 'resolved' && (
            <button
              onClick={() => onStatus('resolved')}
              className="btn-primary text-[11px]"
            >
              <CheckCircle2 size={11} />
              Resolve
            </button>
          )}
          {task.status === 'resolved' && (
            <button
              onClick={() => onStatus('open')}
              className="btn-secondary text-[11px]"
            >
              Reopen
            </button>
          )}
        </div>
        <button
          onClick={onDelete}
          className="btn-ghost text-[11px] text-danger hover:bg-danger/10"
        >
          <Trash2 size={11} />
          Delete task
        </button>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-fg-muted">{label}</span>
      <span className={clsx('truncate font-semibold text-fg', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}
