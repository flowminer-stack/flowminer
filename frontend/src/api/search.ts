import api from './http';
import type { SearchResponse } from '@/types';

// ─── Search ──────────────────────────────────────────────────────────────────

export const search = {
  query: async (q: string): Promise<SearchResponse> => {
    const r = await api.get<SearchResponse>('/search', { params: { q } });
    return r.data;
  },
};
