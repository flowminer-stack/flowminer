import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Calendar,
  Plus,
  Trash2,
  Send,
  Pencil,
  ToggleLeft,
  ToggleRight,
  Clock,
  Mail,
  FileText,
  Hash,
  X,
  ChevronDown,
} from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { scheduledReports as reportsApi } from '@/api/scheduledReports';
import { eventLogs as eventLogsApi } from '@/api/eventLogs';
import type { ScheduledReport, ReportFrequency, ReportFormat } from '@/types/scheduledReport';
import type { EventLog } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import PageHeader from '@/components/common/PageHeader';
import { useUIStore } from '@/store';

// ─── Constants ───────────────────────────────────────────────────────────────

const FREQUENCY_LABELS: Record<ReportFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const FORMAT_LABELS: Record<ReportFormat, string> = {
  html: 'HTML',
  csv: 'CSV',
};

const SECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'bottlenecks', label: 'Bottlenecks' },
  { value: 'variants', label: 'Variants' },
  { value: 'insights', label: 'AI Insights' },
];

// ─── Email tag input ─────────────────────────────────────────────────────────

function EmailTagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addEmail = (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!email || value.includes(email)) {
      setInput('');
      return;
    }
    onChange([...value, email]);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmail(input);
    } else if (e.key === 'Backspace' && input === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/30 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((email) => (
        <span
          key={email}
          className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
        >
          {email}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((v) => v !== email));
            }}
            className="text-accent/60 hover:text-accent"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="email"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) addEmail(input); }}
        placeholder={value.length === 0 ? 'Add email address, press Enter' : ''}
        className="min-w-[180px] flex-1 bg-transparent text-[12px] text-fg placeholder:text-fg-faint outline-none"
      />
    </div>
  );
}

// ─── Report form (create + edit) ─────────────────────────────────────────────

interface ReportFormValues {
  name: string;
  event_log_id: string;
  frequency: ReportFrequency;
  report_format: ReportFormat;
  email_recipients: string[];
  include_sections: string[];
}

const DEFAULT_FORM: ReportFormValues = {
  name: '',
  event_log_id: '',
  frequency: 'weekly',
  report_format: 'html',
  email_recipients: [],
  include_sections: ['summary', 'bottlenecks', 'variants', 'insights'],
};

