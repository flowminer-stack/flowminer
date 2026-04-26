import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  User,
  Project,
  ProjectCreate,
  EventLog,
  DiscoveryResponse,
  VariantResponse,
  BottleneckResponse,
  ConformanceResponse,
  RootCauseResponse,
  ProcessStatistics,
  ProcessSummary,
  Notification,
  LoginRequest,
} from '@/types';
import {
  auth as authApi,
  demo as demoApi,
  projects as projectsApi,
  eventLogs as eventLogsApi,
  mining as miningApi,
} from '@/api/client';

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

// ─── Projects Slice ──────────────────────────────────────────────────────────

interface ProjectsSlice {
  projects: Project[];
  currentProject: Project | null;
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  setCurrentProject: (project: Project | null) => void;
  createProject: (data: ProjectCreate) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsSlice>()((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await projectsApi.list();
      set({ projects, loading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch projects';
      set({ loading: false, error: message });
    }
  },

  setCurrentProject: (project: Project | null) => {
    set({ currentProject: project });
  },

  createProject: async (data: ProjectCreate) => {
    const project = await projectsApi.create(data);
    const { projects } = get();
    set({ projects: [project, ...projects] });
    return project;
  },

  deleteProject: async (id: string) => {
    await projectsApi.delete(id);
    const { projects, currentProject } = get();
    set({
      projects: projects.filter((p) => p.id !== id),
      currentProject: currentProject?.id === id ? null : currentProject,
    });
  },
}));

// ─── Event Logs Slice ────────────────────────────────────────────────────────

interface EventLogsSlice {
  eventLogs: EventLog[];
  currentEventLog: EventLog | null;
  loading: boolean;
  error: string | null;
  fetchEventLogs: (projectId: string) => Promise<void>;
  setCurrentEventLog: (eventLog: EventLog | null) => void;
  addEventLog: (eventLog: EventLog) => void;
  removeEventLog: (id: string) => void;
}

export const useEventLogsStore = create<EventLogsSlice>()((set, get) => ({
  eventLogs: [],
  currentEventLog: null,
  loading: false,
  error: null,

  fetchEventLogs: async (projectId: string) => {
    set({ loading: true, error: null });
    try {
      const eventLogs = await eventLogsApi.list(projectId);
      set({ eventLogs, loading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch event logs';
      set({ loading: false, error: message });
    }
  },

  setCurrentEventLog: (eventLog: EventLog | null) => {
    set({ currentEventLog: eventLog });
  },

  addEventLog: (eventLog: EventLog) => {
    const { eventLogs } = get();
    set({ eventLogs: [eventLog, ...eventLogs] });
  },

  removeEventLog: (id: string) => {
    const { eventLogs, currentEventLog } = get();
    set({
      eventLogs: eventLogs.filter((el) => el.id !== id),
      currentEventLog: currentEventLog?.id === id ? null : currentEventLog,
    });
  },
}));

// ─── Mining Slice ────────────────────────────────────────────────────────────

interface MiningSlice {
  _cachedEventLogId: string | null;
  discoveryResult: DiscoveryResponse | null;
  variants: VariantResponse | null;
  bottlenecks: BottleneckResponse | null;
  conformance: ConformanceResponse | null;
  rootCause: RootCauseResponse | null;
  statistics: ProcessStatistics | null;
  summary: ProcessSummary | null;
  discoveryLoading: boolean;
  variantsLoading: boolean;
  bottlenecksLoading: boolean;
  conformanceLoading: boolean;
  rootCauseLoading: boolean;
  statisticsLoading: boolean;
  summaryLoading: boolean;
  error: string | null;
  fetchDiscovery: (
    eventLogId: string,
    algorithm?: 'dfg' | 'alpha' | 'heuristic' | 'inductive',
  ) => Promise<void>;
  fetchVariants: (eventLogId: string) => Promise<void>;
  fetchBottlenecks: (eventLogId: string) => Promise<void>;
  fetchConformance: (
    eventLogId: string,
    templateId?: string,
  ) => Promise<void>;
  fetchRootCause: (eventLogId: string) => Promise<void>;
  fetchStatistics: (eventLogId: string) => Promise<void>;
  fetchSummary: (eventLogId: string) => Promise<void>;
  clearMining: () => void;
}

const _miningDefaults = {
  discoveryResult: null as DiscoveryResponse | null,
  variants: null as VariantResponse | null,
  bottlenecks: null as BottleneckResponse | null,
  conformance: null as ConformanceResponse | null,
  rootCause: null as RootCauseResponse | null,
  statistics: null as ProcessStatistics | null,
  summary: null as ProcessSummary | null,
  error: null as string | null,
};

export const useMiningStore = create<MiningSlice>()((set, get) => ({
  _cachedEventLogId: null,
  ...(_miningDefaults),
  discoveryLoading: false,
  variantsLoading: false,
  bottlenecksLoading: false,
  conformanceLoading: false,
  rootCauseLoading: false,
  statisticsLoading: false,
  summaryLoading: false,

  fetchDiscovery: async (eventLogId, algorithm = 'dfg') => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.discoveryResult !== null) {
      return;
    }
    set({ discoveryLoading: true, error: null });
    try {
      const result = await miningApi.discover({
        event_log_id: eventLogId,
        algorithm,
      });
      set({ discoveryResult: result, discoveryLoading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to discover process';
      set({ discoveryLoading: false, error: message });
    }
  },

  fetchVariants: async (eventLogId) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.variants !== null) {
      return;
    }
    set({ variantsLoading: true, error: null });
    try {
      const variants = await miningApi.getVariants(eventLogId);
      set({ variants, variantsLoading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch variants';
      set({ variantsLoading: false, error: message });
    }
  },

  fetchBottlenecks: async (eventLogId) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.bottlenecks !== null) {
      return;
    }
    set({ bottlenecksLoading: true, error: null });
    try {
      const bottlenecks = await miningApi.getBottlenecks(eventLogId);
      set({ bottlenecks, bottlenecksLoading: false });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch bottlenecks';
      set({ bottlenecksLoading: false, error: message });
    }
  },

  fetchConformance: async (eventLogId, templateId?) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.conformance !== null) {
      return;
    }
    set({ conformanceLoading: true, error: null });
    try {
      const conformance = await miningApi.getConformance(
        eventLogId,
        templateId,
      );
      set({ conformance, conformanceLoading: false });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch conformance';
      set({ conformanceLoading: false, error: message });
    }
  },

  fetchRootCause: async (eventLogId) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.rootCause !== null) {
      return;
    }
    set({ rootCauseLoading: true, error: null });
    try {
      const rootCause = await miningApi.getRootCause(eventLogId);
      set({ rootCause, rootCauseLoading: false });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch root cause analysis';
      set({ rootCauseLoading: false, error: message });
    }
  },

  fetchStatistics: async (eventLogId) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.statistics !== null) {
      return;
    }
    set({ statisticsLoading: true, error: null });
    try {
      const statistics = await miningApi.getStatistics(eventLogId);
      set({ statistics, statisticsLoading: false });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch statistics';
      set({ statisticsLoading: false, error: message });
    }
  },

  fetchSummary: async (eventLogId) => {
    const s = get();
    if (s._cachedEventLogId !== eventLogId) {
      set({ _cachedEventLogId: eventLogId, ..._miningDefaults });
    } else if (s.summary !== null) {
      return;
    }
    set({ summaryLoading: true, error: null });
    try {
      const summary = await miningApi.getSummary(eventLogId);
      set({ summary, summaryLoading: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch summary';
      set({ summaryLoading: false, error: message });
    }
  },

  clearMining: () =>
    set({
      _cachedEventLogId: null,
      ..._miningDefaults,
    }),
}));

