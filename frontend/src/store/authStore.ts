import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, LoginRequest } from '@/types';
import { auth as authApi, demo as demoApi } from '@/api/client';

// ─── Auth Slice ──────────────────────────────────────────────────────────────

interface AuthSlice {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  // True when the backend reports DEMO_MODE=1 and the SPA is running
  // against a locked-down demo instance. Drives the top banner and
  // lets components disable upload / settings UI without relying on
  // role-based checks (viewer role is already used for other things).
  demoMode: boolean;
  // Flips to true as soon as bootstrapDemo resolves (success or
  // failure). App.tsx gates the route tree on this so a fresh visitor
  // to demo.flowminer.io never sees a flash of /login before the
  // anonymous demo JWT is acquired. Not persisted.
  bootstrapChecked: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => void;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  validateToken: () => Promise<void>;
  // One-shot bootstrap: fetch /demo/status, and if the backend is in
  // demo mode AND we have no token yet, anonymously log in as the
  // pre-seeded demo user. Called once from App on mount.
  bootstrapDemo: () => Promise<void>;
}

export const useAuthStore = create<AuthSlice>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      loading: false,
      demoMode: false,
      bootstrapChecked: false,

      login: async (credentials: LoginRequest) => {
        set({ loading: true });
        try {
          const tokenResponse = await authApi.login(credentials);
          const token = tokenResponse.access_token;
          localStorage.setItem('flowminer_token', token);
          set({ token, isAuthenticated: true });

          const user = await authApi.getMe();
          set({ user, loading: false });
        } catch (error) {
          set({ loading: false, token: null, isAuthenticated: false });
          throw error;
        }
      },

      logout: () => {
        // Fire the server-side revocation first so the jti is on
        // the Redis blocklist before we drop the local token.
        // authApi.logout swallows its own errors, so the local
        // cleanup below always runs.
        void authApi.logout();
        localStorage.removeItem('flowminer_token');
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        });
      },

      setUser: (user: User | null) => set({ user }),

      setToken: (token: string | null) => {
        if (token) {
          localStorage.setItem('flowminer_token', token);
          set({ token, isAuthenticated: true });
        } else {
          localStorage.removeItem('flowminer_token');
          set({ token: null, isAuthenticated: false, user: null });
        }
      },

      validateToken: async () => {
        const { token } = get();
        if (!token) {
          set({ isAuthenticated: false, user: null });
          return;
        }
        try {
          localStorage.setItem('flowminer_token', token);
          const user = await authApi.getMe();
          set({ user, isAuthenticated: true });
        } catch {
          localStorage.removeItem('flowminer_token');
          set({ token: null, isAuthenticated: false, user: null });
        }
      },

      bootstrapDemo: async () => {
        // Ask the backend whether this deployment is a demo instance.
        // On a normal deployment the /demo/status endpoint returns
        // {demo_mode: false} and we leave the auth state alone.
        //
        // The outer try/finally guarantees bootstrapChecked flips in
        // every exit path — including when the backend is unreachable
        // or the endpoint isn't mounted — so App.tsx can release its
        // "Loading…" gate and render the login page for non-demo
        // deployments instead of hanging forever.
        try {
          let status: { demo_mode: boolean } | null = null;
          try {
            status = await demoApi.status();
          } catch {
            // Backend unreachable or endpoint not mounted — not a demo.
            return;
          }
          if (!status?.demo_mode) {
            // Not a demo instance; nothing to do.
            set({ demoMode: false });
            return;
          }

          // Demo instance. If we already have a token (returning visitor
          // within the 24h JWT lifetime), just mark demoMode and let the
          // existing validateToken flow continue.
          if (get().token) {
            set({ demoMode: true });
            return;
          }

          // Fresh visit: grab an anonymous demo JWT and stash it in
          // localStorage so subsequent axios calls carry it. Then fetch
          // the demo user profile so the UI can render properly.
          try {
            const tokenResp = await authApi.demoLogin();
            const token = tokenResp.access_token;
            localStorage.setItem('flowminer_token', token);
            set({ token, isAuthenticated: true, demoMode: true });
            try {
              const user = await authApi.getMe();
              set({ user });
            } catch {
              // Still OK — the token is valid even if /me failed for
              // some reason; ProtectedRoute will let the user through.
            }
          } catch {
            // Seed might not have run yet — the /auth/demo endpoint
            // returns 503 in that case. Mark the mode anyway so the
            // banner can render and the user can retry by reloading.
            set({ demoMode: true });
          }
        } finally {
          set({ bootstrapChecked: true });
        }
      },
    }),
    {
      name: 'flowminer-auth',
      partialize: (state) => ({ token: state.token, demoMode: state.demoMode }),
    },
  ),
);
