import React, { useState } from 'react';
import clsx from 'clsx';
import {
  Bell,
  ChevronDown,
  Mail,
  Globe,
  Hash,
  X,
  Plus,
  Save,
  AlertTriangle,
} from 'lucide-react';

interface Alert {
  id: string;
  name: string;
  event_log_id: string;
  metric: string;
  condition: string;
  threshold: number;
  channel: string;
  channel_config: Record<string, any>;
  is_active: boolean;
  last_triggered?: string;
  last_value?: number;
  created_at: string;
}

interface AlertCreate {
  name: string;
  event_log_id: string;
  metric: string;
  condition: string;
  threshold: number;
  channel: string;
  channel_config: Record<string, any>;
}

interface EventLog {
  id: string;
  name: string;
  [key: string]: any;
}

interface AlertConfigProps {
  alert?: Alert;
  eventLogs: EventLog[];
  onSave: (alert: AlertCreate) => void;
  onCancel: () => void;
  // Preselects a notification channel when creating a new alert. Ignored
  // when `alert` (edit mode) is also provided.
  initialChannel?: string;
}

const metrics = [
  { value: 'avg_cycle_time', label: 'Average Cycle Time', unit: 'seconds' },
  { value: 'median_cycle_time', label: 'Median Cycle Time', unit: 'seconds' },
  { value: 'max_cycle_time', label: 'Max Cycle Time', unit: 'seconds' },
  { value: 'rework_rate', label: 'Rework Rate', unit: '%' },
  { value: 'case_count', label: 'Case Count', unit: 'cases' },
  { value: 'variant_count', label: 'Variant Count', unit: 'variants' },
  { value: 'automation_rate', label: 'Automation Rate', unit: '%' },
];

const conditions = [
  { value: 'gt', label: 'Greater than', symbol: '>' },
  { value: 'lt', label: 'Less than', symbol: '<' },
  { value: 'eq', label: 'Equal to', symbol: '=' },
  { value: 'gte', label: 'Greater than or equal', symbol: '>=' },
  { value: 'lte', label: 'Less than or equal', symbol: '<=' },
];

const channels = [
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'webhook', label: 'Webhook', icon: Globe },
  { value: 'slack', label: 'Slack', icon: Hash },
];

