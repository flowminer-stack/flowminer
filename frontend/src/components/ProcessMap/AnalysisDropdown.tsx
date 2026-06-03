import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Search,
  ChevronDown,
  ScatterChart,
  Network,
  Repeat,
  GitCompareArrows,
  FlaskConical,
  Leaf,
  Film,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { ANALYSIS_ITEMS } from '@/components/AnalysisHub/AnalysisHub';

type AnalysisItem = {
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
};

type AnalysisGroup = {
  label: string;
  items: AnalysisItem[];
};

const analysisGroups: AnalysisGroup[] = [
  {
    label: 'Performance',
    items: [
      { label: 'Bottlenecks', description: 'Slowest activities & queues', icon: AlertTriangle, path: 'bottlenecks' },
      { label: 'Concept Drift', description: 'Detect process behavioural shifts', icon: TrendingUp, path: 'drift' },
      { label: 'Rework', description: 'Repeated activities per case', icon: Repeat, path: 'rework' },
      { label: 'Root Cause', description: 'Attributes driving slow cases', icon: Search, path: 'root-cause' },
    ],
  },
  {
    label: 'Behavior',
    items: [
      { label: 'Variants', description: 'Unique process paths', icon: GitBranch, path: 'variants' },
      { label: 'Conformance', description: 'Fitness & precision checks', icon: CheckCircle2, path: 'conformance' },
      { label: 'Dotted Chart', description: 'Events plotted over time', icon: ScatterChart, path: 'dotted-chart' },
    ],
  },
  {
    label: 'Organization',
    items: [
      { label: 'Social Network', description: 'Resource handover graph', icon: Network, path: 'social-network' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Simulate', description: 'What-if modifications', icon: FlaskConical, path: 'simulate' },
      { label: 'Animation', description: 'Replay cases on the map', icon: Film, path: 'animation' },
      { label: 'Compare', description: 'Diff two time periods', icon: GitCompareArrows, path: 'comparison' },
      { label: 'Sustainability', description: 'CO₂ & ESG footprint', icon: Leaf, path: 'sustainability' },
    ],
  },
];

interface AnalysisDropdownProps {
  eventLogId: string;
}

/* ── Deep Analyses dropdown ───────────────────────────────────────────── */

export default function AnalysisDropdown({ eventLogId }: AnalysisDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all duration-100',
          open
            ? 'bg-accent/10 text-accent'
            : 'btn-secondary',
        )}
      >
        <BarChart3 size={13} />
        Deep analyses
        <ChevronDown size={11} className={clsx('transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[780px] max-w-[calc(100vw-2rem)] animate-fade-in rounded-xl border border-line bg-surface-2 p-3 z-50"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="grid grid-cols-3 gap-3">
            {/* Left two-thirds: standalone analyses */}
            <div className="col-span-2">
              <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                Standalone analyses
              </p>
              <div className="grid grid-cols-2 gap-3">
                {analysisGroups.map((group) => (
                  <div key={group.label}>
                    <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                      {group.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((item) => (
                        <Link
                          key={item.path}
                          to={`/${item.path}/${eventLogId}`}
                          onClick={() => setOpen(false)}
                          className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-tint"
                        >
                          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10">
                            <item.icon size={12} className="text-accent" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-semibold text-fg leading-tight">{item.label}</p>
                            <p className="mt-0.5 text-[11px] text-fg-muted leading-tight">{item.description}</p>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right third: AnalysisHub subviews */}
            <div className="border-l border-line pl-3">
              <p className="px-1 pb-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                In Analysis Hub
              </p>
              <div className="max-h-[420px] overflow-y-auto space-y-0.5">
                {ANALYSIS_ITEMS.map((item) => (
                  <Link
                    key={item.id}
                    to={`/process/${eventLogId}?tab=analysis&analysis=${item.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-tint"
                  >
                    <item.icon size={12} className="mt-0.5 shrink-0 text-fg-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-fg leading-tight">{item.label}</p>
                      <p className="mt-0.5 text-[10px] text-fg-faint leading-tight line-clamp-1">
                        {item.description}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
