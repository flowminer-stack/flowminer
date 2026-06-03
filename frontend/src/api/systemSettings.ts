import api from './http';
import type { LLMConfigResponse, LLMConfigUpdate, SystemHealthResponse } from '@/types';

// Re-export the system-settings domain types so the historical
// '@/api/client' surface keeps resolving unchanged.
export type {
  LLMConfigResponse,
  LLMConfigUpdate,
  ComponentStatus,
  SystemHealthResponse,
} from '@/types';

// ─── System settings (admin-only) ─────────────────────────────────────────

export const systemSettings = {
  getLLMConfig: async (): Promise<LLMConfigResponse> => {
    const r = await api.get('/system-settings/llm');
    return r.data;
  },
  updateLLMConfig: async (body: LLMConfigUpdate): Promise<LLMConfigResponse> => {
    const r = await api.put('/system-settings/llm', body);
    return r.data;
  },
  getSystemHealth: async (): Promise<SystemHealthResponse> => {
    const r = await api.get('/system-settings/health');
    return r.data;
  },
};
