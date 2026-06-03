import clsx from 'clsx';
import { types, ConnectorType } from './types';

interface ConnectorTypeSelectorProps {
  value: ConnectorType;
  onChange: (type: ConnectorType) => void;
}

export function ConnectorTypeSelector({ value, onChange }: ConnectorTypeSelectorProps) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-fg-muted mb-3">
        Source Type
      </label>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-10">
        {types.map((ct) => (
          <button
            key={ct.value}
            onClick={() => onChange(ct.value)}
            className={clsx(
              'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all text-center',
              value === ct.value
                ? 'bg-accent/10 border-line-strong text-accent'
                : 'bg-surface-2 border-line text-fg-muted hover:border-line-strong hover:text-fg-secondary'
            )}
          >
            <div
              className={clsx(
                'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                value === ct.value ? 'bg-accent/15' : 'bg-tint'
              )}
            >
              {ct.icon}
            </div>
            <span className="text-[11px] font-medium leading-tight">{ct.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