function ReportForm({
  initial,
  eventLogs,
  onSave,
  onCancel,
  saving,
}: {
  initial?: Partial<ReportFormValues>;
  eventLogs: EventLog[];
  onSave: (v: ReportFormValues) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<ReportFormValues>({
    ...DEFAULT_FORM,
    ...(initial ?? {}),
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ReportFormValues, string>>>({});

  const set = <K extends keyof ReportFormValues>(key: K, val: ReportFormValues[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const toggleSection = (section: string) => {
    const current = form.include_sections;
    set(
      'include_sections',
      current.includes(section)
        ? current.filter((s) => s !== section)
        : [...current, section],
    );
  };

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = 'Name is required';
    if (!form.event_log_id) e.event_log_id = 'Select an event log';
    if (form.email_recipients.length === 0) e.email_recipients = 'Add at least one recipient';
    if (form.include_sections.length === 0) e.include_sections = 'Select at least one section';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validate()) onSave(form);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
          Report name <span className="text-danger">*</span>
        </label>
        <input
          className="input w-full"
          placeholder="e.g. Weekly process health report"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          autoFocus
        />
        {errors.name && <p className="mt-1 text-[11px] text-danger">{errors.name}</p>}
      </div>

      {/* Event log */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
          Event log <span className="text-danger">*</span>
        </label>
        <div className="relative">
          <select
            className="input w-full appearance-none pr-8"
            value={form.event_log_id}
            onChange={(e) => set('event_log_id', e.target.value)}
          >
            <option value="">Select event log…</option>
            {eventLogs.map((log) => (
              <option key={log.id} value={log.id}>
                {log.name}
              </option>
            ))}
          </select>
          <ChevronDown
            size={14}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint"
          />
        </div>
        {errors.event_log_id && (
          <p className="mt-1 text-[11px] text-danger">{errors.event_log_id}</p>
        )}
      </div>

      {/* Frequency + Format */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Frequency
          </label>
          <div className="relative">
            <select
              className="input w-full appearance-none pr-8"
              value={form.frequency}
              onChange={(e) => set('frequency', e.target.value as ReportFrequency)}
            >
              {(Object.keys(FREQUENCY_LABELS) as ReportFrequency[]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        </div>
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Format
          </label>
          <div className="relative">
            <select
              className="input w-full appearance-none pr-8"
              value={form.report_format}
              onChange={(e) => set('report_format', e.target.value as ReportFormat)}
            >
              {(Object.keys(FORMAT_LABELS) as ReportFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint"
            />
          </div>
        </div>
      </div>

      {/* Recipients */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
          Recipients <span className="text-danger">*</span>
        </label>
        <EmailTagInput
          value={form.email_recipients}
          onChange={(v) => set('email_recipients', v)}
        />
        {errors.email_recipients && (
          <p className="mt-1 text-[11px] text-danger">{errors.email_recipients}</p>
        )}
      </div>

      {/* Sections */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted mb-2">
          Report sections <span className="text-danger">*</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {SECTION_OPTIONS.map((s) => {
            const checked = form.include_sections.includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleSection(s.value)}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12px] font-medium transition-colors',
                  checked
                    ? 'border-accent/40 bg-accent/8 text-accent'
                    : 'border-line bg-surface-1 text-fg-muted hover:border-line-strong hover:text-fg',
                )}
              >
                <span
                  className={clsx(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] font-bold',
                    checked
                      ? 'border-accent bg-accent text-white'
                      : 'border-line bg-transparent',
                  )}
                >
                  {checked && '✓'}
                </span>
                {s.label}
              </button>
            );
          })}
        </div>
        {errors.include_sections && (
          <p className="mt-1 text-[11px] text-danger">{errors.include_sections}</p>
        )}
      </div>

      {/* Footer buttons */}
      <div className="flex justify-end gap-2 border-t border-line/60 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary"
          disabled={saving}
        >
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? <LoadingSpinner size="sm" /> : null}
          {saving ? 'Saving…' : 'Save report'}
        </button>
      </div>
    </form>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ScheduledReportsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const addNotification = useUIStore((s) => s.addNotification);

  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledReport | null>(null);
  const [saving, setSaving] = useState(false);

  // Per-row in-flight trackers
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [reps, logs] = await Promise.all([
        reportsApi.list(projectId),
        projectId ? eventLogsApi.list(projectId) : Promise.resolve([] as EventLog[]),
      ]);
      setReports(reps);
      setEventLogs(logs);
    } catch {
      setError('Failed to load scheduled reports. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (values: {
    name: string;
    event_log_id: string;
    frequency: ReportFrequency;
    report_format: ReportFormat;
    email_recipients: string[];
    include_sections: string[];
  }) => {
    if (!projectId) return;
    setSaving(true);
    try {
      const created = await reportsApi.create({
        project_id: projectId,
        ...values,
      });
      setReports((prev) => [created, ...prev]);
      setShowCreate(false);
      addNotification({ type: 'success', title: `Report "${created.name}" created` });
    } catch {
      addNotification({ type: 'error', title: 'Failed to create report' });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (values: {
    name: string;
    event_log_id: string;
    frequency: ReportFrequency;
    report_format: ReportFormat;
    email_recipients: string[];
    include_sections: string[];
  }) => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const updated = await reportsApi.update(editTarget.id, {
        name: values.name,
        frequency: values.frequency,
        email_recipients: values.email_recipients,
        include_sections: values.include_sections,
      });
      setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setEditTarget(null);
      addNotification({ type: 'success', title: `Report "${updated.name}" updated` });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update report' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (report: ScheduledReport) => {
    if (!window.confirm(`Delete "${report.name}"? This cannot be undone.`)) return;
    setDeletingId(report.id);
    try {
      await reportsApi.delete(report.id);
      setReports((prev) => prev.filter((r) => r.id !== report.id));
      addNotification({ type: 'success', title: 'Report deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete report' });
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (report: ScheduledReport) => {
    setTogglingId(report.id);
    try {
      const updated = await reportsApi.update(report.id, {
        is_active: !report.is_active,
      });
      setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      addNotification({
        type: 'success',
        title: updated.is_active
          ? `Report "${updated.name}" enabled`
          : `Report "${updated.name}" paused`,
      });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update report' });
    } finally {
      setTogglingId(null);
    }
  };

  const handleSendNow = async (report: ScheduledReport) => {
    setSendingId(report.id);
    try {
      await reportsApi.sendNow(report.id);
      addNotification({
        type: 'success',
        title: 'Report queued',
        message: `"${report.name}" will be sent to ${report.email_recipients.length} recipient${report.email_recipients.length !== 1 ? 's' : ''} shortly.`,
      });
    } catch {
      addNotification({ type: 'error', title: 'Failed to queue report' });
    } finally {
      setSendingId(null);
    }
  };

  // ─── Derived stats ──────────────────────────────────────────────────────

  const activeCount = reports.filter((r) => r.is_active).length;
  const totalSends = reports.reduce((sum, r) => sum + r.send_count, 0);

  const logName = (id: string) =>
    eventLogs.find((l) => l.id === id)?.name ?? id.slice(0, 8) + '…';

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading scheduled reports…" fullPage />;
  }

  if (error) {
    return (
      <div>
        <PageHeader
          title="Scheduled Reports"
          icon={Calendar}
          description="Automatically email process reports to your team"
        />
        <div className="mt-8 rounded-xl border border-danger/30 bg-danger/5 p-8 text-center">
          <p className="text-[13px] font-semibold text-danger">{error}</p>
          <button className="btn-secondary mt-4" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Scheduled Reports"
        icon={Calendar}
        description="Automatically email process-health reports to your team on a recurring schedule"
        actions={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            New Report
          </button>
        }
      />

      {/* Stats row */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-accent/10 p-2">
              <Calendar size={18} className="text-accent" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">{reports.length}</p>
              <p className="text-[12px] text-fg-muted">Total reports</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-success/10 p-2">
              <ToggleRight size={18} className="text-success" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">{activeCount}</p>
              <p className="text-[12px] text-fg-muted">Active</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-tint p-2">
              <Send size={18} className="text-fg-muted" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">{totalSends}</p>
              <p className="text-[12px] text-fg-muted">Total sends</p>
            </div>
          </div>
        </div>
      </div>

      {/* Empty state */}
      {reports.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-line p-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
            <Calendar size={22} />
          </div>
          <p className="mt-3 text-[14px] font-semibold text-fg">No reports scheduled</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[12px] text-fg-muted leading-relaxed">
            Create a scheduled report to automatically email process summaries, bottlenecks,
            and variant analysis to your team.
          </p>
          <button className="btn-primary mt-5" onClick={() => setShowCreate(true)}>
            <Plus size={15} />
            Create first report
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {reports.map((report) => (
            <div
              key={report.id}
              className={clsx(
                'card p-5 transition-all',
                !report.is_active && 'opacity-60',
              )}
            >
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div
                  className={clsx(
                    'mt-0.5 shrink-0 rounded-lg p-2',
                    report.is_active ? 'bg-accent/10' : 'bg-tint',
                  )}
                >
                  <FileText
                    size={18}
                    className={report.is_active ? 'text-accent' : 'text-fg-faint'}
                  />
                </div>

                {/* Main content */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-fg">{report.name}</h3>
                    <span
                      className={clsx(
                        'badge',
                        report.is_active ? 'badge-emerald' : 'badge-slate',
                      )}
                    >
                      {report.is_active ? 'Active' : 'Paused'}
                    </span>
                    <span className="badge badge-slate">
                      {FREQUENCY_LABELS[report.frequency as ReportFrequency] ?? report.frequency}
                    </span>
                    <span className="badge badge-slate">
                      {FORMAT_LABELS[report.report_format as ReportFormat] ?? report.report_format}
                    </span>
                  </div>

                  {/* Meta row */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-fg-faint">
                    <span className="flex items-center gap-1">
                      <FileText size={11} />
                      {logName(report.event_log_id)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Mail size={11} />
                      {report.email_recipients.length === 0
                        ? 'No recipients'
                        : report.email_recipients.length === 1
                        ? report.email_recipients[0]
                        : `${report.email_recipients[0]} +${report.email_recipients.length - 1} more`}
                    </span>
                    {report.last_sent_at && (
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        Last sent{' '}
                        {format(new Date(report.last_sent_at), 'MMM d, h:mm a')}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Hash size={11} />
                      {report.send_count} send{report.send_count !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Sections */}
                  {report.include_sections.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {report.include_sections.map((s) => (
                        <span
                          key={s}
                          className="rounded-md bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-fg-muted"
                        >
                          {SECTION_OPTIONS.find((o) => o.value === s)?.label ?? s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1">
                  {/* Send now */}
                  <button
                    onClick={() => handleSendNow(report)}
                    disabled={sendingId === report.id}
                    className="btn-ghost p-1.5"
                    title="Send now"
                  >
                    {sendingId === report.id ? (
                      <LoadingSpinner size="sm" />
                    ) : (
                      <Send size={14} />
                    )}
                  </button>

                  {/* Edit */}
                  <button
                    onClick={() => setEditTarget(report)}
                    className="btn-ghost p-1.5"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>

                  {/* Toggle active */}
                  <button
                    onClick={() => handleToggleActive(report)}
                    disabled={togglingId === report.id}
                    className="btn-ghost p-1.5"
                    title={report.is_active ? 'Pause report' : 'Enable report'}
                  >
                    {togglingId === report.id ? (
                      <LoadingSpinner size="sm" />
                    ) : report.is_active ? (
                      <ToggleRight size={16} className="text-success" />
                    ) : (
                      <ToggleLeft size={16} className="text-fg-faint" />
                    )}
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(report)}
                    disabled={deletingId === report.id}
                    className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
                    title="Delete report"
                  >
                    {deletingId === report.id ? (
                      <LoadingSpinner size="sm" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Scheduled Report"
        size="lg"
      >
        {showCreate && (
          <ReportForm
            eventLogs={eventLogs}
            onSave={handleCreate}
            onCancel={() => setShowCreate(false)}
            saving={saving}
          />
        )}
      </Modal>

      {/* Edit modal */}
      <Modal
        isOpen={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit Scheduled Report"
        size="lg"
      >
        {editTarget && (
          <ReportForm
            initial={{
              name: editTarget.name,
              event_log_id: editTarget.event_log_id,
              frequency: editTarget.frequency as ReportFrequency,
              report_format: editTarget.report_format as ReportFormat,
              email_recipients: editTarget.email_recipients,
              include_sections: editTarget.include_sections,
            }}
            eventLogs={eventLogs}
            onSave={handleEdit}
            onCancel={() => setEditTarget(null)}
            saving={saving}
          />
        )}
      </Modal>
    </div>
  );
}
