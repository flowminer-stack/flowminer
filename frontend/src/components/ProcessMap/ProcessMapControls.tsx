import React from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  ArrowDownUp,
  ArrowRightLeft,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  Expand,
  Shrink,
} from 'lucide-react';

type Algorithm = 'dfg' | 'alpha' | 'heuristic' | 'inductive';
type LayoutDir = 'TB' | 'LR';
type ColorMode = 'frequency' | 'duration' | 'performance';

interface ProcessMapControlsProps {
  algorithm: Algorithm;
  onAlgorithmChange: (algorithm: Algorithm) => void;
  layoutDirection: LayoutDir;
  onLayoutDirectionChange: (dir: LayoutDir) => void;
  colorBy: ColorMode;
  onColorByChange: (mode: ColorMode) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onExportPNG: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

const algorithmOptions: { value: Algorithm; label: string }[] = [
  { value: 'dfg', label: 'DFG' },
  { value: 'alpha', label: 'Alpha Miner' },
  { value: 'heuristic', label: 'Heuristic Miner' },
  { value: 'inductive', label: 'Inductive Miner' },
];

const colorOptions: { value: ColorMode; label: string }[] = [
  { value: 'frequency', label: 'Frequency' },
  { value: 'duration', label: 'Duration' },
  { value: 'performance', label: 'Performance' },
];

const ProcessMapControls: React.FC<ProcessMapControlsProps> = ({
  algorithm,
  onAlgorithmChange,
  layoutDirection,
  onLayoutDirectionChange,
  colorBy,
  onColorByChange,
  onZoomIn,
  onZoomOut,
  onFit,
  onExportPNG,
  isFullscreen,
  onToggleFullscreen,
}) => {
  return (
    <div className="flex items-center justify-between bg-surface-2 rounded-xl border border-line px-4 py-2.5">
      {/* Left group: Algorithm & Layout */}
      <div className="flex items-center gap-3">
        {/* Algorithm selector */}
        <div className="relative">
          <label className="block text-[10px] font-medium text-fg-faint uppercase tracking-wider mb-0.5">
            Algorithm
          </label>
          <div className="relative">
            <select
              value={algorithm}
              onChange={(e) => onAlgorithmChange(e.target.value as Algorithm)}
              className={clsx(
                'appearance-none bg-tint border border-line rounded-lg',
                'pl-3 pr-8 py-1.5 text-sm font-medium text-fg-secondary',
                'focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50',
                'cursor-pointer transition-colors hover:border-line-strong'
              )}
            >
              {algorithmOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
          </div>
        </div>

        {/* Divider */}
        <div className="w-px h-10 bg-tint" />

        {/* Layout direction toggle */}
        <div>
          <label className="block text-[10px] font-medium text-fg-faint uppercase tracking-wider mb-0.5">
            Layout
          </label>
          <div className="flex items-center bg-tint rounded-lg p-0.5">
            <button
              onClick={() => onLayoutDirectionChange('TB')}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                layoutDirection === 'TB'
                  ? 'bg-surface-2 text-accent'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              <ArrowDownUp className="w-3.5 h-3.5" />
              Top-Down
            </button>
            <button
              onClick={() => onLayoutDirectionChange('LR')}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                layoutDirection === 'LR'
                  ? 'bg-surface-2 text-accent'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              Left-Right
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="w-px h-10 bg-tint" />

        {/* Color by */}
        <div>
          <label className="block text-[10px] font-medium text-fg-faint uppercase tracking-wider mb-0.5">
            Color By
          </label>
          <div className="relative">
            <select
              value={colorBy}
              onChange={(e) => onColorByChange(e.target.value as ColorMode)}
              className={clsx(
                'appearance-none bg-tint border border-line rounded-lg',
                'pl-3 pr-8 py-1.5 text-sm font-medium text-fg-secondary',
                'focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50',
                'cursor-pointer transition-colors hover:border-line-strong'
              )}
            >
              {colorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Right group: Zoom & Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={onZoomIn}
          className="p-2 rounded-lg hover:bg-tint text-fg-muted hover:text-fg-secondary transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={onZoomOut}
          className="p-2 rounded-lg hover:bg-tint text-fg-muted hover:text-fg-secondary transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={onFit}
          className="p-2 rounded-lg hover:bg-tint text-fg-muted hover:text-fg-secondary transition-colors"
          title="Fit to Screen"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <div className="w-px h-6 bg-tint mx-1" />

        <button
          onClick={onExportPNG}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-fg-muted hover:bg-tint hover:text-fg-secondary transition-colors"
          title="Export as PNG"
        >
          <Download className="w-3.5 h-3.5" />
          Export
        </button>
        <button
          onClick={onToggleFullscreen}
          className="p-2 rounded-lg hover:bg-tint text-fg-muted hover:text-fg-secondary transition-colors"
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <Shrink className="w-4 h-4" />
          ) : (
            <Expand className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
};

export default ProcessMapControls;