const AlertConfig: React.FC<AlertConfigProps> = ({
  alert,
  eventLogs,
  onSave,
  onCancel,
  initialChannel,
}) => {
  const [name, setName] = useState(alert?.name || '');
  const [eventLogId, setEventLogId] = useState(alert?.event_log_id || '');
  const [metric, setMetric] = useState(alert?.metric || 'avg_cycle_time');
  const [condition, setCondition] = useState(alert?.condition || 'gt');
  const [threshold, setThreshold] = useState<number>(alert?.threshold ?? 0);
  const [channel, setChannel] = useState(
    alert?.channel || initialChannel || 'email'
  );
  const [emailRecipients, setEmailRecipients] = useState<string[]>(
    alert?.channel_config?.recipients || []
  );
  const [emailInput, setEmailInput] = useState('');
  const [webhookUrl, setWebhookUrl] = useState(
    alert?.channel_config?.url || ''
  );
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(
    alert?.channel_config?.slack_webhook_url || ''
  );

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) newErrors.name = 'Name is required';
    if (!eventLogId) newErrors.eventLogId = 'Event log is required';
    if (threshold < 0) newErrors.threshold = 'Threshold must be non-negative';

    if (channel === 'email' && emailRecipients.length === 0) {
      newErrors.channel = 'At least one email recipient is required';
    }
    if (channel === 'webhook' && !webhookUrl.trim()) {
      newErrors.channel = 'Webhook URL is required';
    }
    if (channel === 'slack' && !slackWebhookUrl.trim()) {
      newErrors.channel = 'Slack webhook URL is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;

    const channelConfig: Record<string, any> = {};
    if (channel === 'email') channelConfig.recipients = emailRecipients;
    if (channel === 'webhook') channelConfig.url = webhookUrl;
    if (channel === 'slack') channelConfig.slack_webhook_url = slackWebhookUrl;

    onSave({
      name,
      event_log_id: eventLogId,
      metric,
      condition,
      threshold,
      channel,
      channel_config: channelConfig,
    });
  };

  const addEmailRecipient = () => {
    const email = emailInput.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (emailRecipients.includes(email)) return;
    setEmailRecipients((prev) => [...prev, email]);
    setEmailInput('');
  };

  const removeEmailRecipient = (email: string) => {
    setEmailRecipients((prev) => prev.filter((e) => e !== email));
  };

  const selectedMetric = metrics.find((m) => m.value === metric);

  return (
    <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-line bg-surface-1/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center">
            <Bell className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-fg">
              {alert ? 'Edit Alert' : 'Create Alert'}
            </h2>
            <p className="text-[12px] text-fg-muted">
              Get notified when process metrics change
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Alert name */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Alert Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., High Cycle Time Alert"
            className={clsx(
              'input w-full',
              errors.name && 'border-danger/50'
            )}
          />
          {errors.name && (
            <p className="mt-1 text-xs text-danger">{errors.name}</p>
          )}
        </div>

        {/* Event log selector */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-1.5">
            Event Log
          </label>
          <div className="relative">
            <select
              value={eventLogId}
              onChange={(e) => setEventLogId(e.target.value)}
              className={clsx(
                'select w-full',
                errors.eventLogId && 'border-danger/50'
              )}
            >
              <option value="">Select event log...</option>
              {eventLogs.map((log) => (
                <option key={log.id} value={log.id}>
                  {log.name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-faint pointer-events-none" />
          </div>
          {errors.eventLogId && (
            <p className="mt-1 text-xs text-danger">{errors.eventLogId}</p>
          )}
        </div>

        {/* Condition builder */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-3">
            Alert Condition
          </label>
          <div className="flex items-start gap-3 p-4 bg-surface-1 rounded-xl border border-line">
            <div className="flex-1">
              <label className="block text-[11px] text-fg-faint mb-1">When</label>
              <div className="relative">
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  className="select w-full"
                >
                  {metrics.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
              </div>
            </div>

            <div className="w-44">
              <label className="block text-[11px] text-fg-faint mb-1">Is</label>
              <div className="relative">
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="select w-full"
                >
                  {conditions.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
              </div>
            </div>

            <div className="w-36">
              <label className="block text-[11px] text-fg-faint mb-1">
                Threshold {selectedMetric?.unit ? `(${selectedMetric.unit})` : ''}
              </label>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                min={0}
                className={clsx(
                  'input w-full',
                  errors.threshold && 'border-danger/50'
                )}
              />
            </div>
          </div>

          {/* Human-readable summary */}
          <div className="mt-2 flex items-center gap-2 px-1">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
            <p className="text-[12px] text-fg-muted">
              Alert will fire when{' '}
              <span className="font-medium text-fg-secondary">
                {selectedMetric?.label}
              </span>{' '}
              is{' '}
              <span className="font-medium text-fg-secondary">
                {conditions.find((c) => c.value === condition)?.label.toLowerCase()}
              </span>{' '}
              <span className="font-medium text-fg-secondary">
                {threshold} {selectedMetric?.unit}
              </span>
            </p>
          </div>
        </div>

        {/* Notification channel */}
        <div>
          <label className="block text-[12px] font-medium text-fg-muted mb-3">
            Notification Channel
          </label>

          {/* Channel selector */}
          <div className="flex items-center gap-2 mb-4">
            {channels.map((ch) => {
              const Icon = ch.icon;
              return (
                <button
                  key={ch.value}
                  onClick={() => setChannel(ch.value)}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-all',
                    channel === ch.value
                      ? 'bg-accent/10 text-accent border-line-strong'
                      : 'bg-surface-2 text-fg-muted border-line hover:border-line-strong'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {ch.label}
                </button>
              );
            })}
          </div>

          {/* Channel config */}
          <div className="p-4 bg-surface-1 rounded-xl border border-line">
            {channel === 'email' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Recipients
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {emailRecipients.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent border border-line"
                    >
                      <Mail className="w-3 h-3" />
                      {email}
                      <button
                        onClick={() => removeEmailRecipient(email)}
                        className="ml-0.5 hover:text-accent-hover transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEmailRecipient();
                      }
                    }}
                    placeholder="Enter email address..."
                    className="input flex-1"
                  />
                  <button
                    onClick={addEmailRecipient}
                    className="btn-secondary p-2"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {channel === 'webhook' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Webhook URL
                </label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://your-service.com/webhook"
                  className="input w-full"
                />
                <p className="mt-1.5 text-[11px] text-fg-faint">
                  A POST request with the alert payload will be sent to this URL
                </p>
              </div>
            )}

            {channel === 'slack' && (
              <div>
                <label className="block text-[11px] font-medium text-fg-faint mb-2">
                  Slack Webhook URL
                </label>
                <input
                  type="url"
                  value={slackWebhookUrl}
                  onChange={(e) => setSlackWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  className="input w-full"
                />
                <p className="mt-1.5 text-[11px] text-fg-faint">
                  Create an incoming webhook in your Slack workspace settings
                </p>
              </div>
            )}
          </div>

          {errors.channel && (
            <p className="mt-2 text-xs text-danger flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {errors.channel}
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-line bg-surface-1 flex items-center justify-end gap-3">
        <button
          onClick={onCancel}
          className="btn-ghost px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="btn-primary flex items-center gap-1.5 px-5 py-2 text-sm font-semibold"
        >
          <Save className="w-4 h-4" />
          {alert ? 'Update Alert' : 'Create Alert'}
        </button>
      </div>
    </div>
  );
};

export default AlertConfig;
