import api from './http';
import type { Task, TaskStatus, TaskPriority, TaskSummary } from '@/types';

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const tasks = {
  list: async (params?: {
    status?: TaskStatus;
    project_id?: string;
    assignee_id?: string;
    case_id?: string;
  }): Promise<Task[]> => {
    const response = await api.get<Task[]>('/tasks', { params });
    return response.data;
  },
  summary: async (): Promise<TaskSummary> => {
    const response = await api.get<TaskSummary>('/tasks/summary');
    return response.data;
  },
  get: async (id: string): Promise<Task> => {
    const response = await api.get<Task>(`/tasks/${id}`);
    return response.data;
  },
  create: async (data: {
    project_id: string;
    event_log_id?: string | null;
    case_id?: string | null;
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    assignee_id?: string | null;
    source_rule_id?: string | null;
    context?: Record<string, unknown> | null;
  }): Promise<Task> => {
    const response = await api.post<Task>('/tasks', data);
    return response.data;
  },
  update: async (
    id: string,
    data: {
      title?: string;
      description?: string | null;
      priority?: TaskPriority;
      status?: TaskStatus;
      assignee_id?: string | null;
      snoozed_until?: string | null;
    },
  ): Promise<Task> => {
    const response = await api.patch<Task>(`/tasks/${id}`, data);
    return response.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/tasks/${id}`);
  },
};
