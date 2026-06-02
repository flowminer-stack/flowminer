import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderKanban, ArrowRight, type LucideIcon } from 'lucide-react';
import { useProjectsStore } from '@/store';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/common/EmptyState';
import LoadingSpinner from '@/components/common/LoadingSpinner';

interface ProjectPickerPageProps {
  title: string;
  description: string;
  icon: LucideIcon;
  // Template path where `:projectId` will be replaced, e.g.
  // "/initiatives/:projectId" or "/benchmark/:projectId".
  nextPathTemplate: string;
}

export default function ProjectPickerPage({
  title,
  description,
  icon,
  nextPathTemplate,
}: ProjectPickerPageProps) {
  const navigate = useNavigate();
  const projects = useProjectsStore((s) => s.projects);
  const loading = useProjectsStore((s) => s.loading);
  const fetchProjects = useProjectsStore((s) => s.fetchProjects);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Auto-skip the picker when there is exactly one project — no flicker
  // because the spinner is still showing at that point, and replace:true
  // prevents a back-button trap.
  useEffect(() => {
    if (!loading && projects.length === 1) {
      navigate(nextPathTemplate.replace(':projectId', projects[0].id), { replace: true });
    }
  }, [loading, projects, nextPathTemplate, navigate]);

  const go = (projectId: string) => {
    navigate(nextPathTemplate.replace(':projectId', projectId));
  };

  if (loading && projects.length === 0) {
    return <LoadingSpinner size="lg" text="Loading projects…" fullPage />;
  }

  // Still rendering the spinner while the single-project redirect is pending
  // (loading finished but the navigate call hasn't flushed yet).
  if (!loading && projects.length === 1) {
    return <LoadingSpinner size="lg" text="Loading projects…" fullPage />;
  }

  return (
    <div>
      <PageHeader title={title} icon={icon} description={description} />

      {projects.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="Create a project first, then come back here to pick one."
            action={
              <button onClick={() => navigate('/projects')} className="btn-secondary text-[12px]">
                Go to Projects
              </button>
            }
          />
        </div>
      ) : (
        <>
          <p className="mt-6 text-[11px] font-bold uppercase tracking-widest text-fg-faint">
            Pick a project
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => go(project.id)}
                className="card-interactive group relative text-left"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10">
                      <FolderKanban size={16} className="text-accent" />
                    </div>
                    <ArrowRight
                      size={14}
                      className="mt-1 text-fg-ghost transition-all group-hover:translate-x-0.5 group-hover:text-fg-muted"
                    />
                  </div>
                  <h3 className="mt-3.5 text-[14px] font-semibold leading-tight text-fg">
                    {project.name}
                  </h3>
                  {project.description && (
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-fg-muted">
                      {project.description}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-3 border-t border-line/60 pt-3 text-[11px] text-fg-faint">
                    <span>
                      {project.event_log_count} log{project.event_log_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
