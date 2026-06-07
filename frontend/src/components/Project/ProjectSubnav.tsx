import { Link } from 'react-router-dom';
import clsx from 'clsx';

export type ProjectSubnavTab = 'logs' | 'kpis' | 'journeys' | 'reports';

interface Tab {
  id: ProjectSubnavTab;
  label: string;
  href: (projectId: string) => string;
}

const TABS: Tab[] = [
  { id: 'logs',     label: 'Logs',     href: (id) => `/projects/${id}` },
  { id: 'kpis',     label: 'KPIs',     href: (id) => `/kpis/${id}` },
  { id: 'journeys', label: 'Journeys', href: (id) => `/journeys/${id}` },
  { id: 'reports',  label: 'Reports',  href: (id) => `/scheduled-reports/${id}` },
];

interface ProjectSubnavProps {
  projectId: string;
  active: ProjectSubnavTab;
}

export default function ProjectSubnav({ projectId, active }: ProjectSubnavProps) {
  // useLocation is available but we rely on the explicit `active` prop so that
  // each page owns its own identity — no ambiguous pathname matching needed.
  return (
    <nav
      className="mt-4 flex gap-1 border-b border-line"
      aria-label="Project sections"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          to={tab.href(projectId)}
          className={clsx(
            'border-b-2 px-4 py-2.5 text-[12px] font-medium transition-colors',
            active === tab.id
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg',
          )}
          aria-current={active === tab.id ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
