import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Zap,
  Trash2,
  Play,
  Power,
  PowerOff,
  Clock,
  Pencil,
  History,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Save,
  AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { actionRules as actionRulesApi } from '@/api/actionRules';
import { eventLogs as eventLogsApi } from '@/api/client';
import type { EventLog } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import { useUIStore, useProjectsStore } from '@/store';
import { formatRelativeTime } from '@/utils/format';

// ─── Domain constants ─────────────────────────────────────────────────────────
// Mirror the backend action_engine: condition metrics/operators and the action
// types in scope (create_task | notify_in_app | notify_webhook | escalate |
// tag_case).

interface ActionRule {
  id: string;
  project_id: string;
  event_log_id: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  condition: Record<string, any>;
  action: Record<string, any>;
  cooldown_seconds: number;
  trigger_count: number;
  last_triggered_at: string | null;
  created_at: string;
}

interface RuleExecution {
  id: string;
  case_id: string;
  triggered_at: string | null;
  success: boolean;
  details: Record<string, any> | null;
}

const METRICS = [
  { value: 'case_duration', label: 'Case duration', unit: 'seconds' },
  { value: 'time_on_activity', label: 'Time on current activity', unit: 'seconds' },
  { value: 'event_count', label: 'Event count', unit: 'events' },
  { value: 'rework_count', label: 'Rework count', unit: 'repeats' },
  { value: 'current_activity', label: 'Current activity', unit: '' },
] as const;

const OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
] as const;

const ACTION_TYPES = [
  { value: 'create_task', label: 'Create task' },
  { value: 'notify_in_app', label: 'Notify in-app' },
  { value: 'notify_webhook', label: 'Notify webhook' },
  { value: 'escalate', label: 'Escalate' },
  { value: 'tag_case', label: 'Tag case' },
] as const;

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const metricLabel = (m: string) => METRICS.find((x) => x.value === m)?.label ?? m;
const operatorLabel = (o: string) => OPERATORS.find((x) => x.value === o)?.label ?? o;
const actionLabel = (a: string) => ACTION_TYPES.find((x) => x.value === a)?.label ?? a;

function conditionSummary(c: Record<string, any>): string {
  if (!c || !c.metric) return 'No condition';
  const metric = metricLabel(c.metric);
  const op = operatorLabel(c.operator ?? 'gt');
  const value = c.value ?? '';
  let summary = `${metric} ${op} ${value}`;
  if (c.current_activity) summary += ` (on "${c.current_activity}")`;
  return summary;
}

// ─── Rule form ────────────────────────────────────────────────────────────────

interface RuleFormState {
  name: string;
  description: string;
  eventLogId: string;
  metric: string;
  operator: string;
  value: string;
  currentActivity: string;
  actionType: string;
  cooldownSeconds: number;
  enabled: boolean;
  // action params (per type)
  taskTitle: string;
  assignee: string;
  priority: string;
  webhookUrl: string;
  escalateLevel: string;
  tag: string;
}

function emptyForm(): RuleFormState {
  return {
    name: '',
    description: '',
    eventLogId: '',
    metric: 'case_duration',
    operator: 'gt',
    value: '',
    currentActivity: '',
    actionType: 'create_task',
    cooldownSeconds: 3600,
    enabled: true,
    taskTitle: '',
    assignee: '',
    priority: 'medium',
    webhookUrl: '',
    escalateLevel: 'manager',
    tag: 'flagged',
  };
}

function formFromRule(r: ActionRule): RuleFormState {
  const c = r.condition || {};
  const a = r.action || {};
  const p = a.params || {};
  return {
    name: r.name,
    description: r.description ?? '',
    eventLogId: r.event_log_id ?? '',
    metric: c.metric ?? 'case_duration',
    operator: c.operator ?? 'gt',
    value: c.value != null ? String(c.value) : '',
    currentActivity: c.current_activity ?? '',
    actionType: a.type ?? 'create_task',
    cooldownSeconds: r.cooldown_seconds ?? 3600,
    enabled: r.enabled,
    taskTitle: p.title ?? '',
    assignee: p.assignee ?? '',
    priority: p.priority ?? 'medium',
    webhookUrl: p.url ?? '',
    escalateLevel: p.level ?? 'manager',
    tag: p.tag ?? 'flagged',
  };
}

interface RuleFormProps {
  initial?: ActionRule;
  eventLogs: EventLog[];
  saving: boolean;
  onSave: (body: any) => void;
  onCancel: () => void;
}

