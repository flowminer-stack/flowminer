// ─── AI (LLM chat, agent, text-to-bpmn, narrate) ─────────────────────────────

export interface ChatToolRenderBarChart {
  type: 'bar_chart';
  title: string;
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
  y_formatter?: 'duration_seconds' | 'percent' | null;
  orientation?: 'horizontal' | 'vertical';
  data: Array<Record<string, unknown>>;
}

export interface ChatToolRenderLineChart {
  type: 'line_chart';
  title: string;
  x_key: string;
  y_key: string;
  x_label?: string;
  y_label?: string;
  data: Array<Record<string, unknown>>;
}

export interface ChatToolRenderMetricCard {
  type: 'metric_card';
  title: string;
  metrics: Array<{ label: string; value: string }>;
}

export interface ChatToolRenderFilterProposal {
  type: 'filter_proposal';
  title: string;
  chips: Array<{
    type: string;
    label: string;
    payload: Record<string, unknown>;
  }>;
}

export type ChatToolRender =
  | ChatToolRenderBarChart
  | ChatToolRenderLineChart
  | ChatToolRenderMetricCard
  | ChatToolRenderFilterProposal;

export interface ChatToolResult {
  data?: unknown;
  render?: ChatToolRender | null;
  summary?: string;
  error?: string;
}

export interface ChatToolStartEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatToolResultEvent {
  id: string;
  name: string;
  result: ChatToolResult;
}

export interface ChatStreamHandlers {
  onChunk: (text: string) => void;
  onToolStart?: (event: ChatToolStartEvent) => void;
  onToolResult?: (event: ChatToolResultEvent) => void;
  onWarning?: (message: string) => void;
}

export interface ChatStreamMessage {
  type?: string;
  text?: string;
  message?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: ChatToolResult;
}

// Response shape for /ai/explain-variant — structured delta stats
// computed by the backend plus the LLM's plain-English paragraph.
export interface VariantExplanation {
  explanation: string;
  llm_configured: boolean;
  stats: {
    variant_case_count: number;
    other_case_count: number;
    variant_avg_duration_seconds: number;
    other_avg_duration_seconds: number;
    duration_ratio: number | null;
    activities: string[];
    longest_step: { activity: string; avg_seconds: number } | null;
    top_resources_in_variant: Array<{ name: string; share: number }>;
    top_resources_in_other: Array<{ name: string; share: number }>;
    root_cause_factor: {
      attribute: string;
      value: string;
      avg_duration_affected: number;
      avg_duration_normal: number;
      overlap_pct: number;
    } | null;
    happy_path: {
      activities: string[];
      case_count: number;
      avg_duration: number;
    } | null;
  };
}
