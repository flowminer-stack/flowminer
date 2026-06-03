import api from './http';
import type { Annotation } from '@/types';

// ─── Annotations ─────────────────────────────────────────────────────────────

export const annotations = {
  // Pass `nestReplies` to receive top-level annotations with their
  // `replies` populated (reply rows are omitted from the root list);
  // omit it (default) to get every annotation flat regardless of parent.
  list: async (
    eventLogId: string,
    nestReplies = false,
  ): Promise<Annotation[]> => {
    const response = await api.get<Annotation[]>('/annotations', {
      params: { event_log_id: eventLogId, nest_replies: nestReplies },
    });
    return response.data;
  },

  create: async (data: Partial<Annotation>): Promise<Annotation> => {
    const response = await api.post<Annotation>('/annotations', data);
    return response.data;
  },

  // Post a threaded reply to an existing annotation.
  reply: async (id: string, content: string): Promise<Annotation> => {
    const response = await api.post<Annotation>(`/annotations/${id}/replies`, {
      content,
    });
    return response.data;
  },

  resolve: async (id: string): Promise<Annotation> => {
    const response = await api.post<Annotation>(`/annotations/${id}/resolve`);
    return response.data;
  },

  unresolve: async (id: string): Promise<Annotation> => {
    const response = await api.post<Annotation>(`/annotations/${id}/unresolve`);
    return response.data;
  },

  // Assign an annotation to a user; pass null to clear the assignment.
  assign: async (
    id: string,
    assigneeId: string | null,
  ): Promise<Annotation> => {
    const response = await api.patch<Annotation>(`/annotations/${id}/assign`, {
      assignee_id: assigneeId,
    });
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/annotations/${id}`);
  },
};
