import { useEffect, useState } from 'react';
import {
  Plus,
  Bell,
  BellOff,
  Trash2,
  Play,
  Clock,
  Zap,
  Mail,
  Globe,
  MessageSquare,
  Users,
  Inbox,
} from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';
import { alerts as alertsApi } from '@/api/client';
import type { Alert } from '@/types';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import Modal from '@/components/common/Modal';
import PageHeader from '@/components/common/PageHeader';
import AlertConfig from '@/components/Alerts/AlertConfig';
import { useUIStore } from '@/store';
import { confirmDialog } from '@/components/common/ConfirmDialog';

const channelIcons: Record<string, typeof Mail> = {
  email: Mail,
  webhook: Globe,
  slack: MessageSquare,
  teams: Users,
  in_app: Inbox,
};

const supportedChannels: Array<{
  id: keyof typeof channelIcons;
  label: string;
  description: string;
}> = [
  { id: 'email', label: 'Email', description: 'Send to any recipient list' },
  { id: 'slack', label: 'Slack', description: 'Post to a Slack channel' },
  { id: 'teams', label: 'Microsoft Teams', description: 'Post to a Teams channel' },
  { id: 'webhook', label: 'Webhook', description: 'Fire any HTTP endpoint' },
  { id: 'in_app', label: 'In-app', description: 'Show a notification in FlowMiner' },
];

const conditionLabels: Record<string, string> = {
  gt: '>',
  lt: '<',
  eq: '=',
  gte: '>=',
  lte: '<=',
};

