import { useEffect, useRef } from 'react';
import { Filter, FilterX, Target, Info, Grid3x3 } from 'lucide-react';
import type { ProcessNode } from '@/types';

// Right-click context menu (Signavio / UiPath). Rendered as a floating
// overlay positioned at the click pixel coordinates. The parent hands
// it `node` and dismisses it by setting state to null.

interface NodeContextMenuProps {
  node: ProcessNode;
  pos: { x: number; y: number };
  onClose: () => void;
  onIncludeActivity: (activity: string) => void;
  onExcludeActivity: (activity: string) => void;
  onFocusActivity: (activity: string) => void;
  onShowDetails: (node: ProcessNode) => void;
  onShowTreemap?: (activity: string) => void;
}

export default function NodeContextMenu({
  node,
  pos,
  onClose,
  onIncludeActivity,
  onExcludeActivity,
  onFocusActivity,
  onShowDetails,
  onShowTreemap,
}: NodeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      onClick={() => {
        onClick();
        onClose();
      }}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-tint ${
        danger ? 'text-danger hover:text-danger' : 'text-fg-secondary hover:text-fg'
      }`}
    >
      <span className="text-fg-muted">{icon}</span>
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 overflow-hidden rounded-lg border border-line bg-surface-0 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="border-b border-line px-3 py-2">
        <p className="truncate text-[11px] font-semibold text-fg" title={node.label}>
          {node.label}
        </p>
        <p className="text-[10px] text-fg-faint">
          {node.frequency.toLocaleString()} events
        </p>
      </div>
      <div className="py-1">
        {item(
          <Filter size={11} />,
          'Include cases with this activity',
          () => onIncludeActivity(node.label),
        )}
        {item(
          <FilterX size={11} />,
          'Exclude cases with this activity',
          () => onExcludeActivity(node.label),
        )}
        {item(
          <Target size={11} />,
          'Focus — make this the start of analysis',
          () => onFocusActivity(node.label),
        )}
        {onShowTreemap &&
          item(
            <Grid3x3 size={11} />,
            'Break down by attribute',
            () => onShowTreemap(node.label),
          )}
        {item(<Info size={11} />, 'View activity details', () => onShowDetails(node))}
      </div>
    </div>
  );
}
