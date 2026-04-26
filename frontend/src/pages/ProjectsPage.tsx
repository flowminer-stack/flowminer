import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  FolderKanban,
  Calendar,
  FileText,
  MoreVertical,
  Trash2,
  Pencil,
  FlaskConical,
  ArrowRight,
  Search,
  X,
  DollarSign,
  Layers,
  Boxes,
  Filter as FilterIcon,
} from 'lucide-react';
import type { Project } from '@/types';
import { format } from 'date-fns';
import { useProjectsStore, useUIStore, useAuthStore } from '@/store';
import Modal from '@/components/common/Modal';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import PageHeader from '@/components/common/PageHeader';
import { projects as projectsApi } from '@/api/client';
import OnboardingWizard from '@/components/Onboarding/OnboardingWizard';

// ─── Filters ──────────────────────────────────────────────────────────────

type FilterKey = 'all' | 'has_cost' | 'has_logs' | 'has_ocel' | 'empty';

interface FilterDef {
  key: FilterKey;
  label: string;
  icon: typeof FolderKanban;
  description: string;
  matches: (p: Project) => boolean;
}

const FILTERS: FilterDef[] = [
  {
    key: 'all',
    label: 'All projects',
    icon: Layers,
    description: 'Every project you can see',
    matches: () => true,
  },
  {
    key: 'has_logs',
    label: 'With event logs',
    icon: FileText,
    description: 'At least one uploaded event log',
    matches: (p) => (p.event_log_count ?? 0) > 0,
  },
  {
    key: 'has_cost',
    label: 'Cost-tracked',
    icon: DollarSign,
    description: 'At least one log with a mapped cost column',
    matches: (p) => (p.cost_log_count ?? 0) > 0,
  },
  {
    key: 'has_ocel',
    label: 'OCEL',
    icon: Boxes,
    description: 'At least one object-centric event log',
    matches: (p) => (p.ocel_log_count ?? 0) > 0,
  },
  {
    key: 'empty',
    label: 'Empty',
    icon: FolderKanban,
    description: 'Projects with no event logs yet',
    matches: (p) => (p.event_log_count ?? 0) === 0,
  },
];

