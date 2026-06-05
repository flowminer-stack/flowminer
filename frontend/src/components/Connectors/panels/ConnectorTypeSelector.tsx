import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Database, FileText, Github, Globe, Server } from 'lucide-react';
import { types, ConnectorType } from './types';
import type { ConnectorRegistryEntry } from '@/types';

interface ConnectorTypeSelectorProps {
  value: ConnectorType;
  onChange: (type: ConnectorType) => void;
  // Backend registry (GET /connectors/registry). When present it drives the
  // list, so a connector added on the backend appears here with no frontend
  // edit. Falls back to the static `types` table when not yet loaded.
  registry?: ConnectorRegistryEntry[];
}

// Icon by category — used for connectors that aren't in the static `types`
// table (a static entry's bespoke icon still wins when the id matches).
const CATEGORY_ICON: Record<string, ReactNode> = {
  db: <Database className="w-5 h-5" />,
  warehouse: <Database className="w-5 h-5" />,
  file: <FileText className="w-5 h-5" />,
  api: <Globe className="w-5 h-5" />,
  devops: <Github className="w-5 h-5" />,
  erp: <Server className="w-5 h-5" />,
};

export function ConnectorTypeSelector({
  value,
  onChange,
  registry,
}: ConnectorTypeSelectorProps) {
  const staticById = new Map(types.map((t) => [t.value, t]));

  const items =
    registry && registry.length > 0
      ? registry.map((r) => {
          const staticEntry = staticById.get(r.id as ConnectorType);
          return {
            value: r.id as ConnectorType,
            label: staticEntry?.label ?? r.label,
            icon:
              staticEntry?.icon ??
              CATEGORY_ICON[r.category] ?? <Globe className="w-5 h-5" />,
          };
        })
      : types;

  return (
    <div>
      <label className="block text-[12px] font-medium text-fg-muted mb-3">
        Source Type
      </label>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-10">
        {items.map((ct) => (
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
