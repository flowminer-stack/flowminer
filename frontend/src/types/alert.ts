// ─── Alert ───────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  project_id: string;
  event_log_id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  is_active: boolean;
  notification_channel: 'email' | 'webhook' | 'slack';
  webhook_url: string | null;
  email_recipients: string[];
  last_triggered: string | null;
  last_value: number | null;
  created_by: string;
  created_at: string;
}

export interface AlertCreate {
  project_id: string;
  event_log_id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  notification_channel?: string;
  webhook_url?: string;
  email_recipients?: string[];
}
