import { useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Target, Plus, Trash2, RefreshCw, TrendingUp, DollarSign } from 'lucide-react';
import { initiatives as initiativesApi, eventLogs as eventLogsApi } from '@/api/client';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import { useUIStore } from '@/store';

// Zod schema — validation runs on submit and on blur, with field-level
// error messages rendered inline. We keep the number fields as plain
// ``number`` (not ``coerce``) and convert in ``onSubmit`` so the output
// type matches the default-value shape exactly — otherwise TS complains
// about the resolver generic mismatch.
const initiativeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  description: z.string().max(500).optional(),
  metric: z.string().min(1),
  unit: z.string().optional(),
  baseline_value: z.number(),
  target_value: z.number(),
  value_per_unit_improvement: z.number().optional(),
  event_log_id: z.string().optional(),
});

type InitiativeFormValues = z.infer<typeof initiativeSchema>;

interface Initiative {
  id: string;
  name: string;
  description: string | null;
  metric: string;
  unit: string | null;
  baseline_value: number;
  target_value: number;
  current_value: number | null;
  realized_savings: number;
  estimated_annual_savings: number | null;
  progress: number;
  status: string;
  event_log_id: string | null;
  last_measured_at: string | null;
}

const METRIC_OPTIONS = [
  { value: 'avg_case_duration', label: 'Avg case duration (seconds)' },
  { value: 'rework_rate', label: 'Rework rate (%)' },
  { value: 'throughput', label: 'Throughput (cases)' },
  { value: 'fitness', label: 'Conformance fitness' },
  { value: 'cost_per_case', label: 'Cost per case' },
];

export interface InitiativePrefill {
  name?: string;
  description?: string;
  metric?: string;
  baseline_value?: number;
  target_value?: number;
  event_log_id?: string;
  unit?: string;
}

