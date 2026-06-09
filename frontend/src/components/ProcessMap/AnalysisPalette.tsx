import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  Gauge,
  Command,
  FolderKanban,
  Lock,
  MessageSquare,
  Star,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { ANALYSIS_ITEMS } from '@/components/AnalysisHub/AnalysisHub';
import { useUIStore } from '@/store';
import { useEventLogData } from '@/hooks/useProcessMining';
import { getActiveLogId } from '@/utils/activeLog';
import { getAnalysisHints } from '@/utils/analysisHints';
import { markOnboardingStep } from '@/utils/onboarding';

/* ── Unified Analysis Palette ─────────────────────────────────────────────
 * A single searchable command-palette (⌘K / Ctrl-K) that surfaces EVERY
 * analysis from both catalogs:
 *   - kind: 'page' → full-page route  /${path}/${eventLogId}
 *   - kind: 'hub'  → in-page tab       /process/${eventLogId}?tab=analysis&analysis=${id}
 *
 * The modal is mounted ONCE, globally, by Layout and is opened from anywhere
 * via the UI store (openPalette/togglePalette) — the sidebar search trigger,
 * the process-view toolbar button, and the active-log quick links all open
 * this same instance. The target event log is resolved from the current route
 * and falls back to the most-recently-opened log so ⌘K keeps working after the
 * user navigates away from a log-scoped page.
 */

type PaletteItem = {
  /** Stable react key (path for pages, id for hub items). */
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Search aliases: the words users actually type (jargon, synonyms). */
  keywords?: string[];
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
    keywords: src.keywords,
  };
}

/** Build a 'page' palette item (full-page navigated analysis). */
function page(
  path: string,
  label: string,
  description: string,
  icon: LucideIcon,
  keywords?: string[],
): PaletteItem {
  return { kind: 'page', key: path, path, label, description, icon, keywords };
}

