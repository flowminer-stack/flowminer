import { NavLink, useLocation } from 'react-router-dom';
import {
  Map,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  LayoutGrid,
} from 'lucide-react';
import clsx from 'clsx';
import { useUIStore, useEventLogsStore } from '@/store';
import { getActiveLogId } from '@/utils/activeLog';

// The most-used analyses, surfaced inline whenever the user is inside a log so
// the core catalog is one click away — no drilling into the process view and
// hunting the Analysis tab. "All analyses" opens the full ⌘K palette.
const QUICK_LINKS: { label: string; icon: React.ElementType; to: (id: string) => string }[] = [
  // ?tab=map: a link that says "Process Map" must open the 2D map, never the
  // City tab that large logs otherwise auto-land on.
  { label: 'Process Map', icon: Map, to: (id) => `/process/${id}?tab=map` },
  { label: 'Variants', icon: GitBranch, to: (id) => `/variants/${id}` },
  { label: 'Bottlenecks', icon: AlertTriangle, to: (id) => `/bottlenecks/${id}` },
  { label: 'Conformance', icon: CheckCircle2, to: (id) => `/conformance/${id}` },
  { label: 'Cases at Risk', icon: ShieldAlert, to: (id) => `/cases-at-risk/${id}` },
];

export default function ActiveLogNav() {
  const location = useLocation();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const openPalette = useUIStore((s) => s.openPalette);
  const currentEventLog = useEventLogsStore((s) => s.currentEventLog);

  const logId = getActiveLogId(location.pathname);
  if (!logId) return null;

  const logName = currentEventLog?.id === logId ? currentEventLog.name : null;

  const labelClasses = clsx(
    'whitespace-nowrap transition-opacity duration-150',
    sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
  );

  return (
    <div className="mb-4">
      <p
        className={clsx(
          'truncate px-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-accent transition-opacity duration-150',
          sidebarOpen ? 'opacity-100' : 'opacity-0 lg:opacity-0 max-lg:opacity-100',
        )}
        title={logName ?? undefined}
      >
        {logName ? `Log · ${logName}` : 'Active log'}
      </p>
      <div className="space-y-0.5">
        {QUICK_LINKS.map(({ label, icon: Icon, to }) => {
          const path = to(logId);
          // Compare without the query string — pathname never includes it.
          const isActive = location.pathname === path.split('?')[0];
          return (
            <NavLink
              key={label}
              to={path}
              onClick={() => {
                if (window.innerWidth < 1024) setSidebarOpen(false);
              }}
              title={!sidebarOpen ? label : undefined}
              className={clsx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                isActive ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
              )}
            >
              <Icon size={15} strokeWidth={1.8} className="shrink-0" />
              <span className={labelClasses}>{label}</span>
            </NavLink>
          );
        })}
        <button
          onClick={() => {
            if (!sidebarOpen) setSidebarOpen(true);
            openPalette();
          }}
          title={!sidebarOpen ? 'All analyses (⌘K)' : undefined}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-fg-faint transition-colors hover:bg-surface-3 hover:text-fg-muted"
        >
          <LayoutGrid size={15} strokeWidth={1.8} className="shrink-0" />
          <span className={labelClasses}>All analyses</span>
          <kbd
            className={clsx(
              'ml-auto rounded border border-line bg-surface-1 px-1 py-px text-[9px] font-medium text-fg-faint',
              sidebarOpen ? 'inline-block' : 'hidden max-lg:inline-block',
            )}
          >
            ⌘K
          </kbd>
        </button>
      </div>
    </div>
  );
}
