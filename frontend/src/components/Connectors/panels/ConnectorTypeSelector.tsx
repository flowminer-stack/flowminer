import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Database, FileText, Github, Globe, Search, Server } from 'lucide-react';
import { types, ConnectorType, CONNECTOR_GROUPS, type CategoryKey } from './types';
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

interface PickerItem {
  value: ConnectorType;
  label: string;
  icon: ReactNode;
  description: string;
  category: CategoryKey;
}

export function ConnectorTypeSelector({
  value,
  onChange,
  registry,
}: ConnectorTypeSelectorProps) {
  const [query, setQuery] = useState('');

  const items: PickerItem[] = useMemo(() => {
    const staticById = new Map(types.map((t) => [t.value, t]));
    if (registry && registry.length > 0) {
      return registry.map((r) => {
        const staticEntry = staticById.get(r.id as ConnectorType);
        const category = (staticEntry?.category ??
          (r.category as CategoryKey)) as CategoryKey;
        return {
          value: r.id as ConnectorType,
          label: staticEntry?.label ?? r.label,
          icon:
            staticEntry?.icon ??
            CATEGORY_ICON[r.category] ?? <Globe className="w-5 h-5" />,
          description: staticEntry?.description ?? r.label,
          category,
        };
      });
    }
    return types;
  }, [registry]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Groups in canonical order, plus a catch-all for any unknown category.
  const grouped = useMemo(() => {
    const known = new Set(CONNECTOR_GROUPS.map((g) => g.key));
    const out: { key: string; label: string; items: PickerItem[] }[] = [];
    for (const g of CONNECTOR_GROUPS) {
      const groupItems = filtered.filter((it) => it.category === g.key);
      if (groupItems.length) out.push({ ...g, items: groupItems });
    }
    const other = filtered.filter((it) => !known.has(it.category));
    if (other.length) out.push({ key: 'other', label: 'Other', items: other });
    return out;
  }, [filtered]);

  return (
    <div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sources — Postgres, Salesforce, Jira…"
          className="input w-full pl-9"
        />
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line py-10 text-center text-[12px] text-fg-muted">
          No sources match “{query}”.
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <div key={group.key}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                {group.label}
              </h4>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((ct) => (
                  <button
                    key={ct.value}
                    type="button"
                    onClick={() => onChange(ct.value)}
                    className={clsx(
                      'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
                      value === ct.value
                        ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
                        : 'border-line bg-surface-2 hover:border-line-strong',
                    )}
                  >
                    <div
                      className={clsx(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                        value === ct.value
                          ? 'bg-accent/15 text-accent'
                          : 'bg-tint text-fg-muted',
                      )}
                    >
                      {ct.icon}
                    </div>
                    <div className="min-w-0">
                      <div
                        className={clsx(
                          'truncate text-[13px] font-semibold',
                          value === ct.value ? 'text-accent' : 'text-fg',
                        )}
                      >
                        {ct.label}
                      </div>
                      <div className="truncate text-[11px] text-fg-muted">
                        {ct.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
