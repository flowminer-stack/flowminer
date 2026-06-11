import api from './http';
import type { Token, LoginRequest, RegisterRequest, User } from '@/types';

// ─── Auth ────────────────────────────────────────────────────────────────────

export const auth = {
  login: async (data: LoginRequest): Promise<Token> => {
    const formData = new URLSearchParams();
    formData.append('username', data.email);
    formData.append('password', data.password);
    const response = await api.post<Token>('/auth/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return response.data;
  },

  register: async (data: RegisterRequest): Promise<User> => {
    const response = await api.post<User>('/auth/register', data);
    return response.data;
  },

  // Activate a pending account (e.g. the bootstrap admin) via the emailed
  // single-use token, setting the initial password. Returns a JWT so the SPA
  // can sign the user straight in.
  activate: async (token: string, password: string): Promise<Token> => {
    const response = await api.post<Token>('/auth/activate', { token, password });
    return response.data;
  },

  getMe: async (): Promise<User> => {
    const response = await api.get<User>('/auth/me');
    return response.data;
  },

  // Server-side JWT revocation. We intentionally don't await the
  // response-level error — even if the request fails the client still
  // clears its local token so the user is signed out of this tab.
  logout: async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Silent — the blocklist entry is nice-to-have; the client
      // clearing its own token is the primary sign-out action.
    }
  },

  // Anonymous demo login. Only reachable when the backend has
  // DEMO_MODE=1 — returns 404 otherwise. The resulting JWT is
  // read-only outside an analytics allowlist enforced by the
  // demo write-guard middleware.
  demoLogin: async (): Promise<Token> => {
    const response = await api.post<Token>('/auth/demo');
    return response.data;
  },
};

// ─── Demo mode ────────────────────────────────────────────────────────────

export const demo = {
  status: async (): Promise<{ demo_mode: boolean; demo_user_email: string | null }> => {
    const response = await api.get('/demo/status');
    return response.data;
  },
};
