import React from 'react';
import clsx from 'clsx';
import {
  Bell,
  Edit2,
  Trash2,
  Clock,
  Zap,
} from 'lucide-react';
import { formatRelativeTime } from '../../utils/format';

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

interface AlertListProps {
  alerts: Alert[];
  onEdit: (alert: Alert) => void;
  onDelete: (alertId: string) => void;
  onTest: (alertId: string) => void;
  onToggle: (alertId: string, active: boolean) => void;
}

const metricLabels: Record<string, string> = {
  avg_cycle_time: 'Avg Cycle Time',
  median_cycle_time: 'Median Cycle Time',
  max_cycle_time: 'Max Cycle Time',
  rework_rate: 'Rework Rate',
  case_count: 'Case Count',
  variant_count: 'Variant Count',
  automation_rate: 'Automation Rate',
};

const conditionSymbols: Record<string, string> = {
  gt: '>',
  lt: '<',
  eq: '=',
  gte: '>=',
  lte: '<=',
};

const channelLabels: Record<string, string> = {
  email: 'Email',
  webhook: 'Webhook',
  slack: 'Slack',
};

const AlertList: React.FC<AlertListProps> = ({
  alerts,
  onEdit,
  onDelete,
  onTest,
  onToggle,
}) => {
  if (alerts.length === 0) {
    return (
      <div className="bg-surface-2 rounded-xl border border-line p-12 text-center">
        <div className="w-14 h-14 rounded-full bg-tint flex items-center justify-center mx-auto mb-4">
          <Bell className="w-7 h-7 text-fg-faint" />
        </div>
        <h3 className="text-sm font-semibold text-fg-muted">No alerts configured</h3>
        <p className="text-[12px] text-fg-faint mt-1 max-w-xs mx-auto">
          Create an alert to get notified when your process metrics cross a threshold
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line bg-surface-1/50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Name
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Condition
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Channel
              </th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Status
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Last Triggered
              </th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Last Value
              </th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {alerts.map((alert) => (
              <tr
                key={alert.id}
                className="hover:bg-tint/30 transition-colors"
              >
                {/* Name */}
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={clsx(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        alert.is_active ? 'bg-success' : 'bg-tint'
                      )}
                    />
                    <span className="text-sm font-medium text-fg">
                      {alert.name}
                    </span>
                  </div>
                </td>

                {/* Condition */}
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-fg-muted">
                      {metricLabels[alert.metric] || alert.metric}
                    </span>
                    <span className="text-xs font-mono font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                      {conditionSymbols[alert.condition] || alert.condition}{' '}
                      {alert.threshold}
                    </span>
                  </div>
                </td>

                {/* Channel */}
                <td className="px-4 py-3.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-tint text-fg-muted">
                    {channelLabels[alert.channel] || alert.channel}
                  </span>
                </td>

                {/* Status toggle */}
                <td className="px-4 py-3.5 text-center">
                  <button
                    onClick={() => onToggle(alert.id, !alert.is_active)}
                    className={clsx(
                      'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                      alert.is_active ? 'bg-success' : 'bg-tint'
                    )}
                    title={alert.is_active ? 'Active' : 'Inactive'}
                  >
                    <span
                      className={clsx(
                        'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                        alert.is_active ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      )}
                    />
                  </button>
                </td>

                {/* Last triggered */}
                <td className="px-4 py-3.5">
                  {alert.last_triggered ? (
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-fg-faint" />
                      <span className="text-[12px] text-fg-muted">
                        {formatRelativeTime(alert.last_triggered)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[12px] text-fg-ghost italic">Never</span>
                  )}
                </td>

                {/* Last value */}
                <td className="px-4 py-3.5 text-right">
                  {alert.last_value !== undefined && alert.last_value !== null ? (
                    <span
                      className={clsx(
                        'text-xs font-mono font-semibold px-2 py-0.5 rounded',
                        (() => {
                          const cond = alert.condition;
                          const thresh = alert.threshold;
                          const val = alert.last_value;
                          const triggered =
                            (cond === 'gt' && val > thresh) ||
                            (cond === 'lt' && val < thresh) ||
                            (cond === 'eq' && val === thresh) ||
                            (cond === 'gte' && val >= thresh) ||
                            (cond === 'lte' && val <= thresh);
                          return triggered
                            ? 'bg-danger/10 text-danger'
                            : 'bg-success/10 text-success';
                        })()
                      )}
                    >
                      {alert.last_value}
                    </span>
                  ) : (
                    <span className="text-[12px] text-fg-ghost">—</span>
                  )}
                </td>

                {/* Actions */}
                <td className="px-5 py-3.5">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => onTest(alert.id)}
                      className="p-1.5 rounded-lg hover:bg-accent/10 text-fg-faint hover:text-accent transition-colors"
                      title="Test Alert"
                    >
                      <Zap className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onEdit(alert)}
                      className="p-1.5 rounded-lg hover:bg-tint text-fg-faint hover:text-fg-muted transition-colors"
                      title="Edit Alert"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDelete(alert.id)}
                      className="p-1.5 rounded-lg hover:bg-danger/10 text-fg-faint hover:text-danger transition-colors"
                      title="Delete Alert"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AlertList;
