import api from './http';
import type { TaskPattern, TaskPatternCrossLink } from '@/types';

// Re-export the task-mining domain types so the historical '@/api/client'
// surface keeps resolving unchanged.
export type { TaskPattern, TaskPatternCrossLink } from '@/types';

// ─── Task Mining ─────────────────────────────────────────────────────────────

export const taskMining = {
  listPatterns: async (projectId: string): Promise<TaskPattern[]> => {
    const r = await api.get<TaskPattern[]>('/task-mining/patterns', {
      params: { project_id: projectId },
    });
    return r.data;
  },

  mine: async (
    projectId: string,
    opts?: { min_frequency?: number; min_sequence_length?: number; max_sequence_length?: number },
  ): Promise<{ patterns: number; stored?: number; message?: string }> => {
    const r = await api.post('/task-mining/mine', {
      project_id: projectId,
      min_frequency: opts?.min_frequency ?? 3,
      min_sequence_length: opts?.min_sequence_length ?? 3,
      max_sequence_length: opts?.max_sequence_length ?? 8,
    });
    return r.data;
  },

  crossLink: async (
    projectId: string,
    eventLogId: string,
    minSimilarity: number = 0.5,
  ): Promise<{
    cross_links: TaskPatternCrossLink[];
    activities_considered: number;
    patterns_considered: number;
  }> => {
    const r = await api.post('/task-mining/cross-link', {
      project_id: projectId,
      event_log_id: eventLogId,
      min_similarity: minSimilarity,
    });
    return r.data;
  },

  listRecordings: async (
    projectId: string,
  ): Promise<
    Array<{
      id: string;
      agent_version: string | null;
      hostname: string | null;
      started_at: string | null;
      ended_at: string | null;
      event_count: number;
    }>
  > => {
    const r = await api.get('/task-mining/recordings', { params: { project_id: projectId } });
    return r.data;
  },

  createRecording: async (
    projectId: string,
    opts?: { agent_version?: string | null; hostname?: string | null; notes?: string | null },
  ): Promise<{ id: string; project_id: string; started_at: string | null }> => {
    const r = await api.post('/task-mining/recordings', {
      project_id: projectId,
      agent_version: opts?.agent_version ?? null,
      hostname: opts?.hostname ?? null,
      notes: opts?.notes ?? null,
    });
    return r.data;
  },

  // Ingest a batch of desktop events into a recording. Each event needs
  // `ts` and `event_type`; the backend caps a single batch at 5000 events.
  ingestEvents: async (
    recordingId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<{ ingested: number; total_on_recording?: number }> => {
    const r = await api.post(`/task-mining/recordings/${recordingId}/events`, {
      events,
    });
    return r.data;
  },

  endRecording: async (
    recordingId: string,
  ): Promise<{ id: string; ended_at: string }> => {
    const r = await api.post(`/task-mining/recordings/${recordingId}/end`);
    return r.data;
  },
};
