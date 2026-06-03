import api from './http';
import type {
  Project,
  ProjectCreate,
  ProjectExportManifest,
  ProjectImportResponse,
} from '@/types';

// ─── Projects ────────────────────────────────────────────────────────────────

export const projects = {
  list: async (): Promise<Project[]> => {
    const response = await api.get<Project[]>('/projects');
    return response.data;
  },

  create: async (data: ProjectCreate): Promise<Project> => {
    const response = await api.post<Project>('/projects', data);
    return response.data;
  },

  get: async (id: string): Promise<Project> => {
    const response = await api.get<Project>(`/projects/${id}`);
    return response.data;
  },

  update: async (
    id: string,
    data: Partial<ProjectCreate>,
  ): Promise<Project> => {
    const response = await api.put<Project>(`/projects/${id}`, data);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/projects/${id}`);
  },

  seedSample: async (): Promise<Project> => {
    const r = await api.post('/projects/seed-sample');
    return r.data;
  },

  // Export a project's metadata, dashboards, alerts, KPIs, initiatives, and
  // action rules as a JSON manifest. Event-log files are NOT embedded — they
  // are referenced by SHA-256 checksum and must be re-uploaded after import.
  export: async (id: string): Promise<ProjectExportManifest> => {
    const r = await api.get<ProjectExportManifest>(`/projects/${id}/export`);
    return r.data;
  },

  // Create a new project from a previously exported manifest. Event-log
  // files are not restored — re-upload them and match by checksum.
  import: async (
    manifest: ProjectExportManifest,
    targetProjectName?: string | null,
  ): Promise<ProjectImportResponse> => {
    const r = await api.post<ProjectImportResponse>('/projects/import', {
      manifest,
      target_project_name: targetProjectName ?? null,
    });
    return r.data;
  },

  // Trigger a browser download of the project export manifest as a JSON file.
  downloadExport: async (id: string, name?: string): Promise<void> => {
    const manifest = await api.get(`/projects/${id}/export`);
    const blob = new Blob([JSON.stringify(manifest.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name ?? `project_${id}`}.flowminer.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
