import api from './http';

// ─── Analytics (sustainability, agent mining, benchmarks, SQL, NL) ───────────

export const analytics = {
  sustainability: async (body: {
    event_log_id: string;
    factors?: Record<string, number>;
    activity_overrides?: Record<string, Record<string, number>>;
  }): Promise<any> => {
    const r = await api.post('/analytics/sustainability', body);
    return r.data;
  },
  agentMining: async (eventLogId: string): Promise<any> => {
    const r = await api.get(`/analytics/agent-mining/${eventLogId}`);
    return r.data;
  },
  benchmark: async (eventLogIds: string[]): Promise<any> => {
    const r = await api.post('/analytics/benchmark', { event_log_ids: eventLogIds });
    return r.data;
  },
  sqlSandbox: async (body: { event_log_id: string; query: string; limit?: number }): Promise<any> => {
    const r = await api.post('/analytics/sql-sandbox', body);
    return r.data;
  },
  calendarHeatmap: async (eventLogId: string): Promise<any> => {
    const r = await api.get(`/analytics/calendar-heatmap/${eventLogId}`);
    return r.data;
  },
  textToWidget: async (eventLogId: string, question: string): Promise<any> => {
    const r = await api.post('/analytics/text-to-widget', {
      event_log_id: eventLogId,
      question,
    });
    return r.data;
  },
};
