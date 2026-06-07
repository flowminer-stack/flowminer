import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Search,
  ScatterChart,
  Network,
  Repeat,
  GitCompareArrows,
  FlaskConical,
  Leaf,
  Film,
  TrendingUp,
  Bot,
  Workflow,
  Radio,
  Building2,
  HeartPulse,
  ShieldAlert,
  Share2,
  Command,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { ANALYSIS_ITEMS } from '@/components/AnalysisHub/AnalysisHub';

/* ── Unified Analysis Palette ─────────────────────────────────────────────
 * Replaces the old "Deep Analyses" dropdown + "Analysis Hub" launcher with a
 * single searchable command-palette. EVERY analysis from both catalogs is
 * present here:
 *   - kind: 'page' → full-page route  /${path}/${eventLogId}
 *   - kind: 'hub'  → in-page tab       /process/${eventLogId}?tab=analysis&analysis=${id}
 * Destinations are byte-for-byte identical to the retired dropdown so no route
 * or deep-link behaviour changes.
 */

type PaletteItem = {
  /** Stable react key (path for pages, id for hub items). */
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
} & (
  | { kind: 'page'; path: string }
  | { kind: 'hub'; id: string }
);

type PaletteGroup = {
  label: string;
  items: PaletteItem[];
};

// Quick lookup of the hub catalog so each grouped reference keeps its own
// icon/label/description from AnalysisHub (single source of truth).
const HUB_BY_ID = Object.fromEntries(ANALYSIS_ITEMS.map((i) => [i.id, i]));

/** Build a 'hub' palette item from an ANALYSIS_ITEMS id (preserves icon/copy). */
function hub(id: string): PaletteItem {
  const src = HUB_BY_ID[id];
  return {
    kind: 'hub',
    key: id,
    id,
    label: src.label,
    description: src.description,
    icon: src.icon,
  };
}

/** Build a 'page' palette item (full-page navigated analysis). */
function page(path: string, label: string, description: string, icon: LucideIcon): PaletteItem {
  return { kind: 'page', key: path, path, label, description, icon };
}

// Intent-first groups. Every full-page analysis AND every hub item is reachable.
const PALETTE_GROUPS: PaletteGroup[] = [
  {
    label: 'Performance',
    items: [
      page('bottlenecks', 'Bottlenecks', 'Slowest activities & queues', AlertTriangle),
      page('rework', 'Rework', 'Repeated activities per case', Repeat),
      page('root-cause', 'Root Cause', 'Attributes driving slow cases', Search),
      hub('performance-dfg'),
      hub('temporal-profile'),
      hub('spectrum'),
      hub('case-overlap'),
      hub('batch-detection'),
      hub('calendar-heatmap'),
    ],
  },
  {
    label: 'Conformance',
    items: [
      page('conformance', 'Conformance', 'Fitness & precision checks', CheckCircle2),
      hub('timed-compliance'),
      hub('declare'),
      hub('log-skeleton'),
      hub('four-eyes'),
    ],
  },
  {
    label: 'Behavior & Variants',
    items: [
      page('variants', 'Variants', 'Unique process paths', GitBranch),
      page('drift', 'Concept Drift', 'Detect process behavioural shifts', TrendingUp),
      page('dotted-chart', 'Dotted Chart', 'Events plotted over time', ScatterChart),
      page('comparison', 'Compare', 'Diff two time periods', GitCompareArrows),
      page('animation', 'Animation', 'Replay cases on the map', Film),
      page('pulse', 'Live Pulse', 'Watch cases flow through the map', Radio),
      hub('efg'),
      hub('clustering'),
    ],
  },
  {
    label: 'Organization',
    items: [
      page('social-network', 'Social Network', 'Resource handover graph', Network),
      hub('org-roles'),
      hub('sna'),
      hub('agent-mining'),
    ],
  },
  {
    label: 'Value & Prediction',
    items: [
      page('health', 'Process Health', 'One composite health score', HeartPulse),
      page('cases-at-risk', 'Cases at Risk', 'Predicted SLA breaches, live', ShieldAlert),
      page('automation-roi', 'Automation ROI', 'Where automation pays off, in $', Bot),
      page('causal-map', 'Causal Map', 'What actually causes slowdowns', Workflow),
      page('simulate', 'Simulate', 'What-if modifications', FlaskConical),
      page('sustainability', 'Sustainability', 'CO₂ & ESG footprint', Leaf),
    ],
  },
  {
    label: 'Object-Centric',
    items: [
      page('process-city', 'Process City', 'Your process as a 3D city', Building2),
    ],
  },
  {
    label: 'Advanced & Data',
    items: [
      page('lineage', 'Data Lineage', 'What depends on this log', Share2),
      hub('features'),
      hub('sql-sandbox'),
      hub('ask'),
    ],
  },
];

