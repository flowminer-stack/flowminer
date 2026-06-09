import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Plus,
  Target,
  RefreshCw,
  Trash2,
  Pencil,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Play,
} from 'lucide-react';
import clsx from 'clsx';
import { format } from 'date-fns';
import { customKpis as kpisApi } from '@/api/customKpis';
import type { CustomKpi, KpiCreate, KpiUpdate, KpiStatus, KpiMetric } from '@/types/customKpi';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import EmptyState from '@/components/common/EmptyState';
import PageHeader from '@/components/common/PageHeader';
import ProjectSubnav from '@/components/Project/ProjectSubnav';
import Modal from '@/components/common/Modal';
import FeatureGuide from '@/components/common/FeatureGuide';
import { useUIStore, useProjectsStore, useEventLogsStore } from '@/store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<KpiMetric, string> = {
  avg_case_duration: 'Avg Case Duration',
  case_count: 'Case Count',
  event_count: 'Event Count',
  activity_count: 'Activity Count',
  rework_rate: 'Rework Rate',
  variant_count: 'Variant Count',
  conformance_fitness: 'Conformance Fitness',
  bottleneck_count: 'Bottleneck Count',
  median_case_duration: 'Median Case Duration',
  custom_expression: 'Custom Expression',
};

const METRIC_OPTIONS: KpiMetric[] = [
  'avg_case_duration',
  'case_count',
  'event_count',
  'activity_count',
  'rework_rate',
  'variant_count',
  'conformance_fitness',
  'bottleneck_count',
  'median_case_duration',
  'custom_expression',
];

// Plain-English meaning of each metric, surfaced as helper text under the
// metric selector so users understand what they're tracking and which way is
// "good". `higherIsBetter` is undefined for metrics with no inherent direction.
const METRIC_META: Record<
  KpiMetric,
  { description: string; unit?: string; higherIsBetter?: boolean }
> = {
  avg_case_duration: {
    description: 'Mean time from the first to the last event in a case.',
    unit: 's',
    higherIsBetter: false,
  },
  case_count: {
    description: 'Number of cases in the log (throughput).',
    higherIsBetter: true,
  },
  event_count: {
    description: 'Total number of events recorded across all cases.',
  },
  activity_count: {
    description: 'Number of distinct activities — a process-complexity indicator.',
    higherIsBetter: false,
  },
  rework_rate: {
    description: 'Share of cases that repeat at least one activity.',
    unit: '%',
    higherIsBetter: false,
  },
  variant_count: {
    description: 'Number of distinct paths through the process — a complexity indicator.',
    higherIsBetter: false,
  },
  conformance_fitness: {
    description: 'How well cases fit the reference model (replay fitness).',
    unit: '%',
    higherIsBetter: true,
  },
  bottleneck_count: {
    description: 'Number of detected bottlenecks — a complexity / friction indicator.',
    higherIsBetter: false,
  },
  median_case_duration: {
    description: 'Median case duration — like the average, but robust to outliers.',
    unit: 's',
    higherIsBetter: false,
  },
  custom_expression: {
    description: 'Your own arithmetic formula or filter over the base metrics.',
  },
};

// Ready-made KPIs shown as chips at the top of the create modal. Clicking one
// prefills name / metric / unit / description; thresholds are left blank so the
// user sets the bands that matter to them.
interface KpiTemplate {
  label: string;
  name: string;
  metric: KpiMetric;
  unit: string;
  description: string;
}

