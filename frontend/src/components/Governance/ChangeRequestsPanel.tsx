import { useEffect, useState, useCallback } from 'react';
import { GitPullRequest, Plus, CheckCircle, XCircle, SendHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
import { changeRequests } from '@/api/changeRequests';
import type { ChangeRequest, ChangeRequestCreate, ChangeRequestStatus } from '@/types/changeRequest';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import ErrorState from '@/components/common/ErrorState';
import EmptyState from '@/components/common/EmptyState';
import Modal from '@/components/common/Modal';
import { useAuthStore, useUIStore } from '@/store';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ChangeRequestsPanelProps {
  /** UUID of the project to list/create change requests for. */
  projectId: string;
}

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ChangeRequestStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In Review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_CLASS: Record<ChangeRequestStatus, string> = {
  draft: 'bg-tint text-fg-muted',
  submitted: 'bg-warning/10 text-warning',
  in_review: 'bg-accent/10 text-accent',
  approved: 'bg-success/10 text-success',
  rejected: 'bg-danger/10 text-danger',
};

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'in_review', label: 'In Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Sub-component: single row ────────────────────────────────────────────────

function CRRow({
  cr,
  isAdmin,
  onSubmit,
  onApprove,
  onReject,
  busy,
}: {
  cr: ChangeRequest;
  isAdmin: boolean;
  onSubmit: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busy: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const isBusy = busy === cr.id;
  const status = cr.status as ChangeRequestStatus;

  const canSubmit = status === 'draft';
  const canApproveReject = isAdmin && (status === 'submitted' || status === 'in_review');

  return (
    <div className="rounded-lg border border-line bg-surface-1">
      {/* Header row */}
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent mt-0.5">
          <GitPullRequest size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12px] font-semibold text-fg truncate">{cr.title}</p>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[status]}`}
            >
              {STATUS_LABEL[status]}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-fg-faint">
            <span>{cr.entity_type} · {cr.entity_id.slice(0, 8)}…</span>
            <span>Created {formatDate(cr.created_at)}</span>
          </div>
          {cr.description && (
            <p className="mt-1 text-[11px] text-fg-muted line-clamp-2">{cr.description}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* Action buttons */}
          {canSubmit && (
            <button
              disabled={isBusy}
              onClick={() => onSubmit(cr.id)}
              className="flex items-center gap-1 rounded-md border border-line bg-surface-0 px-2 py-1 text-[10px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
            >
              <SendHorizontal size={10} />
              Submit
            </button>
          )}
          {canApproveReject && (
            <>
              <button
                disabled={isBusy}
                onClick={() => onApprove(cr.id)}
                className="flex items-center gap-1 rounded-md border border-success/30 bg-success/5 px-2 py-1 text-[10px] font-medium text-success transition-colors hover:bg-success/10 disabled:opacity-50"
              >
                <CheckCircle size={10} />
                Approve
              </button>
              <button
                disabled={isBusy}
                onClick={() => onReject(cr.id)}
                className="flex items-center gap-1 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 text-[10px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                <XCircle size={10} />
                Reject
              </button>
            </>
          )}
          {cr.rejection_reason && (
            <p className="max-w-[160px] text-right text-[10px] italic text-danger">
              "{cr.rejection_reason}"
            </p>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md p-0.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* Expandable detail */}
      {expanded && (
        <div className="border-t border-line/60 bg-surface-0 px-3 py-2 text-[10px] text-fg-muted space-y-1">
          <div className="flex gap-4 flex-wrap">
            <span><span className="font-medium text-fg">apply_on_approve:</span> {cr.apply_on_approve ? 'yes' : 'no'}</span>
            {cr.approver_id && <span><span className="font-medium text-fg">Approver:</span> {cr.approver_id.slice(0, 8)}…</span>}
            {cr.reviewers.length > 0 && (
              <span><span className="font-medium text-fg">Reviewers:</span> {cr.reviewers.join(', ')}</span>
            )}
          </div>
          {cr.after_payload && (
            <div>
              <p className="font-medium text-fg mb-0.5">Proposed change keys:</p>
              <div className="flex flex-wrap gap-1">
                {Object.keys(cr.after_payload).map((k) => (
                  <span key={k} className="rounded-md bg-tint px-1.5 py-0.5">{k}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function ChangeRequestsPanel({ projectId }: ChangeRequestsPanelProps) {
  const addNotification = useUIStore((s) => s.addNotification);
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [items, setItems] = useState<ChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    description: string;
    entity_type: string;
    entity_id: string;
  }>({ title: '', description: '', entity_type: 'dashboard', entity_id: '' });

  // Action busy state: holds the CR id being acted on
  const [busy, setBusy] = useState<string | null>(null);

  // Reject modal
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await changeRequests.list(projectId, {
        status: statusFilter || undefined,
      });
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load change requests');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Create ────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!form.title.trim()) {
      addNotification({ type: 'error', title: 'Title is required' });
      return;
    }
    if (!form.entity_id.trim()) {
      addNotification({ type: 'error', title: 'Entity ID is required' });
      return;
    }
    setCreating(true);
    try {
      const body: ChangeRequestCreate = {
        project_id: projectId,
        entity_type: form.entity_type,
        entity_id: form.entity_id.trim(),
        title: form.title.trim(),
        description: form.description.trim() || undefined,
      };
      const created = await changeRequests.create(body);
      setItems((prev) => [created, ...prev]);
      setShowCreate(false);
      setForm({ title: '', description: '', entity_type: 'dashboard', entity_id: '' });
      addNotification({ type: 'success', title: 'Change request created', message: created.title });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Failed to create change request',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async (id: string) => {
    setBusy(id);
    try {
      const updated = await changeRequests.submit(id);
      setItems((prev) => prev.map((c) => (c.id === id ? updated : c)));
      addNotification({ type: 'success', title: 'Change request submitted for review' });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Submit failed',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  // ── Approve ───────────────────────────────────────────────────────────────

  const handleApprove = async (id: string) => {
    setBusy(id);
    try {
      const updated = await changeRequests.approve(id);
      setItems((prev) => prev.map((c) => (c.id === id ? updated : c)));
      addNotification({ type: 'success', title: 'Change request approved' });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Approve failed',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  // ── Reject ────────────────────────────────────────────────────────────────

  const handleConfirmReject = async () => {
    if (!rejectTarget) return;
    setBusy(rejectTarget);
    try {
      const updated = await changeRequests.reject(rejectTarget, rejectReason.trim() || undefined);
      setItems((prev) => prev.map((c) => (c.id === rejectTarget ? updated : c)));
      setRejectTarget(null);
      setRejectReason('');
      addNotification({ type: 'success', title: 'Change request rejected' });
    } catch (err) {
      addNotification({
        type: 'error',
        title: 'Reject failed',
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Panel header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-1 items-center gap-2">
          <GitPullRequest size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-fg">Change requests</h3>
          {!loading && items.length > 0 && (
            <span className="rounded-full bg-tint px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
              {items.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input py-1 text-[11px]"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-0 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={12} />
            New request
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <LoadingSpinner size="sm" text="Loading change requests…" className="py-6" />
      ) : error ? (
        <ErrorState compact message={error} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No change requests"
          description={
            statusFilter
              ? `No change requests with status "${STATUS_LABEL[statusFilter as ChangeRequestStatus] ?? statusFilter}".`
              : 'Submit a change request to propose and track modifications to process entities.'
          }
          compact
        />
      ) : (
        <div className="space-y-2">
          {items.map((cr) => (
            <CRRow
              key={cr.id}
              cr={cr}
              isAdmin={isAdmin}
              onSubmit={handleSubmit}
              onApprove={handleApprove}
              onReject={(id) => {
                setRejectTarget(id);
                setRejectReason('');
              }}
              busy={busy}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="New change request"
        size="md"
        footer={
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCreate(false)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !form.title.trim() || !form.entity_id.trim()}
              className="btn-primary"
            >
              {creating ? <LoadingSpinner size="sm" /> : <Plus size={13} />}
              Create
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
              Title <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Update invoice approval threshold"
              className="input w-full"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Why is this change needed?"
              className="input w-full resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
                Entity type
              </label>
              <select
                value={form.entity_type}
                onChange={(e) => setForm((f) => ({ ...f, entity_type: e.target.value }))}
                className="input w-full"
              >
                <option value="dashboard">Dashboard</option>
                <option value="event_log">Event log</option>
                <option value="process_model">Process model</option>
                <option value="governance_entry">Governance entry</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
                Entity ID <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={form.entity_id}
                onChange={(e) => setForm((f) => ({ ...f, entity_id: e.target.value }))}
                placeholder="UUID of the target entity"
                className="input w-full font-mono text-[11px]"
              />
            </div>
          </div>
          <p className="text-[11px] text-fg-faint">
            The request will be created as a draft. Submit it when ready for review.
          </p>
        </div>
      </Modal>

      {/* Reject modal */}
      <Modal
        isOpen={!!rejectTarget}
        onClose={() => setRejectTarget(null)}
        title="Reject change request"
        size="sm"
        footer={
          <div className="flex items-center gap-2">
            <button onClick={() => setRejectTarget(null)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleConfirmReject}
              disabled={!!busy}
              className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <LoadingSpinner size="sm" /> : <XCircle size={13} />}
              Reject
            </button>
          </div>
        }
      >
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-fg-muted">
            Reason <span className="font-normal text-fg-faint">(optional)</span>
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Explain why this request is being rejected…"
            className="input w-full resize-none"
            rows={3}
            autoFocus
          />
        </div>
      </Modal>
    </div>
  );
}