export default function AlertsPage() {
  const addNotification = useUIStore((s) => s.addNotification);

  const [alertList, setAlertList] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [presetChannel, setPresetChannel] = useState<string | undefined>();

  const openCreateWithChannel = (channel?: string) => {
    setPresetChannel(channel);
    setShowCreateModal(true);
  };

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    setLoading(true);
    try {
      const list = await alertsApi.list();
      setAlertList(list);
    } catch {
      addNotification({ type: 'error', title: 'Failed to load alerts' });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: `Delete alert "${name}"?`,
      message: 'This alert rule and all its notification history will be permanently removed.',
      confirmLabel: 'Delete alert',
      danger: true,
    });
    if (!ok) return;
    try {
      await alertsApi.delete(id);
      setAlertList((prev) => prev.filter((a) => a.id !== id));
      addNotification({ type: 'success', title: 'Alert deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete alert' });
    }
  };

  const handleTest = async (id: string) => {
    try {
      const result = await alertsApi.test(id);
      addNotification({
        type: result.success ? 'success' : 'error',
        title: result.success ? 'Test passed' : 'Test failed',
        message: result.message,
      });
    } catch {
      addNotification({ type: 'error', title: 'Test failed' });
    }
  };

  const handleCreateAlert = async (data: {
    name: string;
    event_log_id: string;
    metric: string;
    condition: string;
    threshold: number;
    channel: string;
    channel_config: Record<string, any>;
  }) => {
    try {
      await alertsApi.create({
        project_id: '',
        name: data.name,
        event_log_id: data.event_log_id,
        metric: data.metric,
        condition: data.condition,
        threshold: data.threshold,
        notification_channel: data.channel,
        webhook_url: data.channel_config?.url || data.channel_config?.slack_webhook_url,
        email_recipients: data.channel_config?.recipients,
      });
      await loadAlerts();
      setShowCreateModal(false);
      addNotification({
        type: 'success',
        title: 'Alert created',
        message: `Alert "${data.name}" has been created successfully.`,
      });
    } catch {
      addNotification({ type: 'error', title: 'Failed to create alert' });
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" text="Loading alerts..." fullPage />;
  }

  const activeAlerts = alertList.filter((a) => a.is_active);
  const inactiveAlerts = alertList.filter((a) => !a.is_active);

  return (
    <div>
      <PageHeader
        title="Alerts"
        icon={Bell}
        description="Get notified when process metrics cross your thresholds"
        actions={
          <button
            className="btn-primary"
            onClick={() => openCreateWithChannel()}
          >
            <Plus size={18} />
            New Alert
          </button>
        }
      />

      {/* Summary */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-accent/10 p-2">
              <Bell size={20} className="text-accent" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {alertList.length}
              </p>
              <p className="text-[12px] text-fg-muted">Total Alerts</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-success/10 p-2">
              <Zap size={20} className="text-success" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {activeAlerts.length}
              </p>
              <p className="text-[12px] text-fg-muted">Active</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-tint p-2">
              <BellOff size={20} className="text-fg-muted" />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums text-fg">
                {inactiveAlerts.length}
              </p>
              <p className="text-[12px] text-fg-muted">Inactive</p>
            </div>
          </div>
        </div>
      </div>

      {/* Supported channels — click a card to start a new alert on that channel */}
      <div className="mt-6 card p-5">
        <h2 className="text-[14px] font-semibold text-fg">Supported channels</h2>
        <p className="mt-1 text-[12px] text-fg-muted">
          Click a channel to start a new alert with that notification type preselected.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {supportedChannels.map((c) => {
            const Icon = channelIcons[c.id];
            return (
              <button
                key={c.id}
                onClick={() => openCreateWithChannel(c.id)}
                className="group flex items-start gap-2.5 rounded-lg border border-line bg-surface-1 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent transition-colors group-hover:bg-accent/15">
                  <Icon size={13} />
                </div>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-fg leading-tight">{c.label}</p>
                  <p className="mt-0.5 text-[11px] text-fg-muted leading-tight">{c.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Alert list */}
      {alertList.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-line p-12 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
            <Bell size={20} />
          </div>
          <p className="mt-3 text-[13px] font-semibold text-fg">No alerts configured</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-fg-muted">
            Create alerts to monitor process metrics. Each alert can fire on any of the channels above.
          </p>
          <button
            className="btn-primary mt-4"
            onClick={() => openCreateWithChannel()}
          >
            <Plus size={15} />
            Create Alert
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {alertList.map((alert) => {
            const ChannelIcon =
              channelIcons[alert.notification_channel] ?? Globe;

            return (
              <div
                key={alert.id}
                className={clsx(
                  'card p-5 transition-all',
                  !alert.is_active && 'opacity-50',
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className={clsx(
                        'mt-0.5 rounded-lg p-2',
                        alert.is_active
                          ? 'bg-accent/10'
                          : 'bg-tint',
                      )}
                    >
                      <Bell
                        size={18}
                        className={
                          alert.is_active
                            ? 'text-accent'
                            : 'text-fg-faint'
                        }
                      />
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-fg">
                        {alert.name}
                      </h3>
                      <p className="mt-1 text-[12px] text-fg-muted">
                        <span className="font-medium">{alert.metric}</span>{' '}
                        {conditionLabels[alert.condition] ?? alert.condition}{' '}
                        <span className="font-medium">{alert.threshold}</span>
                      </p>
                      <div className="mt-2 flex items-center gap-4 text-[11px] text-fg-faint">
                        <div className="flex items-center gap-1">
                          <ChannelIcon size={12} />
                          <span>{alert.notification_channel}</span>
                        </div>
                        {alert.last_triggered && (
                          <div className="flex items-center gap-1">
                            <Clock size={12} />
                            <span>
                              Last triggered:{' '}
                              {format(
                                new Date(alert.last_triggered),
                                'MMM d, h:mm a',
                              )}
                            </span>
                          </div>
                        )}
                        {alert.last_value !== null && (
                          <span>Last value: {alert.last_value}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'badge',
                        alert.is_active ? 'badge-emerald' : 'badge-slate',
                      )}
                    >
                      {alert.is_active ? 'Active' : 'Inactive'}
                    </span>
                    <button
                      onClick={() => handleTest(alert.id)}
                      className="btn-ghost p-1.5"
                      title="Test alert"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(alert.id, alert.name)}
                      className="btn-ghost p-1.5 text-danger hover:bg-danger/10 hover:text-danger"
                      title="Delete alert"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Alert Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          setPresetChannel(undefined);
        }}
        size="xl"
      >
        {showCreateModal && (
          <AlertConfig
            eventLogs={[]}
            onSave={handleCreateAlert}
            onCancel={() => {
              setShowCreateModal(false);
              setPresetChannel(undefined);
            }}
            initialChannel={presetChannel}
          />
        )}
      </Modal>
    </div>
  );
}
