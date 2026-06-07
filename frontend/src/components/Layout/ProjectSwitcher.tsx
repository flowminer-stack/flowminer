import { useState, useEffect, useRef } from 'react';
import { useLocation, useParams, NavLink } from 'react-router-dom';
import {
  FolderKanban,
  Activity,
  Map,
  FileText,
  ChevronDown,
  Gauge,
  Share2,
  GitBranch,
} from 'lucide-react';
import clsx from 'clsx';
import { projects as projectsApi } from '@/api/projects';
import { eventLogs as eventLogsApi } from '@/api/eventLogs';
import type { Project } from '@/types';
import { useUIStore } from '@/store';

// Routes where the 2nd path segment is a :projectId.
// NOTE: keep these two sets in sync with the parameterized routes in App.tsx —
// a project/log route missing here means the switcher silently won't render.
const PROJECT_ID_PARAM_ROUTES = new Set([
  'kpis', 'journeys', 'scheduled-reports', 'builder', 'benchmark', 'task-mining',
  'initiatives', 'upload', 'projects',
]);

// Routes where the 2nd path segment is an :eventLogId (log-scoped views)
const LOG_ID_PARAM_ROUTES = new Set([
  'process', 'variants', 'bottlenecks', 'drift', 'conformance', 'root-cause',
  'dotted-chart', 'social-network', 'rework', 'comparison', 'simulate',
  'sustainability', 'automation-roi', 'health', 'cases-at-risk', 'causal-map',
  'pulse', 'process-city', 'animation', 'mission-control', 'lineage', 'ocpm',
]);

function secondSegment(pathname: string, routes: Set<string>): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && routes.has(segments[0])) return segments[1];
  return null;
}

interface SwitcherLink {
  label: string;
  icon: React.ElementType;
  to: (id: string) => string;
}

const PROJECT_LINKS: SwitcherLink[] = [
  { label: 'Workspace', icon: FolderKanban, to: (id) => `/projects/${id}` },
  { label: 'KPIs', icon: Activity, to: (id) => `/kpis/${id}` },
  { label: 'Journeys', icon: Map, to: (id) => `/journeys/${id}` },
  { label: 'Reports', icon: FileText, to: (id) => `/scheduled-reports/${id}` },
];

// Log-scoped quick links — surfaces Mission Control + Lineage, which otherwise
// have no nav entry of their own.
const LOG_LINKS: SwitcherLink[] = [
  { label: 'Process map', icon: GitBranch, to: (id) => `/process/${id}` },
  { label: 'Mission Control', icon: Gauge, to: (id) => `/mission-control/${id}` },
  { label: 'Data Lineage', icon: Share2, to: (id) => `/lineage/${id}` },
];

export default function ProjectSwitcher() {
  const location = useLocation();
  const params = useParams<{ projectId?: string; eventLogId?: string }>();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const [project, setProject] = useState<Project | null>(null);
  const [logName, setLogName] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Direct project context (project-scoped routes) vs log context (resolve the
  // event log back to its parent project).
  const directProjectId = params.projectId ?? secondSegment(location.pathname, PROJECT_ID_PARAM_ROUTES);
  const logId = params.eventLogId ?? secondSegment(location.pathname, LOG_ID_PARAM_ROUTES);

  useEffect(() => {
    let cancelled = false;
    setLogName(null);
    if (directProjectId) {
      setProjectId(directProjectId);
      projectsApi.get(directProjectId)
        .then((p) => { if (!cancelled) setProject(p); })
        .catch(() => { if (!cancelled) setProject(null); });
    } else if (logId) {
      // Resolve the event log → its parent project so the switcher shows project
      // context (and project views) even on a log-scoped page.
      eventLogsApi.get(logId)
        .then((el) => {
          if (cancelled) return null;
          setLogName(el.name);
          setProjectId(el.project_id);
          return projectsApi.get(el.project_id);
        })
        .then((p) => { if (p && !cancelled) setProject(p); })
        .catch(() => { if (!cancelled) { setProject(null); setProjectId(null); } });
    } else {
      setProject(null);
      setProjectId(null);
    }
    return () => { cancelled = true; };
  }, [directProjectId, logId]);

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

  // Nothing to show outside a project/log context
  if (!directProjectId && !logId) return null;

  const displayName = project?.name ?? logName ?? 'Current project';

  const closeAndMaybeCollapse = () => {
    setDropdownOpen(false);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex items-center gap-2.5 px-3 py-1.5 text-[12px] font-medium transition-colors',
      isActive ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
    );

  return (
    <div className="px-2 pb-2 pt-1" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => {
          // When collapsed, the dropdown can't render in the icon rail — the
          // first click expands the sidebar, the next opens the dropdown.
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
      {dropdownOpen && sidebarOpen && (
        <div className="absolute left-2 right-2 z-50 mt-1 overflow-hidden rounded-lg border border-line bg-surface-1 py-1 shadow-xl">
          {projectId && (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                Project views
              </p>
              {PROJECT_LINKS.map(({ label, icon: Icon, to }) => (
                <NavLink key={label} to={to(projectId)} onClick={closeAndMaybeCollapse} className={linkClass} end>
                  <Icon size={13} strokeWidth={1.8} className="shrink-0" />
                  {label}
                </NavLink>
              ))}
            </>
          )}
          {logId && (
            <>
              <p
                className="mt-1 truncate border-t border-line/60 px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint"
                title={logName ?? undefined}
              >
                {logName ? `Log · ${logName}` : 'Current log'}
              </p>
              {LOG_LINKS.map(({ label, icon: Icon, to }) => (
                <NavLink key={label} to={to(logId)} onClick={closeAndMaybeCollapse} className={linkClass} end>
                  <Icon size={13} strokeWidth={1.8} className="shrink-0" />
                  {label}
                </NavLink>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
