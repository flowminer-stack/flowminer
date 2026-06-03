import { useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import type { SimulationModification } from '@/types';

// ─── Modification Card ────────────────────────────────────────────────────────

type ModType = SimulationModification['type'];

const MOD_LABELS: Record<ModType, string> = {
  duration_scale: 'Scale Duration',
  remove_activity: 'Remove Activity',
  adjust_frequency: 'Adjust Frequency',
};

interface ModCardProps {
  mod: SimulationModification;
  activities: string[];
  onChange: (mod: SimulationModification) => void;
  onDelete: () => void;
}

export default function ModificationCard({ mod, activities, onChange, onDelete }: ModCardProps) {
  const [typeOpen, setTypeOpen] = useState(false);
  const [actOpen, setActOpen] = useState(false);

  const modTypes: ModType[] = ['duration_scale', 'remove_activity', 'adjust_frequency'];

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          Modification
        </span>
        <button
          onClick={onDelete}
          className="rounded p-0.5 text-fg-faint transition-colors hover:bg-tint hover:text-fg-muted"
        >
          <X size={13} />
        </button>
      </div>

      {/* Type dropdown */}
      <div className="mb-2 relative">
        <label className="mb-1 block text-[10px] font-medium text-fg-muted">Type</label>
        <button
          type="button"
          onClick={() => setTypeOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded border border-line bg-surface-1 px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:border-accent/50"
        >
          {MOD_LABELS[mod.type]}
          <ChevronDown size={11} className={clsx('shrink-0 text-fg-faint transition-transform', typeOpen && 'rotate-180')} />
        </button>
        {typeOpen && (
          <div className="absolute left-0 top-full z-50 mt-0.5 w-full animate-fade-in rounded border border-line bg-surface-2 py-0.5 shadow-xl">
            {modTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onChange({ ...mod, type: t, value: t === 'remove_activity' ? 0 : t === 'duration_scale' ? 1.0 : 100 });
                  setTypeOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center px-3 py-1.5 text-[12px] hover:bg-tint',
                  mod.type === t ? 'text-accent' : 'text-fg-secondary',
                )}
              >
                {MOD_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Activity dropdown */}
      <div className="mb-2.5 relative">
        <label className="mb-1 block text-[10px] font-medium text-fg-muted">Activity</label>
        <button
          type="button"
          onClick={() => setActOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded border border-line bg-surface-1 px-2.5 py-1.5 text-left text-[12px] text-fg-secondary hover:border-accent/50"
        >
          <span className={clsx('truncate', !mod.activity && 'text-fg-faint')}>
            {mod.activity || 'Select activity…'}
          </span>
          <ChevronDown size={11} className={clsx('ml-2 shrink-0 text-fg-faint transition-transform', actOpen && 'rotate-180')} />
        </button>
        {actOpen && (
          <div className="absolute left-0 top-full z-50 mt-0.5 max-h-44 w-full animate-fade-in overflow-y-auto rounded border border-line bg-surface-2 py-0.5 shadow-xl">
            {activities.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-fg-faint">No activities available</p>
            ) : (
              activities.map((act) => (
                <button
                  key={act}
                  type="button"
                  onClick={() => { onChange({ ...mod, activity: act }); setActOpen(false); }}
                  className={clsx(
                    'flex w-full items-center px-3 py-1.5 text-[12px] hover:bg-tint',
                    mod.activity === act ? 'text-accent' : 'text-fg-secondary',
                  )}
                >
                  <span className="truncate">{act}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Value input */}
      {mod.type !== 'remove_activity' && (
        <div>
          <label className="mb-1 block text-[10px] font-medium text-fg-muted">
            {mod.type === 'duration_scale'
              ? `Scale factor: ${mod.value.toFixed(2)}x`
              : `Frequency: ${mod.value}%`}
          </label>
          <input
            type="range"
            min={mod.type === 'duration_scale' ? 0.1 : 0}
            max={mod.type === 'duration_scale' ? 3.0 : 100}
            step={mod.type === 'duration_scale' ? 0.05 : 1}
            value={mod.value}
            onChange={(e) => onChange({ ...mod, value: parseFloat(e.target.value) })}
            className="w-full accent-accent"
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-fg-faint">
            <span>{mod.type === 'duration_scale' ? '0.1x' : '0%'}</span>
            <span>{mod.type === 'duration_scale' ? '3.0x' : '100%'}</span>
          </div>
        </div>
      )}

      {mod.type === 'remove_activity' && (
        <div className="rounded-md bg-danger/10 px-2.5 py-1.5">
          <p className="text-[11px] text-danger">This activity will be removed from simulated traces.</p>
        </div>
      )}
    </div>
  );
}