function isFilterKey(v: string | null): v is FilterKey {
  return !!v && FILTERS.some((f) => f.key === v);
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { projects, loading, fetchProjects, createProject, deleteProject } =
    useProjectsStore();
  const demoMode = useAuthStore((s) => s.demoMode);
  const addNotification = useUIStore((s) => s.addNotification);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [seedingLoading, setSeedingLoading] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Active filter lives in the URL so deep-links from Overview / Initiatives
  // can drop the user straight into a filtered view.
  const filterParam = searchParams.get('filter');
  const activeFilter: FilterKey = isFilterKey(filterParam) ? filterParam : 'all';

  const setActiveFilter = (key: FilterKey) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'all') {
      next.delete('filter');
    } else {
      next.set('filter', key);
    }
    setSearchParams(next, { replace: true });
  };

  // Apply both the search query and the active filter.
  const filteredProjects = useMemo(() => {
    const def = FILTERS.find((f) => f.key === activeFilter) ?? FILTERS[0];
    let out = projects.filter(def.matches);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [projects, searchQuery, activeFilter]);

  // Pre-compute per-filter counts so the chips show the match count.
  const filterCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: projects.length,
      has_logs: 0,
      has_cost: 0,
      has_ocel: 0,
      empty: 0,
    };
    for (const p of projects) {
      for (const f of FILTERS) {
        if (f.key !== 'all' && f.matches(p)) counts[f.key]++;
      }
    }
    return counts;
  }, [projects]);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('flowminer-onboarding-dismissed');
  });
  const onboardingHandled = useRef(false);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (onboardingHandled.current) return;
    if (searchParams.get('seed') === '1') {
      onboardingHandled.current = true;
      searchParams.delete('seed');
      setSearchParams(searchParams, { replace: true });
      void handleSeedSample();
    } else if (searchParams.get('new') === '1') {
      onboardingHandled.current = true;
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
      setCreateModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleCreate = async () => {
    if (!newProjectName.trim()) return;
    setCreating(true);
    try {
      const project = await createProject({
        name: newProjectName.trim(),
        description: newProjectDescription.trim() || undefined,
      });
      setCreateModalOpen(false);
      setNewProjectName('');
      setNewProjectDescription('');
      addNotification({
        type: 'success',
        title: 'Project created',
        message: `"${project.name}" is ready.`,
      });
      navigate(`/projects/${project.id}`);
    } catch {
      addNotification({ type: 'error', title: 'Failed to create project' });
    } finally {
      setCreating(false);
    }
  };

  const handleSeedSample = async () => {
    setSeedingLoading(true);
    try {
      const project = await projectsApi.seedSample();
      await fetchProjects();
      addNotification({
        type: 'success',
        title: 'Sample project loaded',
        message: `"${project.name}" is ready to explore.`,
      });
      navigate(`/projects/${project.id}`);
    } catch {
      addNotification({ type: 'error', title: 'Failed to load sample data' });
    } finally {
      setSeedingLoading(false);
    }
  };

  const handleDelete = async (projectId: string, projectName: string) => {
    if (!window.confirm(`Delete "${projectName}"? This cannot be undone.`)) return;
    try {
      await deleteProject(projectId);
      addNotification({ type: 'success', title: 'Project deleted' });
    } catch {
      addNotification({ type: 'error', title: 'Failed to delete project' });
    }
    setOpenMenuId(null);
  };

  if (loading && projects.length === 0) {
    return <LoadingSpinner size="lg" text="Loading projects…" fullPage />;
  }

  return (
    <div>
      {showOnboarding && (
        <div className="mb-6">
          <OnboardingWizard
            onDismiss={() => {
              setShowOnboarding(false);
              localStorage.setItem('flowminer-onboarding-dismissed', '1');
            }}
            onNavigate={(path) => navigate(path)}
          />
        </div>
      )}

      {/* Page header */}
      <div className="mb-6">
        <PageHeader
          title="Projects"
          icon={FolderKanban}
          description="Manage your process mining projects"
          actions={
            demoMode ? null : (
              <>
                <button
                  onClick={handleSeedSample}
                  disabled={seedingLoading}
                  className="btn-secondary"
                >
                  {seedingLoading ? (
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg-secondary" />
                  ) : (
                    <FlaskConical size={14} />
                  )}
                  Sample Data
                </button>
                <button
                  onClick={() => setCreateModalOpen(true)}
                  className="btn-primary"
                >
                  <Plus size={15} />
                  New Project
                </button>
              </>
            )
          }
        />
      </div>

      {/* Empty state */}
      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-12 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
            <FolderKanban size={20} />
          </div>
          <p className="mt-3 text-[13px] font-semibold text-fg">
            {demoMode ? 'No demo projects loaded' : 'No projects yet'}
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-[12px] text-fg-muted">
            {demoMode
              ? 'The demo seeder should preload three sample logs on boot. If this list is empty, the hourly reset is mid-flight — refresh in a moment.'
              : 'Create your first project or explore with sample data to get started.'}
          </p>
          {!demoMode && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => setCreateModalOpen(true)} className="btn-primary">
                <Plus size={15} />
                Create Project
              </button>
              <button
                onClick={handleSeedSample}
                disabled={seedingLoading}
                className="btn-secondary"
              >
                {seedingLoading ? (
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-fg-secondary" />
                ) : (
                  <FlaskConical size={14} />
                )}
                Try with Sample Data
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Filter bar — always visible. Chip row + search + result count. */}
          <div className="mb-5 rounded-xl border border-line bg-surface-2 p-3" style={{ boxShadow: 'var(--shadow-xs)' }}>
            <div className="flex flex-wrap items-center gap-3">
              <FilterIcon size={14} className="text-fg-muted ml-1" />

              <div className="flex flex-wrap items-center gap-1.5">
                {FILTERS.map((f) => {
                  const active = activeFilter === f.key;
                  const count = filterCounts[f.key];
                  const disabled = f.key !== 'all' && count === 0;
                  const Icon = f.icon;
                  return (
                    <button
                      key={f.key}
                      onClick={() => !disabled && setActiveFilter(f.key)}
                      disabled={disabled}
                      title={f.description}
                      className={
                        active
                          ? 'flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] font-semibold text-accent transition-colors'
                          : disabled
                            ? 'flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-[11px] font-medium text-fg-ghost cursor-not-allowed'
                            : 'flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-fg'
                      }
                    >
                      <Icon size={11} />
                      {f.label}
                      <span
                        className={
                          active
                            ? 'rounded-full bg-accent/15 px-1.5 py-0 text-[9px] font-bold tabular-nums'
                            : 'rounded-full bg-tint px-1.5 py-0 text-[9px] font-bold tabular-nums'
                        }
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex-1" />

              {/* Search */}
              <div className="relative w-full max-w-xs sm:w-56">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects…"
                  className="input pl-8 pr-8 py-1.5 text-[12px] w-full"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
                    aria-label="Clear search"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <span className="text-[11px] text-fg-muted tabular-nums shrink-0">
                {filteredProjects.length} of {projects.length}
              </span>
            </div>
          </div>

          {filteredProjects.length === 0 && (
            <div className="rounded-xl border border-dashed border-line p-8 text-center">
              <Search size={20} className="mx-auto text-fg-ghost" />
              <p className="mt-2 text-[13px] font-semibold text-fg">
                No projects match your filters
              </p>
              <p className="mt-1 text-[12px] text-fg-muted">
                {activeFilter !== 'all' && searchQuery
                  ? `No projects in "${FILTERS.find((f) => f.key === activeFilter)?.label}" match "${searchQuery}".`
                  : activeFilter !== 'all'
                    ? `No projects match "${FILTERS.find((f) => f.key === activeFilter)?.label}".`
                    : `No projects match "${searchQuery}".`}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {activeFilter !== 'all' && (
                  <button onClick={() => setActiveFilter('all')} className="btn-ghost text-[12px]">
                    Clear filter
                  </button>
                )}
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="btn-ghost text-[12px]">
                    Clear search
                  </button>
                )}
              </div>
            </div>
          )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => {
            return (
              <div
                key={project.id}
                className="card-interactive group relative"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <div className="p-5">
                  {/* Header row */}
                  <div className="flex items-start justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10">
                      <FolderKanban size={16} className="text-accent" />
                    </div>

                    {/* Context menu — hidden in demo mode since its only
                        destructive action (Delete) is blocked server-side. */}
                    <div onClick={(e) => e.stopPropagation()}>
                      {!demoMode && (
                        <button
                          onClick={() => setOpenMenuId(openMenuId === project.id ? null : project.id)}
                          className="rounded-lg p-1.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
                          aria-label="Project options"
                        >
                          <MoreVertical size={14} />
                        </button>
                      )}

                      {openMenuId === project.id && (
                        <div
                          className="absolute right-3 top-12 z-10 w-36 rounded-xl border border-line bg-surface-2 py-1 overflow-hidden"
                          style={{ boxShadow: 'var(--shadow-lg)' }}
                        >
                          <button
                            onClick={() => {
                              setOpenMenuId(null);
                              navigate(`/projects/${project.id}`);
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] text-fg-muted hover:bg-tint hover:text-fg transition-colors"
                          >
                            <Pencil size={12} />
                            Open
                          </button>
                          <button
                            onClick={() => handleDelete(project.id, project.name)}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[12px] text-danger hover:bg-danger/10 transition-colors"
                          >
                            <Trash2 size={12} />
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Title */}
                  <h3 className="mt-3.5 text-[14px] font-semibold text-fg leading-tight">
                    {project.name}
                  </h3>
                  {project.description && (
                    <p className="mt-1.5 line-clamp-2 text-[12px] text-fg-muted leading-relaxed">
                      {project.description}
                    </p>
                  )}

                  {/* Footer */}
                  <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-faint">
                      <div className="flex items-center gap-1">
                        <FileText size={11} />
                        <span>
                          {project.event_log_count} log{project.event_log_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {project.cost_log_count > 0 && (
                        <div
                          className="flex items-center gap-1 text-warning"
                          title={`${project.cost_log_count} log${project.cost_log_count !== 1 ? 's' : ''} with cost data`}
                        >
                          <DollarSign size={11} />
                          <span>{project.cost_log_count}</span>
                        </div>
                      )}
                      {project.ocel_log_count > 0 && (
                        <div
                          className="flex items-center gap-1 text-accent"
                          title={`${project.ocel_log_count} OCEL log${project.ocel_log_count !== 1 ? 's' : ''}`}
                        >
                          <Boxes size={11} />
                          <span>{project.ocel_log_count}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        <Calendar size={11} />
                        <span>{format(new Date(project.created_at), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                    <ArrowRight
                      size={13}
                      className="text-fg-ghost transition-all group-hover:text-fg-muted group-hover:translate-x-0.5"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* Create modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => {
          setCreateModalOpen(false);
          setNewProjectName('');
          setNewProjectDescription('');
        }}
        title="Create New Project"
        footer={
          <>
            <button onClick={() => setCreateModalOpen(false)} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !newProjectName.trim()}
              className="btn-primary"
            >
              {creating ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
                  Creating…
                </>
              ) : (
                'Create Project'
              )}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-semibold text-fg-muted mb-1.5">
              Project name
            </label>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="e.g., Order-to-Cash Process"
              className="input"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-fg-muted mb-1.5">
              Description{' '}
              <span className="font-normal text-fg-faint">(optional)</span>
            </label>
            <textarea
              value={newProjectDescription}
              onChange={(e) => setNewProjectDescription(e.target.value)}
              placeholder="Brief description of this project…"
              rows={3}
              className="input resize-none"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
