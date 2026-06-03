import { create } from 'zustand';
import type { Notification } from '@/types';

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