const KPI_TEMPLATES: KpiTemplate[] = [
  {
    label: 'Average cycle time',
    name: 'Average cycle time',
    metric: 'avg_case_duration',
    unit: 's',
    description: METRIC_META.avg_case_duration.description,
  },
  {
    label: 'Median cycle time',
    name: 'Median cycle time',
    metric: 'median_case_duration',
    unit: 's',
    description: METRIC_META.median_case_duration.description,
  },
  {
    label: 'Throughput',
    name: 'Throughput',
    metric: 'case_count',
    unit: 'cases',
    description: METRIC_META.case_count.description,
  },
  {
    label: 'Rework rate',
    name: 'Rework rate',
    metric: 'rework_rate',
    unit: '%',
    description: METRIC_META.rework_rate.description,
  },
  {
    label: 'Conformance fitness',
    name: 'Conformance fitness',
    metric: 'conformance_fitness',
    unit: '%',
    description: METRIC_META.conformance_fitness.description,
  },
  {
    label: 'Process variants',
    name: 'Process variants',
    metric: 'variant_count',
    unit: '',
    description: METRIC_META.variant_count.description,
  },
  {
    label: 'Bottlenecks',
    name: 'Bottlenecks',
    metric: 'bottleneck_count',
    unit: '',
    description: METRIC_META.bottleneck_count.description,
  },
  {
    label: 'Custom …',
    name: '',
    metric: 'custom_expression',
    unit: '',
    description: METRIC_META.custom_expression.description,
  },
];

function deriveStatus(kpi: CustomKpi): KpiStatus {
  if (kpi.last_value === null) return 'ok';
  const v = kpi.last_value;
  if (kpi.critical_threshold !== null && v >= kpi.critical_threshold) return 'critical';
  if (kpi.warning_threshold !== null && v >= kpi.warning_threshold) return 'warning';
  return 'ok';
}

function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return '—';
  const formatted =
    Math.abs(value) >= 1_000_000
      ? `${(value / 1_000_000).toFixed(2)}M`
      : Math.abs(value) >= 1_000
        ? `${(value / 1_000).toFixed(1)}k`
        : value % 1 === 0
          ? value.toString()
          : value.toFixed(3);
  return unit ? `${formatted} ${unit}` : formatted;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  status: KpiStatus;
  hasValue: boolean;
}

function StatusBadge({ status, hasValue }: StatusBadgeProps) {
  if (!hasValue) {
    return (
      <span className="badge badge-slate flex items-center gap-1">
        <Clock size={10} />
        Not computed
      </span>
    );
  }
  if (status === 'critical') {
    return (
      <span className="badge badge-rose flex items-center gap-1">
        <XCircle size={10} />
        Critical
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span className="badge badge-amber flex items-center gap-1">
        <AlertTriangle size={10} />
        Warning
      </span>
    );
  }
  return (
    <span className="badge badge-emerald flex items-center gap-1">
      <CheckCircle2 size={10} />
      OK
    </span>
  );
}

// ─── Gauge bar ────────────────────────────────────────────────────────────────

interface GaugeBarProps {
  kpi: CustomKpi;
  status: KpiStatus;
}

function GaugeBar({ kpi, status }: GaugeBarProps) {
  if (kpi.last_value === null || kpi.target_value === null) return null;

  const pct = Math.min(100, Math.max(0, (kpi.last_value / kpi.target_value) * 100));

  const barColor =
    status === 'critical'
      ? 'bg-danger'
      : status === 'warning'
        ? 'bg-warning'
        : 'bg-success';

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-fg-faint">
        <span>0</span>
        <span>Target: {formatValue(kpi.target_value, kpi.unit)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={clsx('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {kpi.warning_threshold !== null && (
        <div
          className="absolute top-0 h-full w-px bg-warning/60"
          style={{ left: `${Math.min(100, (kpi.warning_threshold / kpi.target_value) * 100)}%` }}
        />
      )}
    </div>
  );
}

// ─── KPI card ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  kpi: CustomKpi;
  eventLogId: string | null;
  onComputed: (updated: CustomKpi) => void;
  onEdit: (kpi: CustomKpi) => void;
  onDelete: (kpi: CustomKpi) => void;
}

