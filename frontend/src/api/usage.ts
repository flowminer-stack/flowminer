import api from './http';
import type { UsageSummary } from '@/types/usage';

// ─── Usage Metering (admin) ───────────────────────────────────────────────────

export const usage = {
  /**
   * Aggregate consumption by kind over the last N days.
   * Admin-only — 403 for non-admins.
   */
  getSummary: async (params: { sinceDays?: number; teamId?: string }): Promise<UsageSummary> => {
    const query: Record<string, string | number> = {};
    if (params.sinceDays) query.since_days = params.sinceDays;
    if (params.teamId) query.team_id = params.teamId;
    const r = await api.get<UsageSummary>('/usage', { params: query });
    return r.data;
  },

  /**
   * Returns the CSV export URL (streamed directly from the backend).
   * We build the URL here so the download can be triggered via an <a> tag
   * with the current auth token attached as a query param isn't an option —
   * instead we fetch via axios and blob-download it.
   */
  exportCsv: async (sinceDays: number): Promise<void> => {
    const r = await api.get('/usage/export', {
      params: { since_days: sinceDays },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(r.data as Blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `flowminer-usage-${sinceDays}d.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },
};
