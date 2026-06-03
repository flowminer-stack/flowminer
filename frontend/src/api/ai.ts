import api from './http';
import type {
  ChatStreamHandlers,
  ChatStreamMessage,
  VariantExplanation,
} from '@/types';

// Re-export the AI domain types so the historical '@/api/client' surface
// (which exposed these alongside the `ai` resource) keeps resolving
// unchanged.
export type {
  ChatToolRenderBarChart,
  ChatToolRenderLineChart,
  ChatToolRenderMetricCard,
  ChatToolRenderFilterProposal,
  ChatToolRender,
  ChatToolResult,
  ChatToolStartEvent,
  ChatToolResultEvent,
  ChatStreamHandlers,
  VariantExplanation,
} from '@/types';

// ─── AI (LLM chat, agent, text-to-bpmn, narrate) ─────────────────────────────

export const ai = {
  /**
   * Stream a chat response from the LLM for the given event log.
   * Yields partial text chunks via the callback as they arrive.
   */
  chatStream: async (
    eventLogId: string,
    question: string,
    handlers: ChatStreamHandlers,
  ): Promise<void> => {
    const token = localStorage.getItem('flowminer_token');
    const response = await fetch('/api/v1/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event_log_id: eventLogId,
        question,
        stream: true,
        use_tools: true,
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Chat request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawAnything = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: ChatStreamMessage;
        try {
          msg = JSON.parse(line) as ChatStreamMessage;
        } catch {
          continue;
        }
        sawAnything = true;
        if (msg.type === 'chunk' && typeof msg.text === 'string') {
          handlers.onChunk(msg.text);
        } else if (msg.type === 'tool_start') {
          handlers.onToolStart?.({
            id: msg.id ?? '',
            name: msg.name ?? '',
            args: msg.args ?? {},
          });
        } else if (msg.type === 'tool_result') {
          handlers.onToolResult?.({
            id: msg.id ?? '',
            name: msg.name ?? '',
            result: msg.result ?? {},
          });
        } else if (msg.type === 'warning') {
          handlers.onWarning?.(msg.message ?? '');
        } else if (msg.type === 'error') {
          throw new Error(msg.message ?? 'Chat stream failed');
        }
        // 'done' is a no-op — the loop ends when the reader closes.
      }
    }
    if (!sawAnything) {
      throw new Error('Chat stream closed without any content');
    }
  },

  chat: async (
    eventLogId: string,
    question: string,
  ): Promise<{ answer: string; llm_configured: boolean }> => {
    const r = await api.post('/ai/chat', {
      event_log_id: eventLogId,
      question,
      stream: false,
    });
    return r.data;
  },

  agentRun: async (
    eventLogId: string,
    instruction: string,
  ): Promise<{
    text: string;
    tool_calls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
    turns: number;
    provider: string;
  }> => {
    const r = await api.post('/ai/agent/run', {
      event_log_id: eventLogId,
      instruction,
    });
    return r.data;
  },

  textToBpmn: async (description: string): Promise<{ bpmn_xml: string; llm_configured: boolean }> => {
    const r = await api.post('/ai/text-to-bpmn', { description });
    return r.data;
  },

  narrate: async (
    eventLogId: string,
    context?: {
      algorithm?: string;
      noise_threshold?: number;
      complexity?: number;
      visible_nodes?: number;
      visible_edges?: number;
    },
  ): Promise<{ markdown: string; llm_configured: boolean }> => {
    const r = await api.get(`/ai/narrate/${eventLogId}`, context ? { params: context } : undefined);
    return r.data;
  },

  suggestBestPractice: async (
    eventLogId: string,
  ): Promise<{ recommendations: Array<{ name: string; why: string; expected_impact: string }>; raw?: string }> => {
    const r = await api.get(`/ai/suggest-best-practice/${eventLogId}`);
    return r.data;
  },

  chatSuggestions: async (
    eventLogId: string,
  ): Promise<{
    suggestions: string[];
    top_findings: Array<{ severity: string; title: string; description: string }>;
  }> => {
    const r = await api.get(`/ai/chat-suggestions/${eventLogId}`);
    return r.data;
  },

  explainVariant: async (
    eventLogId: string,
    variantActivities: string[],
  ): Promise<VariantExplanation> => {
    const r = await api.post('/ai/explain-variant', {
      event_log_id: eventLogId,
      variant_activities: variantActivities,
    });
    return r.data;
  },

  /**
   * Generate a 1-2 sentence plain-language explanation for a single
   * bottleneck row, conformance deviation, or prediction entry.
   * Falls back to a templated string server-side when LLM is offline.
   */
  explain: async (
    kind: 'bottleneck' | 'conformance' | 'prediction',
    context: Record<string, unknown>,
  ): Promise<{ explanation: string; actionable_hint: string | null; fallback_used: boolean }> => {
    const r = await api.post('/ai/explain', { kind, context });
    return r.data;
  },

  /**
   * Multi-turn event-log extraction copilot. Sends the current conversation
   * history plus optional schema_hint and objective; returns a structured
   * response with an assistant message and optional SQL/pandas steps.
   */
  extractLog: async (body: {
    schema_hint?: string;
    objective?: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<{
    assistant_message: string;
    suggested_steps: Array<{
      label: string;
      rationale: string;
      sql: string | null;
      pandas: string | null;
      columns_used: string[];
    }>;
    requires_user_input: boolean;
    confidence: number;
    fallback_used: boolean;
  }> => {
    const r = await api.post('/ai/extract-log', body);
    return r.data;
  },
};
