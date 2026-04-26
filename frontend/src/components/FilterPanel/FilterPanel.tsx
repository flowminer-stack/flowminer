import React, { useState, useMemo } from 'react';
import { SlidersHorizontal, ChevronDown, ChevronUp, Activity, Zap, MapPin, X } from 'lucide-react';
import clsx from 'clsx';
import type { DiscoveryResponse } from '@/types';

// ─── Props ────────────────────────────────────────────────────────────────────

interface FilterPanelProps {
  discovery: DiscoveryResponse | null;
  onComplexityChange?: (value: number) => void;
  complexity?: number;
  onNodeFilter?: (nodeIds: string[]) => void;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

const Section: React.FC<SectionProps> = ({
  title,
  icon,
  children,
  defaultOpen = true,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-line last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-tint/30"
      >
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          {icon}
          {title}
        </span>
        {open ? (
          <ChevronUp size={12} className="text-fg-faint" />
        ) : (
          <ChevronDown size={12} className="text-fg-faint" />
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const FilterPanel: React.FC<FilterPanelProps> = ({
  discovery,
  onComplexityChange: _onComplexityChange,
  complexity: _complexity,
  onNodeFilter,
}) => {
  // Activity visibility state
  const allActivities = useMemo(
    () => discovery?.nodes.map((n) => n.id) ?? [],
    [discovery],
  );

  const [hiddenActivities, setHiddenActivities] = useState<Set<string>>(
    new Set(),
  );
  const [hideSlowPaths, setHideSlowPaths] = useState(false);
  const [startFilter, setStartFilter] = useState<string>('');
  const [endFilter, setEndFilter] = useState<string>('');

  const startActivities = useMemo(
    () => discovery?.nodes.filter((n) => n.is_start).map((n) => n.id) ?? [],
    [discovery],
  );
  const endActivities = useMemo(
    () => discovery?.nodes.filter((n) => n.is_end).map((n) => n.id) ?? [],
    [discovery],
  );

  // Derive visible node IDs from all filter states and emit upward
  const computeVisibleNodes = (
    hidden: Set<string>,
    start: string,
    end: string,
  ) => {
    if (!onNodeFilter) return;
    let visible = allActivities.filter((id) => !hidden.has(id));
    if (start) visible = visible.filter((id) => !startActivities.includes(id) || id === start);
    if (end) visible = visible.filter((id) => !endActivities.includes(id) || id === end);
    onNodeFilter(visible);
  };

  const toggleActivity = (id: string) => {
    setHiddenActivities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      computeVisibleNodes(next, startFilter, endFilter);
      return next;
    });
  };

  const handleStartFilter = (val: string) => {
    setStartFilter(val);
    computeVisibleNodes(hiddenActivities, val, endFilter);
  };

  const handleEndFilter = (val: string) => {
    setEndFilter(val);
    computeVisibleNodes(hiddenActivities, startFilter, val);
  };

  const clearAll = () => {
    setHiddenActivities(new Set());
    setHideSlowPaths(false);
    setStartFilter('');
    setEndFilter('');
    if (onNodeFilter) onNodeFilter(allActivities);
  };

  const hasActiveFilters =
    hiddenActivities.size > 0 || hideSlowPaths || startFilter || endFilter;

  if (!discovery) {
    return (
      <div className="flex h-full flex-col rounded-lg border border-line bg-surface-2 p-4">
        <p className="text-[11px] text-fg-faint">
          Run discovery to enable filters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface-2">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2.5">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-secondary">
          <SlidersHorizontal size={13} />
          Filters
        </h3>
        {hasActiveFilters && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-tint hover:text-fg"
            title="Clear all filters"
          >
            <X size={10} />
            Clear
          </button>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* Activities */}
        <Section
          title="Activities"
          icon={<Activity size={11} />}
          defaultOpen
        >
          <div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
            {discovery.nodes.map((node) => {
              const hidden = hiddenActivities.has(node.id);
              return (
                <label
                  key={node.id}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                    'hover:bg-tint/40',
                    hidden && 'opacity-40',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => toggleActivity(node.id)}
                    className="h-3 w-3 rounded border-line bg-surface-1 accent-accent"
                  />
                  <span className="flex-1 truncate text-[11px] text-fg-secondary">
                    {node.label}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-fg-faint">
                    {node.frequency.toLocaleString()}
                  </span>
                </label>
              );
            })}
          </div>

          {/* Select all / none */}
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                setHiddenActivities(new Set());
                if (onNodeFilter) onNodeFilter(allActivities);
              }}
              className="text-[10px] text-accent hover:underline"
            >
              All
            </button>
            <span className="text-[10px] text-fg-faint">·</span>
            <button
              onClick={() => {
                setHiddenActivities(new Set(allActivities));
                if (onNodeFilter) onNodeFilter([]);
              }}
              className="text-[10px] text-fg-muted hover:text-fg hover:underline"
            >
              None
            </button>
          </div>
        </Section>

        {/* Performance */}
        <Section
          title="Performance"
          icon={<Zap size={11} />}
          defaultOpen={false}
        >
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-tint/40">
            <div className="relative">
              <input
                type="checkbox"
                checked={hideSlowPaths}
                onChange={(e) => setHideSlowPaths(e.target.checked)}
                className="peer h-3.5 w-3.5 rounded border-line bg-surface-1 accent-accent"
              />
            </div>
            <div>
              <p className="text-[11px] font-medium text-fg-secondary">
                Show only slow paths
              </p>
              <p className="text-[10px] text-fg-faint">
                Hides green-colored (fast) edges
              </p>
            </div>
          </label>
        </Section>

        {/* Endpoints */}
        <Section
          title="Endpoints"
          icon={<MapPin size={11} />}
          defaultOpen={false}
        >
          <div className="space-y-2.5">
            <div>
              <label className="mb-1 block text-[10px] text-fg-faint">
                Start Activity
              </label>
              <select
                value={startFilter}
                onChange={(e) => handleStartFilter(e.target.value)}
                className="w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-[11px] text-fg-secondary outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
              >
                <option value="">Any</option>
                {startActivities.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-fg-faint">
                End Activity
              </label>
              <select
                value={endFilter}
                onChange={(e) => handleEndFilter(e.target.value)}
                className="w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-[11px] text-fg-secondary outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
              >
                <option value="">Any</option>
                {endActivities.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Section>
      </div>

      {/* Active filter summary */}
      {hasActiveFilters && (
        <div className="shrink-0 border-t border-line px-3 py-2">
          <p className="text-[10px] text-fg-muted">
            {hiddenActivities.size > 0 && (
              <span className="mr-2">
                {hiddenActivities.size} activit{hiddenActivities.size === 1 ? 'y' : 'ies'} hidden
              </span>
            )}
            {hideSlowPaths && <span className="mr-2">slow paths only</span>}
            {(startFilter || endFilter) && (
              <span>
                {startFilter && `from ${startFilter}`}
                {startFilter && endFilter && ' → '}
                {endFilter && `to ${endFilter}`}
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
};

export default FilterPanel;