// Intent-first groups. Every full-page analysis AND every hub item is reachable.
const PALETTE_GROUPS: PaletteGroup[] = [
  {
    label: 'Monitor',
    items: [
      // Mission Control has no sidebar entry of its own — registering it here is
      // the primary way it becomes discoverable from anywhere in the product.
      page('mission-control', 'Mission Control', 'Live command center: priorities, risks & ROI', Gauge, ['dashboard', 'overview', 'kpi', 'home']),
    ],
  },
  {
    label: 'Performance',
    items: [
      page('bottlenecks', 'Bottlenecks', 'Slowest activities & queues', AlertTriangle, ['slow', 'queue', 'wait', 'delay', 'stuck']),
      page('rework', 'Rework', 'Repeated activities per case', Repeat, ['loops', 'repeat', 'ping-pong', 'redo']),
      page('root-cause', 'Root Cause', 'Attributes driving slow cases', Search, ['why', 'drivers', 'correlation', 'factors']),
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
      page('conformance', 'Conformance', 'Fitness & precision checks', CheckCircle2, ['fitness', 'deviations', 'compliance', 'model', 'violations']),
      hub('timed-compliance'),
      hub('declare'),
      hub('log-skeleton'),
      hub('four-eyes'),
    ],
  },
  {
    label: 'Behavior & Variants',
    items: [
      page('variants', 'Variants', 'Unique process paths', GitBranch, ['paths', 'flows', 'sequences', 'traces']),
      page('drift', 'Concept Drift', 'Detect process behavioural shifts', TrendingUp, ['change', 'shift', 'over time']),
      page('dotted-chart', 'Dotted Chart', 'Events plotted over time', ScatterChart, ['scatter', 'events', 'timeline']),
      page('comparison', 'Compare', 'Diff two time periods', GitCompareArrows, ['diff', 'before', 'after', 'periods']),
      page('animation', 'Animation Theater', 'Full-screen replay with timeline scrubber & speed control', Film, ['replay', 'token', 'movie', 'playback']),
      page('pulse', 'Live Pulse', 'Watch cases flow through the map', Radio, ['live', 'streaming', 'real-time']),
      hub('efg'),
      hub('clustering'),
    ],
  },
  {
    label: 'Organization',
    items: [
      page('social-network', 'Social Network', 'Resource handover graph', Network, ['handover', 'handoff', 'people', 'collaboration']),
      hub('org-roles'),
      hub('sna'),
      hub('agent-mining'),
    ],
  },
  {
    label: 'Value & Prediction',
    items: [
      page('health', 'Process Health', 'One composite health score', HeartPulse, ['score', 'grade']),
      page('cases-at-risk', 'Cases at Risk', 'Predicted SLA breaches, live', ShieldAlert, ['sla', 'breach', 'prediction', 'risk', 'late']),
      page('automation-roi', 'Automation ROI', 'Where automation pays off, in $', Bot, ['savings', 'cost', 'money', 'rpa']),
      page('causal-map', 'Causal Map', 'What actually causes slowdowns', Workflow, ['causality', 'cause', 'why']),
      page('simulate', 'Simulate', 'What-if modifications', FlaskConical, ['what-if', 'scenario', 'forecast']),
      page('sustainability', 'Sustainability', 'CO₂ & ESG footprint', Leaf, ['co2', 'carbon', 'esg', 'green']),
    ],
  },
  {
    label: 'Object-Centric',
    items: [
      page('process-city', 'Process City', 'Your process as a 3D city', Building2, ['3d', 'ocel', 'object-centric']),
    ],
  },
  {
    label: 'Advanced & Data',
    items: [
      page('lineage', 'Data Lineage', 'What depends on this log', Share2, ['dependencies', 'provenance']),
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
  /**
   * Optional explicit target log. When omitted (the global mount), the log is
   * resolved from the current route and then from the last-opened log.
   */
  eventLogId?: string;
}

/**
 * Visible trigger button for the palette. Lives in the process-view toolbar
 * (and anywhere else that wants an explicit affordance). It just opens the one
 * global palette — it does not render the modal itself.
 */
export function AnalysisPaletteButton({ className }: { className?: string }) {
  const openPalette = useUIStore((s) => s.openPalette);
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return (
    <button
      onClick={openPalette}
      className={clsx('btn-secondary text-[12px]', className)}
      title="Open the analysis palette (⌘K / Ctrl-K)"
      data-tour="analysis-palette"
    >
      <BarChart3 size={13} />
      Analyze
      <kbd className="ml-1 hidden items-center gap-0.5 rounded border border-line bg-surface-1 px-1 py-px text-[9px] font-medium text-fg-faint sm:inline-flex">
        {isMac ? <Command size={9} /> : 'Ctrl'}K
      </kbd>
    </button>
  );
}

export default function AnalysisPalette({ eventLogId }: AnalysisPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const open = useUIStore((s) => s.paletteOpen);
  const togglePalette = useUIStore((s) => s.togglePalette);
  const closePalette = useUIStore((s) => s.closePalette);
  const lastEventLogId = useUIStore((s) => s.lastEventLogId);
  const setLastEventLogId = useUIStore((s) => s.setLastEventLogId);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Resolve the target log: an explicit prop wins, then the current route,
  // then the most-recently-opened log (persisted) so ⌘K still works off-route.
  const routeLogId = getActiveLogId(location.pathname);
  const targetLogId = eventLogId ?? routeLogId ?? lastEventLogId;

  // Log metadata, fetched only while the palette is open (cached per log).
  // Powers the "runs on <log>" footer and the prerequisite annotations.
  const { eventLog: targetLog } = useEventLogData(open ? targetLogId ?? undefined : undefined);
  const hints = useMemo(
    () => (targetLog && targetLog.id === targetLogId ? getAnalysisHints(targetLog) : null),
    [targetLog, targetLogId],
  );

  // Remember the active log so the palette has a target after the user
  // navigates to a non-log page (Overview, Projects, …), and tick the
  // onboarding milestones: the process map vs. a specific analysis page.
  useEffect(() => {
    if (!routeLogId) return;
    setLastEventLogId(routeLogId);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg === 'process') markOnboardingStep('map');
    else markOnboardingStep('analysis');
  }, [routeLogId, location.pathname, setLastEventLogId]);

  // Global ⌘K / Ctrl-K toggles the palette from anywhere in the app.
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
        togglePalette();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [togglePalette]);

  // Esc closes; lock body scroll; restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
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
  }, [open, closePalette]);

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
          i.label.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          (i.keywords ?? []).some((k) => k.includes(q)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  // Flat result list for keyboard navigation, plus key → flat-index lookup so
  // grouped rendering can highlight the active row.
  const flatItems = useMemo(() => filteredGroups.flatMap((g) => g.items), [filteredGroups]);
  const flatIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    flatItems.forEach((it, idx) => m.set(`${it.kind}-${it.key}`, idx));
    return m;
  }, [flatItems]);

  // Search-first Ask (ThoughtSpot pattern): any typed query can be handed to
  // the NL→chart Ask analysis as a question, so a query that matches nothing
  // is still one Enter away from an answer. Rendered as the last navigable row.
  const askQuery = query.trim();
  const showAsk = !!targetLogId && askQuery.length > 0;
  const navigableCount = flatItems.length + (showAsk ? 1 : 0);

  // Restart selection at the top whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // Keep the active row visible as the selection moves.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`palette-item-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (navigableCount === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % navigableCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + navigableCount) % navigableCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = Math.min(activeIndex, navigableCount - 1);
      if (idx >= flatItems.length) goAsk();
      else if (flatItems[idx]) go(flatItems[idx]);
    }
  };

  const goAsk = () => {
    if (!targetLogId || !askQuery) return;
    closePalette();
    markOnboardingStep('analysis');
    navigate(
      `/process/${targetLogId}?tab=analysis&analysis=ask&q=${encodeURIComponent(askQuery)}`,
    );
  };

  const go = (item: PaletteItem) => {
    if (!targetLogId) return;
    closePalette();
    markOnboardingStep('analysis');
    if (item.kind === 'page') {
      navigate(`/${item.path}/${targetLogId}`);
    } else {
      navigate(`/process/${targetLogId}?tab=analysis&analysis=${item.id}`);
    }
  };

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
          <div
            className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm"
            onClick={closePalette}
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
                onKeyDown={onInputKeyDown}
                placeholder={targetLogId ? 'Search analyses…' : 'Open an event log to analyze…'}
                disabled={!targetLogId}
                className="flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed"
              />
              <button
                onClick={closePalette}
                aria-label="Close palette"
                className="rounded-lg p-1 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {/* Results */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {!targetLogId ? (
                <div className="px-3 py-10 text-center">
                  <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-surface-3 text-fg-faint">
                    <FolderKanban size={16} />
                  </div>
                  <p className="text-[12px] font-semibold text-fg">No event log open yet</p>
                  <p className="mx-auto mt-1 max-w-xs text-[11px] text-fg-muted">
                    Pick a project and open a log, then ⌘K jumps you to any of its
                    analyses from anywhere.
                  </p>
                  <button
                    onClick={() => {
                      closePalette();
                      navigate('/projects');
                    }}
                    className="btn-primary mx-auto mt-3 text-[12px]"
                  >
                    Browse projects
                  </button>
                </div>
              ) : (
                <>
                {filteredGroups.length === 0 && !showAsk && (
                  <div className="px-3 py-10 text-center">
                    <p className="text-[12px] text-fg-muted">No analyses match “{query}”.</p>
                  </div>
                )}
                {filteredGroups.map((group) => (
                  <div key={group.label} className="mb-1.5 last:mb-0">
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-fg-faint">
                      {group.label}
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const itemKey = `${item.kind}-${item.key}`;
                        const flatIdx = flatIndexByKey.get(itemKey) ?? -1;
                        const isActive = flatIdx === activeIndex;
                        const blocked = hints?.disabledReason(
                          item.kind === 'hub' ? item.id : item.path,
                        );
                        const recommended = !blocked && hints?.isRecommended(
                          item.kind === 'hub' ? item.id : item.path,
                        );
                        return (
                          <button
                            key={itemKey}
                            id={`palette-item-${flatIdx}`}
                            onClick={() => go(item)}
                            onMouseEnter={() => setActiveIndex(flatIdx)}
                            className={clsx(
                              'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                              isActive && 'bg-tint',
                              blocked && 'opacity-60',
                            )}
                          >
                            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10">
                              <item.icon size={12} className="text-accent" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="flex items-center gap-1.5 text-[12px] font-semibold leading-tight text-fg">
                                {item.label}
                                {blocked && (
                                  <Lock size={10} className="shrink-0 text-fg-faint" aria-hidden="true" />
                                )}
                                {recommended && (
                                  <Star
                                    size={10}
                                    className="shrink-0 text-accent"
                                    aria-label="Recommended starting point"
                                  />
                                )}
                              </p>
                              <p
                                className={clsx(
                                  'mt-0.5 line-clamp-1 text-[11px] leading-tight',
                                  blocked ? 'text-warning' : 'text-fg-muted',
                                )}
                              >
                                {blocked ?? item.description}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {/* Search-first Ask: the typed query, askable as a question. */}
                {showAsk && (
                  <div className={clsx(filteredGroups.length > 0 && 'mt-1 border-t border-line pt-1.5')}>
                    {filteredGroups.length === 0 && (
                      <p className="px-2.5 pb-1 pt-2 text-[11px] text-fg-muted">
                        No analyses match — ask it as a question instead:
                      </p>
                    )}
                    <button
                      id={`palette-item-${flatItems.length}`}
                      onClick={goAsk}
                      onMouseEnter={() => setActiveIndex(flatItems.length)}
                      className={clsx(
                        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        activeIndex === flatItems.length && 'bg-tint',
                      )}
                    >
                      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10">
                        <MessageSquare size={12} className="text-accent" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold leading-tight text-fg">
                          Ask AI: “{askQuery}”
                        </p>
                        <p className="mt-0.5 line-clamp-1 text-[11px] leading-tight text-fg-muted">
                          Get an answer (and a chart) from this log in plain English
                        </p>
                      </div>
                    </button>
                  </div>
                )}
                </>
              )}
            </div>

            {/* Footer: keyboard legend + which log results will open in. The
                log matters when ⌘K is pressed off a log route — the palette
                falls back to the last-opened log, and that should be visible,
                not silent. */}
            {targetLogId && (
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2">
                <p className="shrink-0 text-[10px] text-fg-faint">
                  <kbd className="rounded border border-line bg-surface-1 px-1 py-px">↑↓</kbd> navigate
                  {'  '}
                  <kbd className="rounded border border-line bg-surface-1 px-1 py-px">↵</kbd> open
                  {'  '}
                  <kbd className="rounded border border-line bg-surface-1 px-1 py-px">esc</kbd> close
                </p>
                {targetLog && targetLog.id === targetLogId && (
                  <p className="truncate text-[10px] text-fg-faint">
                    Opens in{' '}
                    <span className="font-semibold text-fg-muted">{targetLog.name}</span>
                    {!eventLogId && !routeLogId && ' (last opened log)'}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
