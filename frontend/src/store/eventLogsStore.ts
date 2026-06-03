import { create } from 'zustand';
import type { EventLog } from '@/types';
import { eventLogs as eventLogsApi } from '@/api/client';

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
