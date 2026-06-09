import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Star,
  Lock,
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
import { useEventLogData } from '@/hooks/useProcessMining';
import { getAnalysisHints } from '@/utils/analysisHints';

interface AnalysisHubProps {
  eventLogId: string;
  initialAnalysisId?: string;
}

// Intent-first groups, matching the analysis palette's taxonomy. Ordered.
export const HUB_GROUP_ORDER = [
  'Performance',
  'Conformance',
  'Behavior & Variants',
  'Organization',
  'Advanced & Data',
] as const;

type HubGroup = (typeof HUB_GROUP_ORDER)[number];

interface AnalysisItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Outcome-first copy: "see / find / spot …", not the algorithm name. */
  description: string;
  /** Search aliases: the words users actually type (jargon, synonyms, tool names). */
  keywords?: string[];
  /** Intent group the item is filed under in the hub + palette. */
  group: HubGroup;
  /** A good first analysis to try — flagged with a "Start here" star. */
  recommended?: boolean;
  component: React.ComponentType<{ eventLogId: string }>;
}

export const ANALYSIS_ITEMS: AnalysisItem[] = [
  {
    id: 'performance-dfg',
    label: 'Performance Map',
    icon: Timer,
    description: 'See average wait + service time on every step and hand-off',
    keywords: ['slow', 'wait', 'duration', 'cycle time', 'dfg'],
    group: 'Performance',
    recommended: true,
    component: PerformanceDFG,
  },
  {
    id: 'temporal-profile',
    label: 'Temporal Profile',
    icon: Clock,
    description: 'Find hand-offs with unusually variable timing',
    keywords: ['variance', 'deviation', 'outlier', 'timing'],
    group: 'Performance',
    component: TemporalProfile,
  },
  {
    id: 'spectrum',
    label: 'Perf Spectrum',
    icon: Activity,
    description: 'Per-case timeline (Gantt) to see where time goes',
    keywords: ['gantt', 'timeline', 'spectrum'],
    group: 'Performance',
    component: PerformanceSpectrum,
  },
  {
    id: 'case-overlap',
    label: 'Case Overlap',
    icon: BarChart3,
    description: 'See how many cases run at once over time (load)',
    keywords: ['load', 'wip', 'concurrency', 'work in progress'],
    group: 'Performance',
    component: CaseOverlap,
  },
  {
    id: 'batch-detection',
    label: 'Batch Detection',
    icon: Layers,
    description: 'Spot work that piles up and is handled in batches',
    keywords: ['batching', 'queue', 'pile up'],
    group: 'Performance',
    component: BatchDetection,
  },
  {
    id: 'calendar-heatmap',
    label: 'Calendar',
    icon: CalendarDays,
    description: 'See activity volume by weekday × hour',
    keywords: ['heatmap', 'weekday', 'hour', 'busy', 'workload'],
    group: 'Performance',
    component: CalendarHeatmap,
  },
  {
    id: 'timed-compliance',
    label: 'SLA / Timed Compliance',
    icon: ShieldCheck,
    description: 'Check no-code SLA & timing rules — no model needed',
    keywords: ['sla', 'deadline', 'compliance', 'rules'],
    group: 'Conformance',
    component: ComplianceDashboard,
  },
  {
    id: 'declare',
    label: 'DECLARE Rules',
    icon: FileCheck,
    description: 'Auto-discover the business rules the process follows',
    keywords: ['constraints', 'rules', 'declarative'],
    group: 'Conformance',
    component: DeclareRules,
  },
  {
    id: 'log-skeleton',
    label: 'Log Skeleton',
    icon: Bone,
    description: 'Find the always / never ordering rules your process obeys',
    keywords: ['ordering', 'always', 'never', 'invariants'],
    group: 'Conformance',
    component: LogSkeleton,
  },
  {
    id: 'four-eyes',
    label: 'Four-Eyes',
    icon: Eye,
    description: 'Flag cases where one person both did and approved a step',
    keywords: ['segregation of duties', 'fraud', 'approval', 'audit'],
    group: 'Conformance',
    component: FourEyes,
  },
  {
    id: 'efg',
    label: 'Eventually-Follows',
    icon: GitFork,
    description: 'See which activities eventually follow which, even far apart',
    keywords: ['order', 'precedence', 'follows'],
    group: 'Behavior & Variants',
    component: EventuallyFollowsGraph,
  },
  {
    id: 'clustering',
    label: 'Case Clusters',
    icon: PieChart,
    description: 'Group similar cases to surface structural variants',
    keywords: ['segments', 'groups', 'similar', 'clusters'],
    group: 'Behavior & Variants',
    component: CaseClustering,
  },
  {
    id: 'org-roles',
    label: 'Org Roles',
    icon: Users,
    description: 'Discover the roles your resources actually play',
    keywords: ['teams', 'staff', 'people', 'who'],
    group: 'Organization',
    component: OrgRoles,
  },
  {
    id: 'sna',
    label: 'SNA Networks',
    icon: Network,
    description: 'See who hands work to whom, and where it stalls',
    keywords: ['handover', 'handoff', 'social network', 'collaboration'],
    group: 'Organization',
    component: SNAView,
  },
  {
    id: 'agent-mining',
    label: 'Agent Mining',
    icon: Bot,
    description: 'Tell automated (bot) work apart from human work',
    keywords: ['bots', 'rpa', 'robots', 'automation'],
    group: 'Organization',
    component: AgentMining,
  },
  {
    id: 'ask',
    label: 'Ask',
    icon: MessageSquare,
    description: 'Ask a question in plain English → get a chart',
    keywords: ['ai', 'question', 'natural language', 'chat'],
    group: 'Advanced & Data',
    recommended: true,
    component: AskAI,
  },
  {
    id: 'sql-sandbox',
    label: 'SQL Sandbox',
    icon: Database,
    description: 'Run ad-hoc SELECT queries against the log',
    keywords: ['query', 'duckdb', 'select'],
    group: 'Advanced & Data',
    component: SqlSandbox,
  },
  {
    id: 'features',
    label: 'Feature Export',
    icon: Download,
    description: 'Export a per-case feature matrix to CSV for ML / BI',
    keywords: ['csv', 'ml', 'machine learning', 'export', 'download'],
    group: 'Advanced & Data',
    component: FeatureExport,
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

  // Metadata-driven hints: which analyses are recommended for this log's shape,
  // and which can't run yet (e.g. no resource column) — the "Show Me" pattern.
  const { eventLog } = useEventLogData(eventLogId);
  const hints = useMemo(() => getAnalysisHints(eventLog), [eventLog]);

  const active = ANALYSIS_ITEMS.find((a) => a.id === selected) ?? ANALYSIS_ITEMS[0];
  const ActiveComponent = active.component;
  const activeBlocked = hints.disabledReason(active.id);
  const navigate = useNavigate();

  return (
    <div className="mt-3 flex flex-1 flex-col md:flex-row gap-3 overflow-hidden">
      {/* Sidebar — analyses grouped by intent (mirrors the ⌘K palette). */}
      <div className="w-full md:w-48 shrink-0 max-h-56 md:max-h-none overflow-y-auto rounded-lg border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Analyses</p>
        </div>
        <nav className="py-1.5">
          {HUB_GROUP_ORDER.map((group) => {
            const items = ANALYSIS_ITEMS.filter((i) => i.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-1.5 last:mb-0">
                <p className="px-3 pb-0.5 pt-1.5 text-[9px] font-bold uppercase tracking-widest text-fg-faint">
                  {group}
                </p>
                {items.map((item) => {
                  const isActive = item.id === selected;
                  const blockedReason = hints.disabledReason(item.id);
                  const recommended = item.recommended || hints.isRecommended(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelected(item.id)}
                      className={clsx(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                        isActive
                          ? 'bg-accent/10 text-accent'
                          : 'text-fg-muted hover:bg-tint hover:text-fg-secondary',
                        blockedReason && !isActive && 'opacity-45',
                      )}
                      title={blockedReason ?? item.description}
                    >
                      <item.icon
                        size={13}
                        className={clsx('shrink-0', isActive ? 'text-accent' : 'text-fg-faint')}
                      />
                      <span className="flex-1 text-[11px] font-medium leading-tight">{item.label}</span>
                      {blockedReason ? (
                        <Lock size={10} className="shrink-0 text-fg-faint" aria-label={blockedReason} />
                      ) : (
                        recommended && (
                          <Star
                            size={10}
                            className="shrink-0 text-accent"
                            aria-label="Recommended starting point"
                          />
                        )
                      )}
                    </button>
                  );
                })}
              </div>
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

        {/* Scrollable content. A blocked analysis renders guidance instead of
            an empty/broken result — the lock should explain how to unlock. */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeBlocked ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-sm text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
                  <Lock size={17} />
                </div>
                <p className="text-[13px] font-semibold text-fg">{activeBlocked}</p>
                <p className="mx-auto mt-1.5 text-[11.5px] leading-relaxed text-fg-muted">
                  Column mapping is set when a log is imported. Re-upload this log (or
                  rebuild it in the Log Builder) and map the missing column to unlock{' '}
                  {active.label}.
                </p>
                {eventLog && (
                  <button
                    onClick={() => navigate(`/upload/${eventLog.project_id}`)}
                    className="btn-secondary mx-auto mt-3 text-[12px]"
                  >
                    Re-upload with mapping
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ActiveComponent key={`${active.id}-${eventLogId}`} eventLogId={eventLogId} />
          )}
        </div>
      </div>
    </div>
  );
}
