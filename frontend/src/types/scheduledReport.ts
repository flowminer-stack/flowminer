// ─── Scheduled Reports ───────────────────────────────────────────────────────

export type ReportFrequency = 'daily' | 'weekly' | 'monthly';
export type ReportFormat = 'html' | 'csv';

export interface ScheduledReport {
  id: string;
  project_id: string;
  event_log_id: string;
  name: string;
  frequency: ReportFrequency;
  report_format: ReportFormat;
  email_recipients: string[];
  include_sections: string[];
  is_active: boolean;
  last_sent_at: string | null;
  send_count: number;
  created_at: string;
}

export interface ScheduledReportCreate {
  project_id: string;
  event_log_id: string;
  name: string;
  frequency: ReportFrequency;
  report_format: ReportFormat;
  email_recipients: string[];
  include_sections: string[];
}

export interface ScheduledReportUpdate {
  name?: string;
  frequency?: ReportFrequency;
  email_recipients?: string[];
  include_sections?: string[];
  is_active?: boolean;
}
