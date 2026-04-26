import React from 'react';
import clsx from 'clsx';
import { Layers, GitBranch } from 'lucide-react';

interface ComplexitySliderProps {
  value: number;
  onChange: (value: number) => void;
  totalEdges: number;
  visibleEdges: number;
}

const ComplexitySlider: React.FC<ComplexitySliderProps> = ({
  value,
  onChange,
  totalEdges,
  visibleEdges,
}) => {
  return (
    <div className="bg-surface-2 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
            <Layers className="w-4 h-4 text-accent" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-fg">Process Complexity</h3>
            <p className="text-[12px] text-fg-muted">
              Showing {visibleEdges} of {totalEdges} paths
            </p>
          </div>
        </div>
        <span className="text-sm font-mono font-semibold text-accent bg-accent/10 px-2 py-0.5 rounded-md">
          {value}%
        </span>
      </div>

      <div className="relative">
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={clsx(
            'w-full h-2 rounded-full appearance-none cursor-pointer',
            'bg-tint',
            '[&::-webkit-slider-thumb]:appearance-none',
            '[&::-webkit-slider-thumb]:w-5',
            '[&::-webkit-slider-thumb]:h-5',
            '[&::-webkit-slider-thumb]:rounded-full',
            '[&::-webkit-slider-thumb]:bg-accent',
            '[&::-webkit-slider-thumb]:border-2',
            '[&::-webkit-slider-thumb]:border-surface-0',
            '[&::-webkit-slider-thumb]:cursor-pointer',
            '[&::-webkit-slider-thumb]:transition-transform',
            '[&::-webkit-slider-thumb]:hover:scale-110',
            '[&::-moz-range-thumb]:w-5',
            '[&::-moz-range-thumb]:h-5',
            '[&::-moz-range-thumb]:rounded-full',
            '[&::-moz-range-thumb]:bg-accent',
            '[&::-moz-range-thumb]:border-2',
            '[&::-moz-range-thumb]:border-surface-0',
            '[&::-moz-range-thumb]:cursor-pointer'
          )}
        />
        {/* Track fill */}
        <div
          className="absolute top-0 left-0 h-2 rounded-full bg-accent/60 pointer-events-none"
          style={{ width: `${value}%` }}
        />
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1 text-[12px] text-fg-faint">
          <GitBranch className="w-3 h-3" />
          <span>Simple</span>
        </div>
        <div className="flex items-center gap-1 text-[12px] text-fg-faint">
          <span>Detailed</span>
          <GitBranch className="w-3 h-3" />
        </div>
      </div>
    </div>
  );
};

export default ComplexitySlider;
