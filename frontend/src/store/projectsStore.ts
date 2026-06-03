import { create } from 'zustand';
import type { Project, ProjectCreate } from '@/types';
import { projects as projectsApi } from '@/api/client';

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
