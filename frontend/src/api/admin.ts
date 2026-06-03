import api from './http';
import type { User } from '@/types';

// ─── Admin ───────────────────────────────────────────────────────────────────

export const admin = {
  listUsers: async (): Promise<User[]> => {
    const r = await api.get<User[]>('/users');
    return r.data;
  },

  updateRole: async (userId: string, role: string): Promise<User> => {
    const r = await api.put<User>(`/users/${userId}/role`, { role });
    return r.data;
  },

  updateStatus: async (userId: string, isActive: boolean): Promise<User> => {
    const r = await api.put<User>(`/users/${userId}/status`, { is_active: isActive });
    return r.data;
  },

  deleteUser: async (userId: string): Promise<void> => {
    await api.delete(`/users/${userId}`);
  },
};
