import { useState, useEffect, useRef } from 'react';
import { useLocation, useParams, NavLink } from 'react-router-dom';
import { FolderKanban, Activity, Map, FileText, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { projects as projectsApi } from '@/api/projects';
import type { Project } from '@/types';
import { useUIStore } from '@/store';

// Routes where a :projectId is accessible via useParams
const PROJECT_ID_PARAM_ROUTES = new Set([
  'kpis',
  'journeys',
  'scheduled-reports',
  'builder',
  'benchmark',
  'task-mining',
  'projects',
]);

// Extract projectId from pathname for param-style routes
// e.g. /kpis/abc-123 → "abc-123", /projects/abc-123 → "abc-123"
function extractProjectId(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && PROJECT_ID_PARAM_ROUTES.has(segments[0])) {
    return segments[1];
  }
  return null;
}

interface SwitcherLink {
  label: string;
  icon: React.ElementType;
  to: (id: string) => string;
}

const SWITCHER_LINKS: SwitcherLink[] = [
  { label: 'Workspace', icon: FolderKanban, to: (id) => `/projects/${id}` },
  { label: 'KPIs', icon: Activity, to: (id) => `/kpis/${id}` },
  { label: 'Journeys', icon: Map, to: (id) => `/journeys/${id}` },
  { label: 'Reports', icon: FileText, to: (id) => `/scheduled-reports/${id}` },
];

export default function ProjectSwitcher() {
  const location = useLocation();
  const params = useParams<{ projectId?: string }>();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const [project, setProject] = useState<Project | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Resolve projectId from params or URL pattern
  const projectId = params.projectId ?? extractProjectId(location.pathname);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    let cancelled = false;
    projectsApi.get(projectId).then((p) => {
      if (!cancelled) setProject(p);
    }).catch(() => {
      if (!cancelled) setProject(null);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Not in a project context — render nothing
  if (!projectId) return null;

  const displayName = project?.name ?? 'Current project';

  return (
    <div className="px-2 pb-2 pt-1" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => {
          // When the sidebar is collapsed the dropdown can't render in the
          // icon rail, so the first click expands the sidebar; the next opens
          // the dropdown. Avoids a dead click.
          if (!sidebarOpen) setSidebarOpen(true);
          else setDropdownOpen((v) => !v);
        }}
        title={!sidebarOpen ? displayName : undefined}
        className={clsx(
          'relative flex w-full items-center rounded-lg border border-line/60 bg-surface-2 px-2.5 py-2 text-left text-[12px] font-medium text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg',
          !sidebarOpen && 'justify-center lg:justify-center max-lg:justify-start',
        )}
      >
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent/15">
          <FolderKanban size={11} className="text-accent" strokeWidth={2} />
        </div>
        <span
          className={clsx(
            'ml-2 flex-1 truncate whitespace-nowrap transition-opacity duration-150',
            sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
          )}
        >
          {displayName}
        </span>
        <ChevronDown
          size={12}
          className={clsx(
            'shrink-0 text-fg-faint transition-transform duration-150',
            sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
            dropdownOpen && 'rotate-180',
          )}
        />
      </button>

      {/* Dropdown */}
      {dropdownOpen && sidebarOpen && projectId && (
        <div className="absolute left-2 right-2 z-50 mt-1 overflow-hidden rounded-lg border border-line bg-surface-1 py-1 shadow-xl">
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
            Project views
          </p>
          {SWITCHER_LINKS.map(({ label, icon: Icon, to }) => (
            <NavLink
              key={label}
              to={to(projectId)}
              onClick={() => {
                setDropdownOpen(false);
                if (window.innerWidth < 1024) setSidebarOpen(false);
              }}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[12px] font-medium transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon size={13} strokeWidth={1.8} className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