function RuleForm({ initial, eventLogs, saving, onSave, onCancel }: RuleFormProps) {
  const [f, setF] = useState<RuleFormState>(() =>
    initial ? formFromRule(initial) : emptyForm(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof RuleFormState>(key: K, val: RuleFormState[K]) =>
    setF((prev) => ({ ...prev, [key]: val }));

  const isActivityMetric = f.metric === 'current_activity';

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Name is required';
    if (!f.eventLogId) e.eventLogId = 'An event log is required to evaluate the rule';
    if (!String(f.value).trim()) e.value = 'A comparison value is required';
    if (f.actionType === 'notify_webhook' && !f.webhookUrl.trim())
      e.webhookUrl = 'Webhook URL is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;

    // Numeric metrics coerce the value to a number; current_activity stays a string.
    const value = isActivityMetric ? f.value.trim() : Number(f.value);

    const condition: Record<string, any> = {
      metric: f.metric,
      operator: f.operator,
      value,
    };
    if (!isActivityMetric && f.currentActivity.trim())
      condition.current_activity = f.currentActivity.trim();

    const params: Record<string, any> = {};
    if (f.actionType === 'create_task') {
      if (f.taskTitle.trim()) params.title = f.taskTitle.trim();
      if (f.assignee.trim()) params.assignee = f.assignee.trim();
      params.priority = f.priority;
    } else if (f.actionType === 'notify_in_app') {
      if (f.taskTitle.trim()) params.title = f.taskTitle.trim();
      params.priority = f.priority;
    } else if (f.actionType === 'notify_webhook') {
      params.url = f.webhookUrl.trim();
    } else if (f.actionType === 'escalate') {
      params.level = f.escalateLevel.trim() || 'manager';
    } else if (f.actionType === 'tag_case') {
      params.tag = f.tag.trim() || 'flagged';
    }

    onSave({
      name: f.name.trim(),
      description: f.description.trim() || null,
      event_log_id: f.eventLogId,
      enabled: f.enabled,
      condition,
      action: { type: f.actionType, params },
      cooldown_seconds: Number(f.cooldownSeconds) || 0,
    });
  };

  const selectedMetric = METRICS.find((m) => m.value === f.metric);

  return (
    <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
      <div className="px-6 py-4 border-b border-line bg-surface-1/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
            <Zap className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-fg">
              {initial ? 'Edit action rule' : 'Create action rule'}
            </h2>
            <p className="text-[12px] text-fg-muted">
              Run an action automatically when cases match a condition
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Name + description */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Rule name
            </label>
            <input
              type="text"
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g., Escalate stuck approvals"
              className={clsx('input w-full', errors.name && 'border-danger/50')}
            />
            {errors.name && <p className="mt-1 text-xs text-danger">{errors.name}</p>}
          </div>
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Event log
            </label>
            <select
              value={f.eventLogId}
              onChange={(e) => set('eventLogId', e.target.value)}
              className={clsx('select w-full', errors.eventLogId && 'border-danger/50')}
            >
              <option value="">Select event log...</option>
              {eventLogs.map((log) => (
                <option key={log.id} value={log.id}>
                  {log.name}
                </option>
              ))}
            </select>
            {errors.eventLogId && (
              <p className="mt-1 text-xs text-danger">{errors.eventLogId}</p>
            )}
          </div>
        </div>

        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Description <span className="font-normal text-fg-faint">(optional)</span>
          </label>
          <input
            type="text"
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="What does this rule do?"
            className="input w-full"
          />
        </div>

        {/* Condition */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-3">
            Condition
          </label>
          <div className="flex flex-wrap items-start gap-3 p-4 bg-surface-1 rounded-xl border border-line">
            <div className="min-w-[200px] flex-1">
              <label className="block text-[11px] text-fg-faint mb-1">When</label>
              <select
                value={f.metric}
                onChange={(e) => set('metric', e.target.value)}
                className="select w-full"
              >
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <label className="block text-[11px] text-fg-faint mb-1">Is</label>
              <select
                value={f.operator}
                onChange={(e) => set('operator', e.target.value)}
                className="select w-full"
              >
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-44">
              <label className="block text-[11px] text-fg-faint mb-1">
                Value {selectedMetric?.unit ? `(${selectedMetric.unit})` : ''}
              </label>
              <input
                type={isActivityMetric ? 'text' : 'number'}
                value={f.value}
                onChange={(e) => set('value', e.target.value)}
                placeholder={isActivityMetric ? 'Activity name' : '0'}
                className={clsx('input w-full', errors.value && 'border-danger/50')}
              />
              {errors.value && <p className="mt-1 text-xs text-danger">{errors.value}</p>}
            </div>
          </div>

          {!isActivityMetric && (
            <div className="mt-3">
              <label className="block text-[11px] text-fg-faint mb-1">
                Only when current activity is{' '}
                <span className="font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={f.currentActivity}
                onChange={(e) => set('currentActivity', e.target.value)}
                placeholder="e.g., Approval"
                className="input w-full max-w-sm"
              />
            </div>
          )}
        </div>

        {/* Action */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-3">
            Then do
          </label>
          <div className="flex flex-wrap gap-2 mb-4">
            {ACTION_TYPES.map((a) => (
              <button
                key={a.value}
                type="button"
                onClick={() => set('actionType', a.value)}
                className={clsx(
                  'px-4 py-2.5 rounded-lg text-sm font-medium border transition-all',
                  f.actionType === a.value
                    ? 'bg-accent/10 text-accent border-line-strong'
                    : 'bg-surface-2 text-fg-muted border-line hover:border-line-strong',
                )}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="p-4 bg-surface-1 rounded-xl border border-line space-y-4">
            {(f.actionType === 'create_task' || f.actionType === 'notify_in_app') && (
              <>
                <div>
                  <label className="block text-[11px] font-medium text-fg-faint mb-2">
                    Title <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={f.taskTitle}
                    onChange={(e) => set('taskTitle', e.target.value)}
                    placeholder="Defaults to “Review case …”"
                    className="input w-full"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {f.actionType === 'create_task' && (
                    <div>
                      <label className="block text-[11px] font-medium text-fg-faint mb-2">
                        Assignee <span className="font-normal">(user id or email)</span>
                      </label>
                      <input
                        type="text"
                        value={f.assignee}
                        onChange={(e) => set('assignee', e.target.value)}
                        placeholder="owner@company.com"
                        className="input w-full"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-[11px] font-medium text-fg-faint mb-2">
                      Priority
                    </label>
                    <select
                      value={f.priority}
                      onChange={(e) => set('priority', e.target.value)}
                      className="select w-full capitalize"
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p} className="capitalize">
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}

            {f.actionType === 'notify_webhook' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Webhook URL
                </label>
                <input
                  type="url"
                  value={f.webhookUrl}
                  onChange={(e) => set('webhookUrl', e.target.value)}
                  placeholder="https://your-service.com/webhook"
                  className={clsx('input w-full', errors.webhookUrl && 'border-danger/50')}
                />
                {errors.webhookUrl && (
                  <p className="mt-1 text-xs text-danger">{errors.webhookUrl}</p>
                )}
                <p className="mt-1.5 text-[11px] text-fg-faint">
                  A POST with the rule + matched-case context is sent per matching case.
                </p>
              </div>
            )}

            {f.actionType === 'escalate' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Escalation level
                </label>
                <input
                  type="text"
                  value={f.escalateLevel}
                  onChange={(e) => set('escalateLevel', e.target.value)}
                  placeholder="e.g., manager"
                  className="input w-full max-w-sm"
                />
                <p className="mt-1.5 text-[11px] text-fg-faint">
                  Creates an urgent task in the inbox for the matched case.
                </p>
              </div>
            )}

            {f.actionType === 'tag_case' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Tag
                </label>
                <input
                  type="text"
                  value={f.tag}
                  onChange={(e) => set('tag', e.target.value)}
                  placeholder="e.g., flagged"
                  className="input w-full max-w-sm"
                />
              </div>
            )}
          </div>
        </div>

        {/* Cooldown + enabled */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
              Cooldown (seconds)
            </label>
            <input
              type="number"
              min={0}
              value={f.cooldownSeconds}
              onChange={(e) => set('cooldownSeconds', Number(e.target.value))}
              className="input w-full max-w-xs"
            />
            <p className="mt-1.5 text-[11px] text-fg-faint">
              Minimum gap between automatic firings.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-6">
            <button
              type="button"
              onClick={() => set('enabled', !f.enabled)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-all',
                f.enabled
                  ? 'bg-success/10 text-success border-line-strong'
                  : 'bg-surface-2 text-fg-muted border-line',
              )}
            >
              {f.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
              {f.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-end gap-3">
        <button onClick={onCancel} className="btn-ghost px-4 py-2 text-sm font-medium">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary flex items-center gap-1.5 px-5 py-2 text-sm font-semibold"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : initial ? 'Update rule' : 'Create rule'}
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ActionRulesPage() {
  const addNotification = useUIStore((s) => s.addNotification);
  const { projects, fetchProjects } = useProjectsStore();

  const [projectId, setProjectId] = useState('');
  const [rules, setRules] = useState<ActionRule[]>([]);
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ActionRule | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<Record<string, RuleExecution[]>>({});

  const logName = useMemo(() => {
    const m = new Map(logs.map((l) => [l.id, l.name]));
    return (id: string | null) => (id ? m.get(id) ?? 'Unknown log' : 'No log');
  }, [logs]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Default to the first project once they load.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const loadForProject = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    try {
      const [ruleList, logList] = await Promise.all([
        actionRulesApi.list(pid),
        eventLogsApi.list(pid),
      ]);
      setRules(ruleList);
      setLogs(logList);
    } catch {
      addNotification({ type: 'error', title: 'Failed to load action rules' });
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  useEffect(() => {
    if (projectId) loadForProject(projectId);
  }, [projectId, loadForProject]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (rule: ActionRule) => {
    setEditing(rule);
    setModalOpen(true);
  };

  const handleSave = async (body: any) => {
    setSaving(true);
    try {
      if (editing) {
        await actionRulesApi.update(editing.id, body);
        addNotification({ type: 'success', title: 'Rule updated' });
      } else {
        await actionRulesApi.create({ ...body, project_id: projectId });
        addNotification({ type: 'success', title: 'Rule created' });
      }
      setModalOpen(false);
      setEditing(null);
      await loadForProject(projectId);
    } catch {
      addNotification({
        type: 'error',
        title: editing ? 'Failed to update rule' : 'Failed to create rule',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: ActionRule) => {
    try {
      const updated = await actionRulesApi.update(rule.id, { enabled: !rule.enabled });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
    } catch {
      addNotification({ type: 'error', title: 'Failed to update rule' });
    }
  };

  const handleDelete = async (rule: ActionRule) => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await actionRulesApi.delete(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      addNotification({ type: 'success', title: 'Rule deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete rule' });
    }
  };

  const handleRunNow = async (rule: ActionRule) => {
    setRunningId(rule.id);
    try {
      // dry_run=false actually dispatches the action against matching cases.
      const res = await actionRulesApi.evaluate(rule.id, false);
      const matched = res?.matched ?? 0;
      const dispatched = Array.isArray(res?.dispatched) ? res.dispatched : [];
      const failures = dispatched.filter((d: any) => d && d.success === false).length;
      if (matched === 0) {
        addNotification({
          type: 'info',
          title: 'Rule ran',
          message: 'No cases matched the condition.',
        });
      } else if (failures > 0) {
        addNotification({
          type: 'error',
          title: 'Rule ran with errors',
          message: `${matched} case(s) matched, ${failures} action(s) failed.`,
        });
      } else {
        addNotification({
          type: 'success',
          title: 'Rule fired',
          message: `${matched} case(s) matched and ${actionLabel(
            rule.action?.type,
          ).toLowerCase()} dispatched.`,
        });
      }
      await loadForProject(projectId);
      if (expandedId === rule.id) await loadExecutions(rule.id);
    } catch {
      addNotification({ type: 'error', title: 'Failed to run rule' });
    } finally {
      setRunningId(null);
    }
  };

  const loadExecutions = useCallback(async (ruleId: string) => {
    try {
      const list = await actionRulesApi.executions(ruleId, 25);
      setExecutions((prev) => ({ ...prev, [ruleId]: list }));
    } catch {
      setExecutions((prev) => ({ ...prev, [ruleId]: [] }));
    }
  }, []);

  const toggleHistory = (ruleId: string) => {
    if (expandedId === ruleId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(ruleId);
    if (!executions[ruleId]) loadExecutions(ruleId);
  };

  return (
    <div>
      <PageHeader
        title="Action Rules"
        icon={Zap}
        description="Close the loop — automatically create tasks, escalate, notify, or tag cases when they match a condition"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="select text-[12px]"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn-primary" onClick={openCreate} disabled={!projectId}>
              <Plus size={18} />
              New Rule
            </button>
          </div>
        }
      />

      {loading ? (
        <div className="mt-10">
          <LoadingSpinner size="lg" text="Loading action rules..." fullPage />
        </div>
      ) : !projectId ? (
        <EmptyState
          className="mt-10"
          icon={Zap}
          title="Select a project"
          description="Choose a project above to view and manage its action rules."
        />
      ) : rules.length === 0 ? (
        <EmptyState
          className="mt-10"
          icon={Zap}
          title="No action rules yet"
          description="Create a rule to automatically act on cases that match a condition — escalate stuck cases, open a task, fire a webhook, or tag them."
          action={
            <button className="btn-primary" onClick={openCreate}>
              <Plus size={15} />
              Create Rule
            </button>
          }
        />
      ) : (
        <div className="mt-6 space-y-3">
          {rules.map((rule) => {
            const isExpanded = expandedId === rule.id;
            const ruleExecs = executions[rule.id] ?? [];
            return (
              <div key={rule.id} className={clsx('card p-5', !rule.enabled && 'opacity-60')}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className={clsx(
                        'mt-0.5 rounded-lg p-2',
                        rule.enabled ? 'bg-accent/10' : 'bg-tint',
                      )}
                    >
                      <Zap
                        size={18}
                        className={rule.enabled ? 'text-accent' : 'text-fg-faint'}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-semibold text-fg truncate">
                          {rule.name}
                        </h3>
                        <span className="badge badge-slate">
                          {actionLabel(rule.action?.type)}
                        </span>
                      </div>
                      {rule.description && (
                        <p className="mt-0.5 text-[12px] text-fg-muted truncate">
                          {rule.description}
                        </p>
                      )}
                      <p className="mt-1 text-[12px] text-fg-secondary">
                        <span className="text-fg-muted">If</span>{' '}
                        {conditionSummary(rule.condition)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-fg-faint">
                        <span>{logName(rule.event_log_id)}</span>
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          cooldown {rule.cooldown_seconds}s
                        </span>
                        <span>fired {rule.trigger_count}×</span>
                        {rule.last_triggered_at && (
                          <span className="flex items-center gap-1">
                            <History size={12} />
                            last {formatRelativeTime(rule.last_triggered_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={clsx(
                        'badge',
                        rule.enabled ? 'badge-emerald' : 'badge-slate',
                      )}
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <button
                      onClick={() => handleRunNow(rule)}
                      disabled={runningId === rule.id || !rule.event_log_id}
                      className="btn-ghost p-1.5"
                      title="Run now (dispatch actions for matching cases)"
                    >
                      <Play
                        size={14}
                        className={runningId === rule.id ? 'animate-pulse' : undefined}
                      />
                    </button>
                    <button
                      onClick={() => handleToggle(rule)}
                      className="btn-ghost p-1.5"
                      title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                    >
                      {rule.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                    </button>
                    <button
                      onClick={() => openEdit(rule)}
                      className="btn-ghost p-1.5"
                      title="Edit rule"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(rule)}
                      className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
                      title="Delete rule"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* History toggle */}
                <button
                  onClick={() => toggleHistory(rule.id)}
                  className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-fg-muted hover:text-fg"
                >
                  <ChevronRight
                    size={13}
                    className={clsx('transition-transform', isExpanded && 'rotate-90')}
                  />
                  Recent executions
                </button>

                {isExpanded && (
                  <div className="mt-3 rounded-lg border border-line bg-surface-1">
                    {ruleExecs.length === 0 ? (
                      <p className="px-4 py-3 text-[12px] text-fg-faint">
                        No executions recorded yet. Use “Run now” to fire the rule.
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left">
                            <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                              Case
                            </th>
                            <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                              When
                            </th>
                            <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                              Result
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {ruleExecs.map((ex) => (
                            <tr
                              key={ex.id}
                              className="border-b border-line/40 last:border-0"
                            >
                              <td className="px-4 py-2 font-mono text-[12px] text-fg-secondary">
                                {ex.case_id}
                              </td>
                              <td className="px-4 py-2 text-[12px] text-fg-muted">
                                {ex.triggered_at
                                  ? formatRelativeTime(ex.triggered_at)
                                  : '—'}
                              </td>
                              <td className="px-4 py-2">
                                {ex.success ? (
                                  <span className="inline-flex items-center gap-1 text-[12px] text-success">
                                    <CheckCircle2 size={13} />
                                    Success
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-[12px] text-danger"
                                    title={ex.details?.error || ex.details?.note}
                                  >
                                    <XCircle size={13} />
                                    {ex.details?.error || ex.details?.note || 'Failed'}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        size="xl"
      >
        {modalOpen && (
          <RuleForm
            initial={editing ?? undefined}
            eventLogs={logs}
            saving={saving}
            onSave={handleSave}
            onCancel={() => {
              setModalOpen(false);
              setEditing(null);
            }}
          />
        )}
      </Modal>

      {/* Footnote */}
      {projectId && rules.length > 0 && (
        <div className="mt-6 flex items-start gap-2 text-[11px] text-fg-faint">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            “Run now” evaluates the rule against its event log and dispatches the
            action for every matching case immediately, bypassing the cooldown.
          </span>
        </div>
      )}
    </div>
  );
}
