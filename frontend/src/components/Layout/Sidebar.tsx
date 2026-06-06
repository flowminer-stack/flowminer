import { NavLink, useLocation } from 'react-router-dom';
import {
  FolderKanban,
  LayoutDashboard,
  Bell,
  Plug,
  BookTemplate,
  Settings,
  X,
  Activity,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Target,
  BarChart3,
  Home,
  Inbox,
  ShieldCheck,
  Network,
  Workflow,
  Layers,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuthStore, useUIStore } from '@/store';

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { label: 'Projects', path: '/projects', icon: FolderKanban },
      { label: 'Overview', path: '/overview', icon: Home },
      { label: 'Inbox', path: '/inbox', icon: Inbox },
      { label: 'Alerts', path: '/alerts', icon: Bell },
      { label: 'Action Rules', path: '/action-rules', icon: Workflow },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { label: 'Dashboards', path: '/dashboards', icon: LayoutDashboard },
      { label: 'Benchmark', path: '/benchmark', icon: BarChart3 },
      { label: 'Initiatives', path: '/initiatives', icon: Target },
      { label: 'KPIs', path: '/kpis', icon: Activity },
    ],
  },
  {
    label: 'Govern',
    items: [
      { label: 'Governance', path: '/governance', icon: ShieldCheck },
      { label: 'Capability Map', path: '/capability-map', icon: Network },
      { label: 'Object-Centric', path: '/ocpm', icon: Layers },
      // Mission Control is scoped to /mission-control/:eventLogId — there is no
      // bare /mission-control route in App.tsx, so it must be reached from an
      // event-log detail page, not from a top-level sidebar link. Removed to
      // prevent a navigation 404.
    ],
  },
  {
    label: 'Configure',
    items: [
      { label: 'Connectors', path: '/connectors', icon: Plug },
      { label: 'Templates', path: '/templates', icon: BookTemplate },
      { label: 'Settings', path: '/settings', icon: Settings },
    ],
  },
];

export default function Sidebar() {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const initials = user?.full_name
    ? user.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '??';

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line bg-surface-1 transition-all duration-200 ease-out',
          sidebarOpen ? 'w-56' : 'w-[52px]',
          'max-lg:w-56',
          sidebarOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Logo */}
        <div className="flex h-[52px] items-center justify-between px-3 border-b border-line/50">
          <NavLink to="/projects" className="flex items-center gap-2.5 overflow-hidden min-w-0">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent">
              <Activity className="text-white" size={14} strokeWidth={2.5} />
            </div>
            <span
              className={clsx(
                'whitespace-nowrap text-[14px] font-bold tracking-tight text-fg transition-opacity duration-150',
                sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
              )}
            >
              FlowMiner
              <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-widest text-accent">
                alpha
              </span>
            </span>
          </NavLink>
          <button
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-fg-faint hover:bg-tint hover:text-fg-muted lg:hidden transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {navSections.map((section, sIdx) => (
            <div key={section.label} className={clsx(sIdx > 0 && 'mt-4')}>
              <p
                className={clsx(
                  'px-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-fg-faint transition-opacity duration-150',
                  sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
                )}
              >
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive =
                    location.pathname === item.path ||
                    location.pathname.startsWith(item.path + '/');

                  return (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={() => {
                        if (window.innerWidth < 1024) setSidebarOpen(false);
                      }}
                      title={!sidebarOpen ? item.label : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      className={clsx(
                        'relative group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-all duration-100',
                        isActive
                          ? 'bg-accent/10 text-accent'
                          : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                      )}
                    >
                      {isActive && (
                        <span
                          className="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r-full bg-accent"
                          aria-hidden
                        />
                      )}
                      <item.icon
                        size={16}
                        strokeWidth={isActive ? 2.2 : 1.8}
                        className="shrink-0"
                      />
                      <span
                        className={clsx(
                          'whitespace-nowrap transition-opacity duration-150',
                          sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
                        )}
                      >
                        {item.label}
                      </span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Collapse toggle (desktop only) */}
        <button
          onClick={toggleSidebar}
          className="mx-2 mb-2 hidden items-center justify-center rounded-lg py-1.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted lg:flex"
        >
          {sidebarOpen ? <ChevronsLeft size={14} /> : <ChevronsRight size={14} />}
        </button>

        {/* Divider */}
        <div className="mx-3 border-t border-line" />

        {/* User section */}
        <div className="p-2 pb-3">
          <div
            className={clsx(
              'flex items-center gap-2.5 rounded-lg px-2 py-2',
              sidebarOpen ? '' : 'justify-center lg:justify-center max-lg:justify-start',
            )}
          >
            {/* Avatar */}
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[11px] font-bold text-accent">
              {initials}
            </div>
            <div
              className={clsx(
                'min-w-0 flex-1 transition-opacity duration-150',
                sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
              )}
            >
              <p className="truncate text-[12px] font-semibold text-fg-secondary leading-tight">
                {user?.full_name ?? 'Unknown'}
              </p>
              <p className="truncate text-[11px] text-fg-faint capitalize mt-0.5">
                {user?.role ?? ''}
              </p>
            </div>
          </div>

          <button
            onClick={logout}
            title="Sign out"
            className={clsx(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted',
              sidebarOpen ? '' : 'justify-center lg:justify-center max-lg:justify-start',
            )}
          >
            <LogOut size={14} className="shrink-0" />
            <span
              className={clsx(
                'transition-opacity duration-150',
                sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
              )}
            >
              Sign out
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