// Dev-time guard: every catalog item must appear exactly once so a future
// addition to either source can't silently drop out of the palette.
if (import.meta.env?.DEV) {
  const referenced = new Set(
    PALETTE_GROUPS.flatMap((g) => g.items).filter((i) => i.kind === 'hub').map((i) => i.key),
  );
  const missing = ANALYSIS_ITEMS.filter((i) => !referenced.has(i.id)).map((i) => i.id);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn('[AnalysisPalette] hub items not surfaced:', missing);
  }
}

interface AnalysisPaletteProps {
  eventLogId: string;
}

export default function AnalysisPalette({ eventLogId }: AnalysisPaletteProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  // Global ⌘K / Ctrl-K opens the palette from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        // Don't hijack ⌘K while the user is typing in a field.
        const t = e.target as HTMLElement | null;
        if (
          t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT' ||
            t.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Esc closes; lock body scroll; restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    requestAnimationFrame(() => inputRef.current?.focus());

    const previous = previouslyFocused.current;
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      if (previous && document.body.contains(previous)) previous.focus();
    };
  }, [open]);

  // Reset the query each time the palette opens so it always starts fresh.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTE_GROUPS;
    return PALETTE_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.label.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const go = (item: PaletteItem) => {
    setOpen(false);
    if (item.kind === 'page') {
      navigate(`/${item.path}/${eventLogId}`);
    } else {
      navigate(`/process/${eventLogId}?tab=analysis&analysis=${item.id}`);
    }
  };

  return (
    <>
      {/* Trigger — replaces the old "Deep analyses" dropdown launcher. */}
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary text-[12px]"
        title="Open the analysis palette (⌘K / Ctrl-K)"
        data-tour="analysis-palette"
      >
        <BarChart3 size={13} />
        Analyze
        <kbd className="ml-1 hidden items-center gap-0.5 rounded border border-line bg-surface-1 px-1 py-px text-[9px] font-medium text-fg-faint sm:inline-flex">
          {isMac ? <Command size={9} /> : 'Ctrl'}K
        </kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
          <div
            className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Analysis palette"
            className="relative flex max-h-[76vh] w-full max-w-2xl animate-slide-up flex-col overflow-hidden rounded-2xl border border-line bg-surface-2"
            style={{ boxShadow: 'var(--shadow-xl)' }}
          >
            {/* Search */}
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
              <Search size={15} className="shrink-0 text-fg-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search analyses…"
                className="flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-faint focus:outline-none"
              />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close palette"
                className="rounded-lg p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {/* Results */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {filteredGroups.length === 0 ? (
                <div className="px-3 py-10 text-center">
                  <p className="text-[12px] text-fg-muted">No analyses match “{query}”.</p>
                </div>
              ) : (
                filteredGroups.map((group) => (
                  <div key={group.label} className="mb-1.5 last:mb-0">
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                      {group.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((item) => (
                        <button
                          key={`${item.kind}-${item.key}`}
                          onClick={() => go(item)}
                          className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-tint"
                        >
                          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10">
                            <item.icon size={12} className="text-accent" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] font-semibold leading-tight text-fg">
                              {item.label}
                            </p>
                            <p className="mt-0.5 line-clamp-1 text-[11px] leading-tight text-fg-muted">
                              {item.description}
                            </p>
                          </div>
                          <span
                            className={clsx(
                              'mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide',
                              item.kind === 'hub'
                                ? 'bg-accent/10 text-accent'
                                : 'bg-tint text-fg-faint',
                            )}
                          >
                            {item.kind === 'hub' ? 'In-page' : 'Full page'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
