import api from './http';
import type { Journey, JourneyCreate, JourneyUpdate } from '@/types/journey';

// ─── Journeys API ─────────────────────────────────────────────────────────────
// Backend: GET/POST /api/v1/journeys?project_id=…
//          GET/PUT/DELETE /api/v1/journeys/:id

export const journeys = {
  list: async (projectId: string, limit = 100, offset = 0): Promise<Journey[]> => {
    const r = await api.get('/journeys', {
      params: { project_id: projectId, limit, offset },
    });
    return r.data as Journey[];
  },

  get: async (journeyId: string): Promise<Journey> => {
    const r = await api.get(`/journeys/${journeyId}`);
    return r.data as Journey;
  },

  create: async (body: JourneyCreate): Promise<Journey> => {
    const r = await api.post('/journeys', body);
    return r.data as Journey;
  },

  update: async (journeyId: string, body: JourneyUpdate): Promise<Journey> => {
    const r = await api.put(`/journeys/${journeyId}`, body);
    return r.data as Journey;
  },

  delete: async (journeyId: string): Promise<void> => {
    await api.delete(`/journeys/${journeyId}`);
  },
};