function KpiCard({ kpi, eventLogId, onComputed, onEdit, onDelete }: KpiCardProps) {
  const addNotification = useUIStore((s) => s.addNotification);
  const [computing, setComputing] = useState(false);
  const status = deriveStatus(kpi);

  const handleCompute = async () => {
    if (!eventLogId) {
      addNotification({
        type: 'error',
        title: 'Select an event log first',
        message: 'Choose an event log from the selector at the top of the page.',
      });
      return;
    }
    setComputing(true);
    try {
      const result = await kpisApi.compute(kpi.id, eventLogId);
      // Merge the result back into a CustomKpi shape so the parent can refresh state
      onComputed({
        ...kpi,
        last_value: result.value,
        last_computed_at: new Date().toISOString(),
      });
      addNotification({
        type: result.status === 'critical' ? 'error' : result.status === 'warning' ? 'warning' : 'success',
        title: `${kpi.name}: ${formatValue(result.value, result.unit)}`,
        message:
          result.expression_warnings.length > 0
            ? `Warnings: ${result.expression_warnings.join('; ')}`
            : undefined,
      });
    } catch {
      addNotification({ type: 'error', title: `Failed to compute "${kpi.name}"` });
    } finally {
      setComputing(false);
    }
  };

  const statusBorderColor =
    status === 'critical'
      ? 'border-l-danger'
      : status === 'warning'
        ? 'border-l-warning'
        : kpi.last_value !== null
          ? 'border-l-success'
          : 'border-l-line';

  return (
    <div
      className={clsx(
        'card border-l-[3px] p-5 transition-all',
        statusBorderColor,
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[13px] font-semibold text-fg truncate">{kpi.name}</h3>
            <StatusBadge status={status} hasValue={kpi.last_value !== null} />
          </div>
          {kpi.description && (
            <p className="mt-0.5 text-[11px] text-fg-faint line-clamp-1">{kpi.description}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleCompute}
            disabled={computing}
            title="Compute KPI"
            className="btn-ghost p-1.5 text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            {computing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
          </button>
          <button
            onClick={() => onEdit(kpi)}
            title="Edit KPI"
            className="btn-ghost p-1.5"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(kpi)}
            title="Delete KPI"
            className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Value display */}
      <div className="mt-3 flex items-end gap-3">
        <div>
          <p className="text-[11px] text-fg-faint">Current value</p>
          <p
            className={clsx(
              'text-2xl font-bold tabular-nums',
              status === 'critical'
                ? 'text-danger'
                : status === 'warning'
                  ? 'text-warning'
                  : kpi.last_value !== null
                    ? 'text-success'
                    : 'text-fg-muted',
            )}
          >
            {kpi.last_value !== null ? formatValue(kpi.last_value, kpi.unit) : '—'}
          </p>
        </div>
        {kpi.target_value !== null && (
          <div className="mb-1">
            <p className="text-[11px] text-fg-faint">Target</p>
            <p className="text-[13px] font-medium text-fg-muted">
              {formatValue(kpi.target_value, kpi.unit)}
            </p>
          </div>
        )}
      </div>

      {/* Gauge */}
      <div className="relative">
        <GaugeBar kpi={kpi} status={status} />
      </div>

      {/* Footer meta */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-faint">
        <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono">
          {METRIC_LABELS[kpi.metric]}
        </span>
        {kpi.warning_threshold !== null && (
          <span>
            Warn ≥ {formatValue(kpi.warning_threshold, kpi.unit)}
          </span>
        )}
        {kpi.critical_threshold !== null && (
          <span>
            Crit ≥ {formatValue(kpi.critical_threshold, kpi.unit)}
          </span>
        )}
        {kpi.last_computed_at && (
          <span className="ml-auto flex items-center gap-1">
            <Clock size={10} />
            {format(new Date(kpi.last_computed_at), 'MMM d, h:mm a')}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Create / Edit modal form ─────────────────────────────────────────────────

interface KpiFormData {
  name: string;
  description: string;
  metric: KpiMetric;
  expression: string;
  unit: string;
  target_value: string;
  warning_threshold: string;
  critical_threshold: string;
}

const EMPTY_FORM: KpiFormData = {
  name: '',
  description: '',
  metric: 'case_count',
  expression: '',
  unit: '',
  target_value: '',
  warning_threshold: '',
  critical_threshold: '',
};

function kpiToForm(kpi: CustomKpi): KpiFormData {
  return {
    name: kpi.name,
    description: kpi.description ?? '',
    metric: kpi.metric,
    expression: kpi.expression ?? '',
    unit: kpi.unit ?? '',
    target_value: kpi.target_value !== null ? String(kpi.target_value) : '',
    warning_threshold:
      kpi.warning_threshold !== null ? String(kpi.warning_threshold) : '',
    critical_threshold:
      kpi.critical_threshold !== null ? String(kpi.critical_threshold) : '',
  };
}

interface KpiFormProps {
  form: KpiFormData;
  onChange: (f: KpiFormData) => void;
  mode: 'create' | 'edit';
}

function KpiForm({ form, onChange, mode }: KpiFormProps) {
  const set = (key: keyof KpiFormData, val: string) =>
    onChange({ ...form, [key]: val });

  const showExpression =
    form.metric === 'custom_expression' || form.expression.trim() !== '';

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted">
          Name <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g., Weekly Rework Rate"
          className="input mt-1.5"
          autoFocus
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted">
          Description{' '}
          <span className="font-normal text-fg-faint">(optional)</span>
        </label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="What does this KPI measure?"
          rows={2}
          className="input mt-1.5 resize-none"
        />
      </div>

      {/* Metric */}
      {mode === 'create' && (
        <div>
          <label className="block text-[12px] font-medium text-fg-muted">
            Metric <span className="text-danger">*</span>
          </label>
          <select
            value={form.metric}
            onChange={(e) => set('metric', e.target.value as KpiMetric)}
            className="select mt-1.5"
          >
            {METRIC_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABELS[m]}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            {METRIC_META[form.metric].description}
            {METRIC_META[form.metric].higherIsBetter !== undefined && (
              <span
                className={clsx(
                  'ml-1 font-medium',
                  METRIC_META[form.metric].higherIsBetter
                    ? 'text-success'
                    : 'text-warning',
                )}
              >
                {METRIC_META[form.metric].higherIsBetter
                  ? '· higher is better'
                  : '· higher is worse'}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Expression (shown when metric = custom_expression OR if there is already an expression) */}
      {showExpression && (
        <div>
          <label className="block text-[12px] font-medium text-fg-muted">
            Expression
          </label>
          <textarea
            value={form.expression}
            onChange={(e) => set('expression', e.target.value)}
            placeholder={
              'Arithmetic formula over base metrics, e.g.\n  rework_rate * case_count\nor filter DSL, e.g.\n  case.duration > 7d'
            }
            rows={3}
            className="input mt-1.5 resize-none font-mono text-[12px]"
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            Available scalars: avg_case_duration, case_count, event_count,
            activity_count, rework_rate, variant_count, conformance_fitness,
            bottleneck_count, median_case_duration
          </p>
        </div>
      )}

      {/* Unit */}
      <div>
        <label className="block text-[12px] font-medium text-fg-muted">
          Unit{' '}
          <span className="font-normal text-fg-faint">(optional — e.g. %, s, €)</span>
        </label>
        <input
          type="text"
          value={form.unit}
          onChange={(e) => set('unit', e.target.value)}
          placeholder="s"
          className="input mt-1.5 w-32"
        />
      </div>

      {/* Thresholds row */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-fg-muted">
            Target
          </label>
          <input
            type="number"
            value={form.target_value}
            onChange={(e) => set('target_value', e.target.value)}
            placeholder="—"
            className="input mt-1.5"
            step="any"
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-fg-muted flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-warning" />
            Warning ≥
          </label>
          <input
            type="number"
            value={form.warning_threshold}
            onChange={(e) => set('warning_threshold', e.target.value)}
            placeholder="—"
            className="input mt-1.5"
            step="any"
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-fg-muted flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-danger" />
            Critical ≥
          </label>
          <input
            type="number"
            value={form.critical_threshold}
            onChange={(e) => set('critical_threshold', e.target.value)}
            placeholder="—"
            className="input mt-1.5"
            step="any"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Summary strip ────────────────────────────────────────────────────────────

interface SummaryStripProps {
  kpis: CustomKpi[];
}

function SummaryStrip({ kpis }: SummaryStripProps) {
  const computed = kpis.filter((k) => k.last_value !== null);
  const critical = computed.filter((k) => deriveStatus(k) === 'critical').length;
  const warning = computed.filter((k) => deriveStatus(k) === 'warning').length;
  const ok = computed.filter((k) => deriveStatus(k) === 'ok').length;

  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-accent/10 p-2">
            <Target size={18} className="text-accent" />
          </div>
          <div>
            <p className="text-xl font-bold tabular-nums text-fg">{kpis.length}</p>
            <p className="text-[11px] text-fg-muted">Total KPIs</p>
          </div>
        </div>
      </div>
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-success/10 p-2">
            <CheckCircle2 size={18} className="text-success" />
          </div>
          <div>
            <p className="text-xl font-bold tabular-nums text-fg">{ok}</p>
            <p className="text-[11px] text-fg-muted">On target</p>
          </div>
        </div>
      </div>
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-warning/10 p-2">
            <AlertTriangle size={18} className="text-warning" />
          </div>
          <div>
            <p className="text-xl font-bold tabular-nums text-fg">{warning}</p>
            <p className="text-[11px] text-fg-muted">Warning</p>
          </div>
        </div>
      </div>
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-danger/10 p-2">
            <XCircle size={18} className="text-danger" />
          </div>
          <div>
            <p className="text-xl font-bold tabular-nums text-fg">{critical}</p>
            <p className="text-[11px] text-fg-muted">Critical</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function KpisPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const addNotification = useUIStore((s) => s.addNotification);
  const { projects, fetchProjects } = useProjectsStore();
  const { eventLogs, fetchEventLogs } = useEventLogsStore();

  // If no projectId in params (standalone route), allow picking from a selector
  const [activeProjectId, setActiveProjectId] = useState<string>(projectId ?? '');
  const [kpis, setKpis] = useState<CustomKpi[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string>('');

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<KpiFormData>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  // Edit modal state
  const [editKpi, setEditKpi] = useState<CustomKpi | null>(null);
  const [editForm, setEditForm] = useState<KpiFormData>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);

  // Sort / filter
  const [sortKey, setSortKey] = useState<'name' | 'status' | 'created_at'>('created_at');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterStatus, setFilterStatus] = useState<KpiStatus | 'all'>('all');

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // On first load, default to the project the user was just working in
  // (same context rule as the Benchmark/Initiatives auto-continue), falling
  // back to the first project, if none was provided via route.
  useEffect(() => {
    if (!activeProjectId && projects.length > 0) {
      const last = useUIStore.getState().lastProjectId;
      setActiveProjectId(projects.find((p) => p.id === last)?.id ?? projects[0].id);
    }
  }, [projects, activeProjectId]);

  const loadKpis = useCallback(async () => {
    if (!activeProjectId) return;
    setLoading(true);
    try {
      const list = await kpisApi.list(activeProjectId);
      setKpis(list);
    } catch {
      addNotification({ type: 'error', title: 'Failed to load KPIs' });
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, addNotification]);

  useEffect(() => {
    if (activeProjectId) {
      loadKpis();
      fetchEventLogs(activeProjectId);
    }
  }, [activeProjectId, loadKpis, fetchEventLogs]);

  // Reset log selection when project changes
  useEffect(() => {
    setSelectedLogId('');
  }, [activeProjectId]);

  // ── CRUD handlers ─────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!createForm.name.trim() || !activeProjectId) return;
    setCreating(true);
    try {
      const payload: KpiCreate = {
        project_id: activeProjectId,
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        metric: createForm.metric,
        expression: createForm.expression.trim() || undefined,
        unit: createForm.unit.trim() || undefined,
        target_value: createForm.target_value !== '' ? Number(createForm.target_value) : undefined,
        warning_threshold:
          createForm.warning_threshold !== '' ? Number(createForm.warning_threshold) : undefined,
        critical_threshold:
          createForm.critical_threshold !== '' ? Number(createForm.critical_threshold) : undefined,
      };
      const created = await kpisApi.create(payload);
      setKpis((prev) => [...prev, created]);
      setCreateOpen(false);
      setCreateForm(EMPTY_FORM);
      addNotification({ type: 'success', title: `KPI "${created.name}" created` });
    } catch {
      addNotification({ type: 'error', title: 'Failed to create KPI' });
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (kpi: CustomKpi) => {
    setEditKpi(kpi);
    setEditForm(kpiToForm(kpi));
  };

  const handleEdit = async () => {
    if (!editKpi || !editForm.name.trim()) return;
    setEditing(true);
    try {
      const payload: KpiUpdate = {
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        unit: editForm.unit.trim() || undefined,
        target_value:
          editForm.target_value !== '' ? Number(editForm.target_value) : undefined,
        warning_threshold:
          editForm.warning_threshold !== '' ? Number(editForm.warning_threshold) : undefined,
        critical_threshold:
          editForm.critical_threshold !== '' ? Number(editForm.critical_threshold) : undefined,
      };
      const updated = await kpisApi.update(editKpi.id, payload);
      setKpis((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
      setEditKpi(null);
      addNotification({ type: 'success', title: `KPI "${updated.name}" updated` });
    } catch {
      addNotification({ type: 'error', title: 'Failed to update KPI' });
    } finally {
      setEditing(false);
    }
  };

  const handleDelete = async (kpi: CustomKpi) => {
    if (!window.confirm(`Delete KPI "${kpi.name}"?`)) return;
    try {
      await kpisApi.delete(kpi.id);
      setKpis((prev) => prev.filter((k) => k.id !== kpi.id));
      addNotification({ type: 'success', title: 'KPI deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete KPI' });
    }
  };

  const handleComputed = (updated: CustomKpi) => {
    setKpis((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
  };

  // ── Sort + filter ─────────────────────────────────────────────────────────

  const cycleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const STATUS_ORDER: Record<KpiStatus, number> = { critical: 0, warning: 1, ok: 2 };

  const displayed = [...kpis]
    .filter((k) => {
      if (filterStatus === 'all') return true;
      return deriveStatus(k) === filterStatus;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'status') {
        const sa = a.last_value !== null ? deriveStatus(a) : 'ok';
        const sb = b.last_value !== null ? deriveStatus(b) : 'ok';
        cmp = STATUS_ORDER[sa] - STATUS_ORDER[sb];
      } else {
        cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '');
      }
      return sortAsc ? cmp : -cmp;
    });

  const SortIcon = ({ col }: { col: typeof sortKey }) =>
    sortKey === col ? (
      sortAsc ? (
        <ChevronUp size={12} />
      ) : (
        <ChevronDown size={12} />
      )
    ) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  const currentProject = projects.find((p) => p.id === activeProjectId);

  return (
    <div>
      <PageHeader
        title="Custom KPIs"
        icon={Target}
        description="Define, track, and compute custom process performance indicators against your event logs."
        actions={
          <button
            onClick={() => setCreateOpen(true)}
            disabled={!activeProjectId}
            className="btn-primary"
          >
            <Plus size={16} />
            New KPI
          </button>
        }
      />

      {/* Show the project subnav whenever a project is active — whether it came
          from the URL (/kpis/:id) or was picked via the selector on /kpis. */}
      {activeProjectId && <ProjectSubnav projectId={activeProjectId} active="kpis" />}

      <FeatureGuide
        storageKey="kpis"
        icon={Target}
        title="Track the metrics that matter"
        lead="A custom KPI watches one number over your mined process (cycle time, throughput, rework, conformance) with a target plus warning/critical thresholds, so you see at a glance when a process drifts off target."
        steps={[
          {
            label: 'Pick a metric or template',
            detail: 'Start from a ready-made KPI or choose a base metric.',
          },
          {
            label: 'Set a target and thresholds',
            detail: 'Warning and critical fire when the value crosses them.',
          },
          {
            label: 'Compute',
            detail: 'Run it to see the live value and its status badge.',
          },
        ]}
      />

      {/* Project + event log selectors */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!projectId && (
          <div className="flex items-center gap-2">
            <label className="text-[12px] font-medium text-fg-muted">Project</label>
            <select
              value={activeProjectId}
              onChange={(e) => setActiveProjectId(e.target.value)}
              className="select"
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {activeProjectId && (
          <div className="flex items-center gap-2">
            <label className="text-[12px] font-medium text-fg-muted">
              Event log for compute
            </label>
            <select
              value={selectedLogId}
              onChange={(e) => setSelectedLogId(e.target.value)}
              className="select"
            >
              <option value="">Select event log…</option>
              {eventLogs.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          onClick={loadKpis}
          disabled={!activeProjectId || loading}
          className="btn-secondary ml-auto"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary strip */}
      {activeProjectId && kpis.length > 0 && <SummaryStrip kpis={kpis} />}

      {/* Toolbar */}
      {activeProjectId && kpis.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-fg-muted">Filter:</span>
          {(['all', 'ok', 'warning', 'critical'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={clsx(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                filterStatus === s
                  ? 'bg-accent text-white'
                  : 'bg-surface-3 text-fg-muted hover:bg-tint',
              )}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}

          <span className="ml-4 text-[12px] text-fg-muted">Sort:</span>
          {(['name', 'status', 'created_at'] as const).map((col) => (
            <button
              key={col}
              onClick={() => cycleSort(col)}
              className={clsx(
                'flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                sortKey === col
                  ? 'bg-accent/15 text-accent'
                  : 'bg-surface-3 text-fg-muted hover:bg-tint',
              )}
            >
              {col === 'created_at' ? 'Date' : col.charAt(0).toUpperCase() + col.slice(1)}
              <SortIcon col={col} />
            </button>
          ))}

          <span className="ml-auto text-[11px] text-fg-faint">
            {displayed.length} of {kpis.length} KPIs
          </span>
        </div>
      )}

      {/* Body */}
      {!activeProjectId ? (
        <div className="mt-12">
          <EmptyState
            icon={Target}
            title="No project selected"
            description="Select a project above to view its KPIs."
          />
        </div>
      ) : loading ? (
        <LoadingSpinner size="lg" text="Loading KPIs…" fullPage />
      ) : kpis.length === 0 ? (
        <div className="mt-10">
          <EmptyState
            icon={Target}
            title="No KPIs yet"
            description={
              <>
                Define custom KPIs for{' '}
                <span className="font-medium text-fg">{currentProject?.name ?? 'this project'}</span>.
                Recipes can also create KPIs automatically — check the{' '}
                <span className="font-medium text-fg">Templates</span> page.
              </>
            }
            action={
              <button onClick={() => setCreateOpen(true)} className="btn-primary">
                <Plus size={15} />
                Create First KPI
              </button>
            }
          />
        </div>
      ) : displayed.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={Target}
            title="No KPIs match this filter"
            description="Try a different status filter."
            compact
          />
        </div>
      ) : (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {displayed.map((kpi) => (
            <KpiCard
              key={kpi.id}
              kpi={kpi}
              eventLogId={selectedLogId || null}
              onComputed={handleComputed}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* ── Create Modal ─────────────────────────────────────────────────── */}
      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateForm(EMPTY_FORM);
        }}
        title="Create KPI"
        size="lg"
        footer={
          <>
            <button
              onClick={() => {
                setCreateOpen(false);
                setCreateForm(EMPTY_FORM);
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !createForm.name.trim()}
              className="btn-primary"
            >
              {creating ? 'Creating…' : 'Create KPI'}
            </button>
          </>
        }
      >
        {/* Start-from-a-template chips — prefill name/metric/unit/description,
            leaving thresholds for the user. Create-only. */}
        <div className="mb-5">
          <p className="text-[12px] font-medium text-fg-muted">Start from a template</p>
          <p className="mt-0.5 text-[11px] text-fg-faint">
            Pick one to prefill the fields, then set your own thresholds.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {KPI_TEMPLATES.map((tpl) => {
              const active =
                createForm.metric === tpl.metric &&
                createForm.name === tpl.name &&
                createForm.unit === tpl.unit;
              return (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() =>
                    setCreateForm((f) => ({
                      ...f,
                      name: tpl.name,
                      metric: tpl.metric,
                      unit: tpl.unit,
                      description: tpl.description,
                    }))
                  }
                  className={clsx(
                    'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                    active
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line bg-surface-2 text-fg-muted hover:border-accent/40 hover:bg-tint hover:text-fg',
                  )}
                >
                  {tpl.label}
                </button>
              );
            })}
          </div>
        </div>

        <KpiForm form={createForm} onChange={setCreateForm} mode="create" />
      </Modal>

      {/* ── Edit Modal ───────────────────────────────────────────────────── */}
      <Modal
        isOpen={editKpi !== null}
        onClose={() => setEditKpi(null)}
        title={`Edit — ${editKpi?.name ?? ''}`}
        size="lg"
        footer={
          <>
            <button onClick={() => setEditKpi(null)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleEdit}
              disabled={editing || !editForm.name.trim()}
              className="btn-primary"
            >
              {editing ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
      >
        {/* Edit only exposes fields allowed by KPIUpdate on the backend */}
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">Name</label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              className="input mt-1.5"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Description{' '}
              <span className="font-normal text-fg-faint">(optional)</span>
            </label>
            <textarea
              value={editForm.description}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, description: e.target.value }))
              }
              rows={2}
              className="input mt-1.5 resize-none"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted">
              Unit{' '}
              <span className="font-normal text-fg-faint">(optional)</span>
            </label>
            <input
              type="text"
              value={editForm.unit}
              onChange={(e) => setEditForm((f) => ({ ...f, unit: e.target.value }))}
              placeholder="s"
              className="input mt-1.5 w-32"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-fg-muted">
                Target
              </label>
              <input
                type="number"
                value={editForm.target_value}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, target_value: e.target.value }))
                }
                placeholder="—"
                className="input mt-1.5"
                step="any"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-fg-muted flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                Warning ≥
              </label>
              <input
                type="number"
                value={editForm.warning_threshold}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, warning_threshold: e.target.value }))
                }
                placeholder="—"
                className="input mt-1.5"
                step="any"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-fg-muted flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-danger" />
                Critical ≥
              </label>
              <input
                type="number"
                value={editForm.critical_threshold}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, critical_threshold: e.target.value }))
                }
                placeholder="—"
                className="input mt-1.5"
                step="any"
              />
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface-1 px-4 py-3 text-[11px] text-fg-faint">
            Metric (<span className="font-mono">{METRIC_LABELS[editKpi?.metric ?? 'case_count']}</span>)
            and expression cannot be changed after creation.
          </div>
        </div>
      </Modal>
    </div>
  );
}
