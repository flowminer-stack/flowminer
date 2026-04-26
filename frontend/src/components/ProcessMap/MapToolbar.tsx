import { useMemo, useState } from 'react';
import { Eye, EyeOff, Percent, Hash, Flame, Search, X } from 'lucide-react';
import clsx from 'clsx';
import type { ProcessNode } from '@/types';

// Toolbar rendered above the process map that controls display modes
// users expect from every polished PM tool:
//
//   - Label mode: absolute vs relative frequencies (Disco)
//   - Highlight slow: paint nodes above median dwell, grey the rest (Disco)
//   - Hide-events panel: per-activity show/hide with search (Celonis)

interface MapToolbarProps {
  nodes: ProcessNode[];
  labelMode: 'absolute' | 'relative';
  setLabelMode: (m: 'absolute' | 'relative') => void;
  highlightSlow: boolean;
  setHighlightSlow: (v: boolean) => void;
  hiddenActivities: Set<string>;
  setHiddenActivities: (s: Set<string>) => void;
}

export default function MapToolbar({
  nodes,
  labelMode,
  setLabelMode,
  highlightSlow,
  setHighlightSlow,
  hiddenActivities,
  setHiddenActivities,
}: MapToolbarProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState('');

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => b.frequency - a.frequency),
    [nodes],
  );

  const filtered = useMemo(() => {
    if (!query) return sortedNodes;
    const q = query.toLowerCase();
    return sortedNodes.filter((n) => n.label.toLowerCase().includes(q));
  }, [sortedNodes, query]);

  const toggleNode = (id: string) => {
    const next = new Set(hiddenActivities);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHiddenActivities(next);
  };
  const hideAllVisible = () => {
    const next = new Set(hiddenActivities);
    for (const n of filtered) next.add(n.id);
    setHiddenActivities(next);
  };
  const showAll = () => setHiddenActivities(new Set());

  return (
    <div className="relative flex items-center gap-1.5">
      {/* Absolute ↔ relative frequency toggle */}
      <div className="flex items-center gap-px rounded-md border border-line bg-surface-1 p-0.5">
        <button
          type="button"
          onClick={() => setLabelMode('absolute')}
          className={clsx(
            'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
            labelMode === 'absolute'
              ? 'bg-accent text-white'
              : 'text-fg-muted hover:text-fg',
          )}
          title="Show absolute counts"
        >
          <Hash size={10} />
          abs
        </button>
        <button
          type="button"
          onClick={() => setLabelMode('relative')}
          className={clsx(
            'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
            labelMode === 'relative'
              ? 'bg-accent text-white'
              : 'text-fg-muted hover:text-fg',
          )}
          title="Show percentages"
        >
          <Percent size={10} />
          %
        </button>
      </div>

      {/* Highlight slow toggle */}
      <button
        type="button"
        onClick={() => setHighlightSlow(!highlightSlow)}
        className={clsx(
          'flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
          highlightSlow
            ? 'border-warning bg-warning/10 text-warning'
            : 'border-line bg-surface-1 text-fg-muted hover:text-fg',
        )}
        title="Highlight activities slower than the median"
      >
        <Flame size={10} />
        slow
      </button>

      {/* Hide-events panel trigger */}
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        className={clsx(
          'flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors',
          hiddenActivities.size > 0
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-line bg-surface-1 text-fg-muted hover:text-fg',
        )}
        title="Hide individual activities from the map"
      >
        {hiddenActivities.size > 0 ? <EyeOff size={10} /> : <Eye size={10} />}
        hide {hiddenActivities.size > 0 && `(${hiddenActivities.size})`}
      </button>

      {/* Hide-events dropdown panel */}
      {panelOpen && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setPanelOpen(false)}
          />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-[260px] overflow-hidden rounded-lg border border-line bg-surface-0 shadow-xl">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search size={11} className="text-fg-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search activities…"
                className="flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-fg-ghost"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-fg-faint hover:text-fg"
                >
                  <X size={10} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[10px]">
              <button
                type="button"
                onClick={hideAllVisible}
                className="rounded px-1.5 py-0.5 font-medium text-fg-muted hover:bg-tint hover:text-fg"
              >
                Hide visible
              </button>
              <button
                type="button"
                onClick={showAll}
                className="rounded px-1.5 py-0.5 font-medium text-fg-muted hover:bg-tint hover:text-fg"
              >
                Show all
              </button>
              <span className="ml-auto text-fg-faint">
                {filtered.length} / {nodes.length}
              </span>
            </div>
            <div className="max-h-[calc(60vh-80px)] overflow-y-auto py-1">
              {filtered.map((n) => {
                const hidden = hiddenActivities.has(n.id);
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => toggleNode(n.id)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors hover:bg-tint"
                  >
                    {hidden ? (
                      <EyeOff size={10} className="shrink-0 text-fg-ghost" />
                    ) : (
                      <Eye size={10} className="shrink-0 text-fg-muted" />
                    )}
                    <span
                      className={clsx(
                        'flex-1 truncate',
                        hidden ? 'text-fg-ghost line-through' : 'text-fg',
                      )}
                    >
                      {n.label}
                    </span>
                    <span className="tabular-nums text-[10px] text-fg-faint">
                      {n.frequency}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