// ─── UI Slice ────────────────────────────────────────────────────────────────

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem('flowminer-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return 'light';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  localStorage.setItem('flowminer-theme', theme);
}

interface UISlice {
  sidebarOpen: boolean;
  theme: Theme;
  notifications: Notification[];
  // Floating Ask-AI chat panel. The trigger lives in Header so it is
  // always visible; the panel body is mounted by Layout and slides in
  // from the right when this flag is true.
  aiChatOpen: boolean;
  // One-shot input prefill signal. Any component can set this +
  // open the chat to drop a question into the input ready to edit.
  // FloatingAIChat watches it, copies the value into its local
  // input state on mount, then clears it.
  aiChatPrefill: string | null;
  setAiChatOpen: (open: boolean) => void;
  toggleAiChat: () => void;
  askAI: (prefilledQuestion: string) => void;
  setAiChatPrefill: (value: string | null) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  addNotification: (
    notification: Omit<Notification, 'id'>,
  ) => void;
  removeNotification: (id: string) => void;
}

let notificationCounter = 0;

const initialTheme = getInitialTheme();
applyTheme(initialTheme);

export const useUIStore = create<UISlice>()((set, get) => ({
  sidebarOpen: true,
  theme: initialTheme,
  notifications: [],
  aiChatOpen: false,
  aiChatPrefill: null,

  setAiChatOpen: (open: boolean) => set({ aiChatOpen: open }),
  toggleAiChat: () => set({ aiChatOpen: !get().aiChatOpen }),
  setAiChatPrefill: (value: string | null) => set({ aiChatPrefill: value }),
  askAI: (prefilledQuestion: string) =>
    set({ aiChatPrefill: prefilledQuestion, aiChatOpen: true }),

  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),

  setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),

  setTheme: (theme: Theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const next = get().theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    set({ theme: next });
  },

  addNotification: (notification) => {
    const id = `notification-${++notificationCounter}-${Date.now()}`;
    const newNotification: Notification = { ...notification, id };
    set({ notifications: [...get().notifications, newNotification] });

    const duration = notification.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        get().removeNotification(id);
      }, duration);
    }
  },

  removeNotification: (id: string) => {
    set({
      notifications: get().notifications.filter((n) => n.id !== id),
    });
  },
}));
