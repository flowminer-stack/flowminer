import { create } from 'zustand';
import type {
  DiscoveryResponse,
  VariantResponse,
  BottleneckResponse,
  ConformanceResponse,
  RootCauseResponse,
  ProcessStatistics,
  ProcessSummary,
} from '@/types';
import { mining as miningApi } from '@/api/client';

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
    algorithm?: 'dfg' | 'alpha' | 'heuristic' | 'inductive' | 'split_miner',
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
        algorithm: algorithm as 'dfg' | 'alpha' | 'heuristic' | 'inductive' | 'split_miner',
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