export default function InitiativesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const addNotification = useUIStore((s) => s.addNotification);

  const [items, setItems] = useState<Initiative[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [eventLogOptions, setEventLogOptions] = useState<{ id: string; name: string }[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InitiativeFormValues>({
    resolver: zodResolver(initiativeSchema),
    defaultValues: {
      name: '',
      description: '',
      metric: 'avg_case_duration',
      unit: 'seconds',
      baseline_value: 0,
      target_value: 0,
      value_per_unit_improvement: 0,
      event_log_id: '',
    },
  });

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        initiativesApi.list(projectId),
        initiativesApi.summary(projectId),
      ]);
      setItems(list as Initiative[]);
      setSummary(sum);
    } catch (e) {
      addNotification({ type: 'error', title: 'Failed to load initiatives' });
    } finally {
      setLoading(false);
    }
  };

  const loadEventLogs = async () => {
    if (!projectId) return;
    try {
      const logs = await eventLogsApi.list(projectId);
      setEventLogOptions(logs.map((l: any) => ({ id: l.id, name: l.name })));
    } catch {}
  };

  useEffect(() => {
    load();
    loadEventLogs();
  }, [projectId]);

  // If we were navigated here with a prefill payload (from Bottlenecks /
  // Rework / Conformance "Track as Initiative" buttons), auto-open the
  // create modal with the values applied.
  useEffect(() => {
    const prefill = (location.state as { prefill?: InitiativePrefill } | null)?.prefill;
    if (!prefill) return;
    reset({
      name: prefill.name ?? '',
      description: prefill.description ?? '',
      metric: prefill.metric ?? 'avg_case_duration',
      unit: prefill.unit ?? 'seconds',
      baseline_value: prefill.baseline_value ?? 0,
      target_value: prefill.target_value ?? 0,
      value_per_unit_improvement: 0,
      event_log_id: prefill.event_log_id ?? '',
    });
    setShowCreate(true);
    // Consume the state so a refresh doesn't re-trigger.
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const onSubmit = handleSubmit(async (values) => {
    if (!projectId) return;
    try {
      await initiativesApi.create({
        project_id: projectId,
        event_log_id: values.event_log_id || null,
        name: values.name,
        description: values.description,
        metric: values.metric,
        unit: values.unit,
        baseline_value: values.baseline_value,
        target_value: values.target_value,
        value_per_unit_improvement: values.value_per_unit_improvement || null,
      });
      addNotification({ type: 'success', title: 'Initiative created' });
      setShowCreate(false);
      reset();
      await load();
    } catch (e) {
      addNotification({ type: 'error', title: 'Failed to create initiative' });
    }
  });

  const handleMeasure = async (id: string) => {
    try {
      await initiativesApi.measure(id);
      addNotification({ type: 'success', title: 'Initiative re-measured' });
      await load();
    } catch {
      addNotification({ type: 'error', title: 'Failed to measure initiative' });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this initiative?')) return;
    try {
      await initiativesApi.delete(id);
      await load();
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete' });
    }
  };

  if (loading) return <LoadingSpinner size="lg" text="Loading initiatives..." fullPage />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="btn-ghost p-2">
            ←
          </button>
          <div className="flex items-center gap-2">
            <Target size={18} className="text-accent" />
            <div>
              <h1 className="text-lg font-semibold text-fg">Value &amp; ROI Tracker</h1>
              <p className="text-[11px] text-fg-faint">Track optimization initiatives and realized savings</p>
            </div>
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5">
          <Plus size={14} /> New Initiative
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total" value={summary.total_initiatives} />
          <StatCard label="Active" value={summary.active} />
          <StatCard label="Achieved" value={summary.achieved} />
          <StatCard
            label="Realized savings"
            value={'$' + (summary.total_realized_savings || 0).toLocaleString()}
            icon={<DollarSign size={14} className="text-success" />}
          />
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface-1 py-16 text-center">
          <Target size={28} className="mx-auto text-fg-faint" />
          <p className="mt-2 text-[13px] text-fg-muted">No initiatives yet</p>
          <p className="mt-1 text-[11px] text-fg-faint">Create one to start tracking process improvement ROI</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((i) => {
            const pct = Math.round((i.progress || 0) * 100);
            return (
              <div key={i.id} className="rounded-lg border border-line bg-surface-1 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-semibold text-fg">{i.name}</h3>
                      <span
                        className={`badge ${
                          i.status === 'achieved'
                            ? 'badge-emerald'
                            : i.status === 'active'
                            ? 'badge-accent'
                            : 'badge-slate'
                        }`}
                      >
                        {i.status}
                      </span>
                    </div>
                    {i.description && <p className="mt-0.5 text-[11px] text-fg-muted">{i.description}</p>}
                    <div className="mt-3 flex items-center gap-6 text-[11px] text-fg-faint">
                      <span>Metric: {i.metric}</span>
                      <span>
                        Baseline: <span className="text-fg-secondary">{i.baseline_value.toFixed(1)} {i.unit}</span>
                      </span>
                      <span>
                        Target: <span className="text-fg-secondary">{i.target_value.toFixed(1)} {i.unit}</span>
                      </span>
                      {i.current_value !== null && (
                        <span>
                          Current: <span className="text-fg">{i.current_value.toFixed(1)} {i.unit}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-tint">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-fg-faint">
                      <span>{pct}% to target</span>
                      {i.realized_savings > 0 && (
                        <span className="flex items-center gap-1 text-success">
                          <TrendingUp size={10} /> ${i.realized_savings.toLocaleString()} realized
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {i.event_log_id && (
                      <button
                        onClick={() => handleMeasure(i.id)}
                        title="Re-measure from event log"
                        className="btn-ghost p-1.5"
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                    <button onClick={() => handleDelete(i.id)} title="Delete" className="btn-ghost p-1.5 text-danger">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="Create initiative">
        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <Field label="Name" error={errors.name?.message}>
            <input className="input w-full" {...register('name')} />
          </Field>
          <Field label="Description" error={errors.description?.message}>
            <input className="input w-full" {...register('description')} />
          </Field>
          <Field label="Metric" error={errors.metric?.message}>
            <select className="input w-full" {...register('metric')}>
              {METRIC_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked event log (for re-measurement)">
            <select className="input w-full" {...register('event_log_id')}>
              <option value="">— None —</option>
              {eventLogOptions.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Baseline value" error={errors.baseline_value?.message}>
              <input type="number" step="any" className="input w-full" {...register('baseline_value', { valueAsNumber: true })} />
            </Field>
            <Field label="Target value" error={errors.target_value?.message}>
              <input type="number" step="any" className="input w-full" {...register('target_value', { valueAsNumber: true })} />
            </Field>
          </div>
          <Field label="$ per unit improvement (optional)">
            <input type="number" step="any" className="input w-full" {...register('value_per_unit_improvement', { valueAsNumber: true })} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: any; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">{label}</p>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-fg-muted">{label}</label>
      {children}
      {error && <p className="mt-1 text-[10px] text-danger">{error}</p>}
    </div>
  );
}
