// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface Dashboard {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  layout: Record<string, unknown>;
  widgets: WidgetConfig[];
  is_shared: boolean;
  share_token: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  position: { x: number; y: number; w: number; h: number };
}

export interface DashboardCreate {
  project_id: string;
  name: string;
  description?: string;
}
