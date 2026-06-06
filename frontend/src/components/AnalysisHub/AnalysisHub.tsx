import { useState, useEffect } from 'react';
import {
  Timer,
  GitFork,
  Clock,
  Layers,
  BarChart3,
  Users,
  Network,
  PieChart,
  Bone,
  FileCheck,
  Eye,
  Activity,
  Download,
  Bot,
  CalendarDays,
  Database,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

import PerformanceDFG from './PerformanceDFG';
import EventuallyFollowsGraph from './EventuallyFollowsGraph';
import TemporalProfile from './TemporalProfile';
import BatchDetection from './BatchDetection';
import CaseOverlap from './CaseOverlap';
import OrgRoles from './OrgRoles';
import SNAView from './SNAView';
import CaseClustering from './CaseClustering';
import LogSkeleton from './LogSkeleton';
import DeclareRules from './DeclareRules';
import ComplianceDashboard from './ComplianceDashboard';
import FourEyes from './FourEyes';
import PerformanceSpectrum from './PerformanceSpectrum';
import FeatureExport from './FeatureExport';
import AgentMining from './AgentMining';
import CalendarHeatmap from './CalendarHeatmap';
import SqlSandbox from './SqlSandbox';
import AskAI from './AskAI';

interface AnalysisHubProps {
  eventLogId: string;
  initialAnalysisId?: string;
}

interface AnalysisItem {
  id: string;
  label: string;
  icon: LucideIcon;
  description: string;
  component: React.ComponentType<{ eventLogId: string }>;
}

export const ANALYSIS_ITEMS: AnalysisItem[] = [
  {
    id: 'performance-dfg',
    label: 'Performance Map',
    icon: Timer,
    description: 'Avg duration between activity pairs',
    component: PerformanceDFG,
  },
  {
    id: 'efg',
    label: 'Eventually-Follows',
    icon: GitFork,
    description: 'Eventually-follows frequency matrix',
    component: EventuallyFollowsGraph,
  },
  {
    id: 'temporal-profile',
    label: 'Temporal Profile',
    icon: Clock,
    description: 'Mean ± stdev per activity pair',
    component: TemporalProfile,
  },
  {
    id: 'batch-detection',
    label: 'Batch Detection',
    icon: Layers,
    description: 'Identify batch processing patterns',
    component: BatchDetection,
  },
  {
    id: 'case-overlap',
    label: 'Case Overlap',
    icon: BarChart3,
    description: 'Concurrent active cases over time',
    component: CaseOverlap,
  },
  {
    id: 'org-roles',
    label: 'Org Roles',
    icon: Users,
    description: 'Mined organisational roles',
    component: OrgRoles,
  },
  {
    id: 'sna',
    label: 'SNA Networks',
    icon: Network,
    description: 'Resource interaction matrices',
    component: SNAView,
  },
  {
    id: 'clustering',
    label: 'Case Clusters',
    icon: PieChart,
    description: 'K-means case clustering',
    component: CaseClustering,
  },
  {
    id: 'log-skeleton',
    label: 'Log Skeleton',
    icon: Bone,
    description: 'Declarative process constraints',
    component: LogSkeleton,
  },
  {
    id: 'declare',
    label: 'DECLARE Rules',
    icon: FileCheck,
    description: 'Discovered DECLARE constraints',
    component: DeclareRules,
  },
  {
    id: 'timed-compliance',
    label: 'SLA / Timed Compliance',
    icon: ShieldCheck,
    description: 'No-code SLA conformance checks',
    component: ComplianceDashboard,
  },
  {
    id: 'four-eyes',
    label: 'Four-Eyes',
    icon: Eye,
    description: 'Segregation-of-duties check',
    component: FourEyes,
  },
  {
    id: 'spectrum',
    label: 'Perf Spectrum',
    icon: Activity,
    description: 'Per-case Gantt timeline view',
    component: PerformanceSpectrum,
  },
  {
    id: 'features',
    label: 'Feature Export',
    icon: Download,
    description: 'Case feature matrix + CSV export',
    component: FeatureExport,
  },
  {
    id: 'ask',
    label: 'Ask',
    icon: MessageSquare,
    description: 'Natural language query → chart',
    component: AskAI,
  },
  {
    id: 'agent-mining',
    label: 'Agent Mining',
    icon: Bot,
    description: 'Classify resources as bot vs human',
    component: AgentMining,
  },
  {
    id: 'calendar-heatmap',
    label: 'Calendar',
    icon: CalendarDays,
    description: 'Activity by day of week × hour',
    component: CalendarHeatmap,
  },
  {
    id: 'sql-sandbox',
    label: 'SQL Sandbox',
    icon: Database,
    description: 'Run SELECT queries on the log',
    component: SqlSandbox,
  },
];

export default function AnalysisHub({ eventLogId, initialAnalysisId }: AnalysisHubProps) {
  const [selected, setSelected] = useState(() => {
    if (initialAnalysisId && ANALYSIS_ITEMS.some((i) => i.id === initialAnalysisId)) {
      return initialAnalysisId;
    }
    return ANALYSIS_ITEMS[0].id;
  });

  // Sync selection when the URL param changes after mount.
  useEffect(() => {
    if (initialAnalysisId && ANALYSIS_ITEMS.some((i) => i.id === initialAnalysisId)) {
      setSelected(initialAnalysisId);
    }
  }, [initialAnalysisId]);

  const active = ANALYSIS_ITEMS.find((a) => a.id === selected) ?? ANALYSIS_ITEMS[0];
  const ActiveComponent = active.component;

  return (
    <div className="mt-3 flex flex-1 flex-col md:flex-row gap-3 overflow-hidden">
      {/* Sidebar */}
      <div className="w-full md:w-48 shrink-0 overflow-x-auto md:overflow-y-auto rounded-lg border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Analysis Types</p>
        </div>
        {/*
          On small screens this nav scrolls horizontally. The fade-mask on the
          right edge is a scroll affordance — it hints that more analysis types
          exist past the visible edge. The mask is removed at md: where the nav
          becomes a full vertical sidebar with no horizontal overflow.
        */}
        <nav
          className="py-1 flex md:flex-col overflow-x-auto md:overflow-x-visible [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] md:[mask-image:none]"
        >
          {ANALYSIS_ITEMS.map((item) => {
            const isActive = item.id === selected;
            return (
              <button
                key={item.id}
                onClick={() => setSelected(item.id)}
                className={clsx(
                  'flex shrink-0 items-center gap-2.5 px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                )}
                title={item.description}
              >
                <item.icon size={13} className={isActive ? 'text-accent' : 'text-fg-faint'} />
                <span className="text-[11px] font-medium leading-tight whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-1">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <active.icon size={14} className="text-accent" />
          <div>
            <h2 className="text-[13px] font-semibold text-fg">{active.label}</h2>
            <p className="text-[10px] text-fg-faint">{active.description}</p>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4">
          <ActiveComponent key={`${active.id}-${eventLogId}`} eventLogId={eventLogId} />
        </div>
      </div>
    </div>
  );
}
